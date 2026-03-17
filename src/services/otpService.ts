import crypto from 'crypto';
import { OtpDeliveryStatus, OtpPurpose as PrismaOtpPurpose, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { generateOtpCode, hashOtpCode } from '../utils/otp';
import { normalizePhone } from '../utils/phone';
import { otpDeliveryService } from './otpDeliveryService';
import { plusofonService } from './plusofonService';
import axios from 'axios';

const otpRequestWindowMs = 15 * 60 * 1000;
const otpMaxPerPhoneWindow = 3;

export type OtpPurpose =
  | 'buyer_register_phone'
  | 'buyer_change_phone'
  | 'buyer_sensitive_action'
  | 'seller_connect_phone'
  | 'seller_change_payout_details'
  | 'seller_payout_settings_verify'
  | 'password_reset';

type OtpRequestStatus = 'pending' | 'verified' | 'expired' | 'failed' | 'cancelled';

export type OtpRequestErrorData = {
  code:
    | 'OTP_PROVIDER_AUTH_FAILED'
    | 'OTP_PROVIDER_TIMEOUT'
    | 'OTP_PROVIDER_UNAVAILABLE'
    | 'OTP_REQUEST_FAILED';
  message: string;
};

const providerUnavailableMessage = 'Не удалось получить номер для подтверждения. Попробуйте ещё раз позже';

export type OtpRequestResult =
  | {
      ok: false;
      error: OtpRequestErrorData;
    }
  | {
      ok: true;
      throttled: true;
      data?: undefined;
      devOtp?: undefined;
      delivery?: undefined;
    }
  | {
      ok: true;
      data: {
        requestId: string;
        verificationType: 'call_to_auth';
        callToAuthNumber: string | null;
        phone: string;
        provider: 'plusofon';
      };
      throttled?: undefined;
      devOtp?: undefined;
      delivery?: undefined;
    }
  | {
      ok: true;
      devOtp?: string;
      delivery: {
        channel: string;
        provider: string;
        deliveryStatus: string;
        devMode: boolean;
      };
      data?: undefined;
      throttled?: undefined;
    };

const mapPlusofonRequestError = (error: unknown): OtpRequestErrorData => {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;

    if (status === 401 || status === 403) {
      return {
        code: 'OTP_PROVIDER_AUTH_FAILED',
        message: 'Сервис подтверждения номера временно недоступен'
      };
    }

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return {
        code: 'OTP_PROVIDER_TIMEOUT',
        message: providerUnavailableMessage
      };
    }

    return {
      code: 'OTP_PROVIDER_UNAVAILABLE',
      message: providerUnavailableMessage
    };
  }

  return {
    code: 'OTP_REQUEST_FAILED',
    message: 'Ошибка при запуске подтверждения номера'
  };
};

const purposeToDb: Record<OtpPurpose, PrismaOtpPurpose> = {
  buyer_register_phone: 'BUYER_REGISTER_PHONE',
  buyer_change_phone: 'BUYER_CHANGE_PHONE',
  buyer_sensitive_action: 'BUYER_SENSITIVE_ACTION',
  seller_connect_phone: 'SELLER_CONNECT_PHONE',
  seller_change_payout_details: 'SELLER_CHANGE_PAYOUT_DETAILS',
  seller_payout_settings_verify: 'SELLER_PAYOUT_SETTINGS_VERIFY',
  password_reset: 'PASSWORD_RESET'
};

const toJsonSafe = (value: unknown): Prisma.InputJsonValue => {
  if (value === null || value === undefined) {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return { value: String(value) };
  }
};

const formatPurpose = (purpose: OtpPurpose) => {
  switch (purpose) {
    case 'buyer_register_phone':
      return 'подтверждения телефона при регистрации';
    case 'buyer_change_phone':
      return 'смены телефона';
    case 'buyer_sensitive_action':
      return 'подтверждения чувствительного действия';
    case 'seller_connect_phone':
      return 'подключения продавца';
    case 'seller_change_payout_details':
      return 'изменения реквизитов продавца';
    case 'seller_payout_settings_verify':
      return 'подтверждения настроек выплат';
    default:
      return 'сброса пароля';
  }
};

