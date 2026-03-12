import crypto from 'crypto';
import { OtpDeliveryStatus, OtpPurpose as PrismaOtpPurpose } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { generateOtpCode, hashOtpCode } from '../utils/otp';
import { normalizePhone } from '../utils/phone';
import { otpDeliveryService } from './otpDeliveryService';

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

const purposeToDb: Record<OtpPurpose, PrismaOtpPurpose> = {
  buyer_register_phone: 'BUYER_REGISTER_PHONE',
  buyer_change_phone: 'BUYER_CHANGE_PHONE',
  buyer_sensitive_action: 'BUYER_SENSITIVE_ACTION',
  seller_connect_phone: 'SELLER_CONNECT_PHONE',
  seller_change_payout_details: 'SELLER_CHANGE_PAYOUT_DETAILS',
  seller_payout_settings_verify: 'SELLER_PAYOUT_SETTINGS_VERIFY',
  password_reset: 'PASSWORD_RESET'
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

  async requestOtp(payload: { phone: string; purpose: OtpPurpose; ip?: string; userAgent?: string }) {
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