export const otpService = {
  normalizePhone,

  mapPlusofonStatus(statusRaw: string | null | undefined): OtpRequestStatus {
    const normalized = (statusRaw ?? '').toLowerCase();
    if (['success', 'verified', 'confirmed'].includes(normalized)) return 'verified';
    if (normalized === 'expired') return 'expired';
    if (normalized === 'failed') return 'failed';
    if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
    return 'pending';
  },

  async markOtpVerifiedByProviderRequestId(payload: {
    requestId: string;
    status?: OtpRequestStatus;
    providerPayload?: unknown;
  }) {
    const otp = await prisma.phoneOtp.findFirst({
      where: {
        providerRequestId: payload.requestId,
        provider: 'PLUSOFON'
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!otp) {
      return null;
    }

    const status = payload.status ?? 'verified';
    const now = new Date();

    const deliveryStatus: OtpDeliveryStatus =
      status === 'expired' ? 'EXPIRED' : status === 'verified' ? 'DELIVERED' : 'REVOKED';

    return prisma.phoneOtp.update({
      where: { id: otp.id },
      data: {
        deliveryStatus,
        consumedAt: status === 'verified' ? otp.consumedAt ?? now : otp.consumedAt,
        providerPayload: payload.providerPayload ?? otp.providerPayload ?? undefined
      }
    });
  },

  async getOtpStatusByRequestId(requestId: string) {
    const otp = await prisma.phoneOtp.findFirst({
      where: { providerRequestId: requestId, provider: 'PLUSOFON' },
      orderBy: { createdAt: 'desc' }
    });

    if (!otp) {
      throw new Error('OTP_INVALID');
    }

    if (otp.consumedAt) {
      return { requestId, status: 'verified' as const, provider: 'plusofon' as const };
    }

    const now = new Date();
    if (otp.expiresAt <= now) {
      return { requestId, status: 'expired' as const, provider: 'plusofon' as const };
    }

    if (otp.deliveryStatus === 'REVOKED') {
      return { requestId, status: 'cancelled' as const, provider: 'plusofon' as const };
    }

    if (otp.deliveryStatus === 'EXPIRED') {
      return { requestId, status: 'expired' as const, provider: 'plusofon' as const };
    }

    if (plusofonService.isEnabled()) {
      try {
        // TECH_DEBT: для plusofon при call-to-auth используем polling как fallback,
        // основной источник истины должен оставаться webhook-поток провайдера.
        const providerStatus = await plusofonService.checkStatus(requestId);
        const mappedStatus = this.mapPlusofonStatus(providerStatus.status);
        if (mappedStatus !== 'pending') {
          await this.markOtpVerifiedByProviderRequestId({
            requestId,
            status: mappedStatus,
            providerPayload: toJsonSafe(providerStatus.raw)
          });
        }
        return { requestId, status: mappedStatus, provider: 'plusofon' as const };
      } catch (error) {
        console.warn('[OTP] plusofon status check failed', { requestId, error });
      }
    }

    return { requestId, status: 'pending' as const, provider: 'plusofon' as const };
  },

  async requestOtp(payload: { phone: string; purpose: OtpPurpose; ip?: string; userAgent?: string }): Promise<OtpRequestResult> {
    const phone = normalizePhone(payload.phone);
    const purpose = purposeToDb[payload.purpose];
    const now = new Date();
    const windowStart = new Date(now.getTime() - otpRequestWindowMs);

    const recentCount = await prisma.phoneOtp.count({
      where: {
        phone,
        purpose,
        createdAt: { gte: windowStart }
      }
    });

    if (recentCount >= otpMaxPerPhoneWindow) {
      return { ok: true, throttled: true };
    }

    const lastOtp = await prisma.phoneOtp.findFirst({
      where: { phone, purpose },
      orderBy: { createdAt: 'desc' }
    });

    if (lastOtp && now.getTime() - lastOtp.createdAt.getTime() < env.otpCooldownSeconds * 1000) {
      return { ok: true, throttled: true };
    }

    const isPlusofonCallToAuth = env.otpProvider === 'plusofon' && payload.purpose === 'buyer_register_phone';

    if (isPlusofonCallToAuth) {
      let requested;

      try {
        requested = await plusofonService.requestCallToAuth(phone);
      } catch (error) {
        const mappedError = mapPlusofonRequestError(error);
        console.error('[OTP] plusofon request failed', {
          phone,
          purpose: payload.purpose,
          mappedError,
          sourceError: error
        });

        return {
          ok: false,
          error: mappedError
        };
      }

      const expiresAt = new Date(now.getTime() + env.plusofonVerificationExpiresSec * 1000);

      await prisma.phoneOtp.create({
        data: {
          phone,
          purpose,
          codeHash: hashOtpCode(`plusofon:${requested.requestId}:${phone}:${now.toISOString()}`),
          channel: 'PHONE_CALL',
          provider: 'PLUSOFON',
          providerRequestId: requested.requestId,
          providerPayload: {
            source: 'plusofon',
            purpose: payload.purpose,
            verificationType: requested.verificationType,
            callToAuthNumber: requested.callToAuthNumber,
            raw: toJsonSafe(requested.raw)
          },
          deliveryStatus: 'SENT',
          maxAttempts: env.otpMaxAttempts,
          ip: payload.ip,
          userAgent: payload.userAgent,
          expiresAt
        }
      });

      return {
        ok: true,
        data: {
          requestId: requested.requestId,
          verificationType: requested.verificationType,
          callToAuthNumber: requested.callToAuthNumber,
          phone: requested.phone,
          provider: 'plusofon' as const
        }
      };
    }

    const code = generateOtpCode();
    const expiresAt = new Date(now.getTime() + env.otpTtlMinutes * 60 * 1000);
    const created = await prisma.phoneOtp.create({
      data: {
        phone,
        purpose,
        codeHash: hashOtpCode(code),
        expiresAt,
        maxAttempts: env.otpMaxAttempts,
        ip: payload.ip,
        userAgent: payload.userAgent,
        providerPayload: { source: 'backend', purpose: payload.purpose }
      }
    });

    const message = `Ваш код для ${formatPurpose(payload.purpose)}: ${code}`;
    const callbackUrl = `${env.backendUrl.replace(/\/$/, '')}/auth/otp/telegram/callback`;
    const internalRequestId = `otp_${created.id}_${Date.now()}`;
    const providerPayload = created.id;

    console.info('[OTP] provider env snapshot', {
      otpProvider: env.otpProvider,
      hasTelegramGatewayToken: Boolean(env.telegramGatewayToken),
      telegramGatewayBaseUrl: env.telegramGatewayBaseUrl
    });

    const delivery = await otpDeliveryService.sendOtp({
      phone,
      code,
      ttlSeconds: env.otpTtlMinutes * 60,
      message,
      requestId: internalRequestId,
      callbackUrl,
      providerPayload
    });

    await prisma.phoneOtp.update({
      where: { id: created.id },
      data: {
        channel: delivery.channel,
        provider: delivery.provider,
        providerRequestId: delivery.providerRequestId,
        providerPayload: delivery.providerPayload ?? undefined,
        deliveryStatus: delivery.deliveryStatus
      }
    });

    console.info('[OTP] request', {
      phone,
      purpose: payload.purpose,
      provider: delivery.provider,
      channel: delivery.channel,
      providerRequestId: delivery.providerRequestId
    });

    return {
      ok: true,
      devOtp: env.isProduction ? undefined : code,
      delivery: {
        channel: delivery.channel,
        provider: delivery.provider,
        deliveryStatus: delivery.deliveryStatus,
        devMode: delivery.devMode ?? false
      }
    };
  },

  async verifyOtp(payload: { phone: string; code: string; purpose: OtpPurpose }) {
    const phone = normalizePhone(payload.phone);
    const purpose = purposeToDb[payload.purpose];
    const now = new Date();
    const otp = await prisma.phoneOtp.findFirst({
      where: {
        phone,
        purpose,
        consumedAt: null,
        expiresAt: { gt: now }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!otp) {
      throw new Error('OTP_INVALID');
    }
    if (otp.attempts >= otp.maxAttempts) {
      throw new Error('OTP_TOO_MANY');
    }

    const hashed = hashOtpCode(payload.code);
    if (hashed !== otp.codeHash) {
      await prisma.phoneOtp.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } }
      });
      console.info('[OTP] verify_failed', { phone, purpose: payload.purpose });
      throw new Error('OTP_INVALID');
    }

    await prisma.phoneOtp.update({
      where: { id: otp.id },
      data: { consumedAt: now }
    });
    console.info('[OTP] verified', { phone, purpose: payload.purpose });

    return { phone };
  },

  async verifyOtpByRequestId(payload: { phone: string; requestId: string; purpose: OtpPurpose }) {
    const phone = normalizePhone(payload.phone);
    const purpose = purposeToDb[payload.purpose];
    const now = new Date();

    const otp = await prisma.phoneOtp.findFirst({
      where: {
        phone,
        purpose,
        provider: 'PLUSOFON',
        providerRequestId: payload.requestId
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!otp) {
      throw new Error('OTP_INVALID');
    }

    if (otp.expiresAt <= now) {
      throw new Error('OTP_EXPIRED');
    }

    if (!otp.consumedAt) {
      const statusResult = await this.getOtpStatusByRequestId(payload.requestId);
      if (statusResult.status !== 'verified') {
        throw new Error('OTP_INVALID');
      }

      await this.markOtpVerifiedByProviderRequestId({
        requestId: payload.requestId,
        status: 'verified'
      });
    }

    return { phone };
  },

  async updateDeliveryStatus(payload: {
    providerRequestId?: string;
    providerPayload?: string;
    deliveryStatus: OtpDeliveryStatus;
  }) {
    const otpIdFromPayload = typeof payload.providerPayload === 'string' ? payload.providerPayload.trim() : null;

    const otp = payload.providerRequestId
      ? await prisma.phoneOtp.findFirst({ where: { providerRequestId: payload.providerRequestId } })
      : otpIdFromPayload
      ? await prisma.phoneOtp.findUnique({ where: { id: otpIdFromPayload } })
      : null;

    if (!otp) {
      return null;
    }

    return prisma.phoneOtp.update({
      where: { id: otp.id },
      data: {
        deliveryStatus: payload.deliveryStatus,
        providerRequestId: payload.providerRequestId ?? otp.providerRequestId,
        providerPayload: payload.providerPayload ?? undefined
      }
    });
  },

  mapIncomingDeliveryStatus(status: string): OtpDeliveryStatus | null {
    const normalized = status.toLowerCase();
    if (normalized === 'delivered') return 'DELIVERED';
    if (normalized === 'read') return 'READ';
    if (normalized === 'expired') return 'EXPIRED';
    if (normalized === 'revoked') return 'REVOKED';
    if (normalized === 'sent') return 'SENT';
    return null;
  },

  validateTelegramCallbackSignature(payload: {
    timestamp: string;
    signature: string;
    rawBody: string;
  }) {
    const secret =
      env.telegramGatewayCallbackSecret ||
      crypto.createHash('sha256').update(env.telegramGatewayToken).digest('hex');
    const computed = crypto
      .createHmac('sha256', secret)
      .update(`${payload.timestamp}\n${payload.rawBody}`)
      .digest('hex');

    if (computed.length !== payload.signature.length) {
      return false;
    }

    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(payload.signature));
  }
};
