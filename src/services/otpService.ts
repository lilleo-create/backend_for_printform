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
const otpMaxPerPhoneAcrossPurposes = 6;

export type OtpPurpose =
  | 'buyer_register_phone'
  | 'buyer_change_phone'
  | 'buyer_sensitive_action'
  | 'seller_connect_phone'
  | 'seller_change_payout_details'
  | 'seller_payout_settings_verify'
  | 'password_reset'
  | 'login_device'
  | 'oauth_phone_binding';

type OtpRequestStatus = 'pending' | 'verified' | 'expired' | 'failed' | 'cancelled';
export type OtpRequestErrorData = { code: 'OTP_NOT_CONFIGURED' | 'OTP_PROVIDER_AUTH_FAILED' | 'OTP_PROVIDER_TIMEOUT' | 'OTP_PROVIDER_UNAVAILABLE' | 'OTP_REQUEST_FAILED'; message: string; };
const providerUnavailableMessage = 'Не удалось получить номер для подтверждения. Попробуйте ещё раз позже';
export type OtpRequestResult = { ok: false; error: OtpRequestErrorData } | { ok: true; throttled: true; data?: undefined; devOtp?: undefined; delivery?: undefined } | { ok: true; data: { requestId: string; verificationType: 'call_to_auth'; callToAuthNumber: string | null; phone: string; provider: 'plusofon' }; throttled?: undefined; devOtp?: undefined; delivery?: undefined } | { ok: true; devOtp?: string; delivery: { channel: string; provider: string; deliveryStatus: string; devMode: boolean }; data?: undefined; throttled?: undefined };

const mapPlusofonRequestError = (error: unknown): OtpRequestErrorData => {
  if (error instanceof Error && error.message === 'PLUSOFON_NOT_CONFIGURED') return { code: 'OTP_NOT_CONFIGURED', message: 'OTP provider is not configured' };
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401 || status === 403) return { code: 'OTP_PROVIDER_AUTH_FAILED', message: 'Сервис подтверждения номера временно недоступен' };
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return { code: 'OTP_PROVIDER_TIMEOUT', message: providerUnavailableMessage };
    return { code: 'OTP_PROVIDER_UNAVAILABLE', message: providerUnavailableMessage };
  }
  return { code: 'OTP_REQUEST_FAILED', message: 'Ошибка при запуске подтверждения номера' };
};

const purposeToDb: Record<OtpPurpose, PrismaOtpPurpose> = {
  buyer_register_phone: 'BUYER_REGISTER_PHONE',
  buyer_change_phone: 'BUYER_CHANGE_PHONE',
  buyer_sensitive_action: 'BUYER_SENSITIVE_ACTION',
  seller_connect_phone: 'SELLER_CONNECT_PHONE',
  seller_change_payout_details: 'SELLER_CHANGE_PAYOUT_DETAILS',
  seller_payout_settings_verify: 'SELLER_PAYOUT_SETTINGS_VERIFY',
  password_reset: 'PASSWORD_RESET',
  login_device: 'LOGIN_DEVICE',
  oauth_phone_binding: 'OAUTH_PHONE_BINDING'
};
const toJsonSafe = (value: unknown): Prisma.InputJsonValue => { try { return value == null ? {} : JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; } catch { return { value: String(value) }; } };
const formatPurpose = (purpose: OtpPurpose) => ({ buyer_register_phone: 'подтверждения телефона при регистрации', buyer_change_phone: 'смены телефона', buyer_sensitive_action: 'подтверждения чувствительного действия', seller_connect_phone: 'подключения продавца', seller_change_payout_details: 'изменения реквизитов продавца', seller_payout_settings_verify: 'подтверждения настроек выплат', password_reset: 'сброса пароля', login_device: 'подтверждения нового устройства', oauth_phone_binding: 'привязки телефона через OAuth' }[purpose]);

const guardOtpRequestRateLimits = async (db: Prisma.TransactionClient, phone: string, purpose: PrismaOtpPurpose) => {
  const now = new Date();
  const windowStart = new Date(now.getTime() - otpRequestWindowMs);
  const phoneCount = await db.phoneOtp.count({ where: { phone, createdAt: { gte: windowStart } } });
  if (phoneCount >= otpMaxPerPhoneAcrossPurposes) return { throttled: true as const, now };
  const recentCount = await db.phoneOtp.count({ where: { phone, purpose, createdAt: { gte: windowStart } } });
  if (recentCount >= otpMaxPerPhoneWindow) return { throttled: true as const, now };
  const lastOtp = await db.phoneOtp.findFirst({ where: { phone, purpose }, orderBy: { createdAt: 'desc' } });
  if (lastOtp && now.getTime() - lastOtp.createdAt.getTime() < env.otpCooldownSeconds * 1000) return { throttled: true as const, now };
  return { throttled: false as const, now };
};

const reserveOtpAttempt = (phone: string, purpose: PrismaOtpPurpose, data: Prisma.PhoneOtpCreateInput) =>
  prisma.$transaction(async (tx) => {
    // Serialize requests for the same normalized phone across processes before
    // counting and reserving a row. The provider call happens after commit.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${phone}))`;
    const limit = await guardOtpRequestRateLimits(tx, phone, purpose);
    if (limit.throttled) return null;
    return tx.phoneOtp.create({ data: { ...data, createdAt: limit.now } });
  });

const requestPlusofonOtp = async (payload: { phone: string; purpose: OtpPurpose; ip?: string; userAgent?: string }): Promise<OtpRequestResult> => {
  const phone = normalizePhone(payload.phone);
  const purpose = purposeToDb[payload.purpose];
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.plusofonVerificationExpiresSec * 1000);
  const reserved = await reserveOtpAttempt(phone, purpose, { phone, purpose, codeHash: hashOtpCode(crypto.randomUUID()), channel: 'PHONE_CALL', provider: 'PLUSOFON', providerPayload: { source: 'plusofon', purpose: payload.purpose }, deliveryStatus: 'SENT', maxAttempts: env.otpMaxAttempts, ip: payload.ip, userAgent: payload.userAgent, expiresAt });
  if (!reserved) return { ok: true, throttled: true };
  let requested;
  try { requested = await plusofonService.requestCallToAuth(phone); } catch (error) { await prisma.phoneOtp.update({ where: { id: reserved.id }, data: { deliveryStatus: 'REVOKED' } }); return { ok: false, error: mapPlusofonRequestError(error) }; }
  await prisma.phoneOtp.update({ where: { id: reserved.id }, data: { codeHash: hashOtpCode(`plusofon:${requested.requestId}:${phone}:${now.toISOString()}`), providerRequestId: requested.requestId, providerPayload: { source: 'plusofon', purpose: payload.purpose, verificationType: requested.verificationType, callToAuthNumber: requested.callToAuthNumber, raw: toJsonSafe(requested.raw) } } });
  return { ok: true, data: { requestId: requested.requestId, verificationType: requested.verificationType, callToAuthNumber: requested.callToAuthNumber, phone: requested.phone, provider: 'plusofon' } };
};

export const otpService = {
  normalizePhone,
  async requestCallOtp(payload: { phone: string; purpose: Extract<OtpPurpose, 'password_reset' | 'login_device'>; ip?: string; userAgent?: string }) {
    return requestPlusofonOtp(payload);
  },
  mapPlusofonStatus(statusRaw: string | null | undefined): OtpRequestStatus { const normalized = (statusRaw ?? '').toLowerCase(); if (['success', 'verified', 'confirmed'].includes(normalized)) return 'verified'; if (normalized === 'expired') return 'expired'; if (normalized === 'failed') return 'failed'; if (normalized in {'cancelled':1,'canceled':1}) return 'cancelled'; return 'pending'; },
  async markOtpVerifiedByProviderRequestId(payload: { requestId: string; status?: OtpRequestStatus; providerPayload?: unknown; }) { const now = new Date(); const otp = await prisma.phoneOtp.findFirst({ where: { providerRequestId: payload.requestId, provider: 'PLUSOFON', consumedAt: null, expiresAt: { gt: now }, deliveryStatus: 'SENT' }, orderBy: { createdAt: 'desc' } }); if (!otp) return null; const status = payload.status ?? 'verified'; if (status !== 'verified') return null; const existingPayload = otp.providerPayload && typeof otp.providerPayload === 'object' && !Array.isArray(otp.providerPayload) ? otp.providerPayload as Record<string, unknown> : {}; return prisma.phoneOtp.update({ where: { id: otp.id }, data: { deliveryStatus: 'DELIVERED', consumedAt: now, providerPayload: { ...existingPayload, webhookReceivedAt: now.toISOString(), webhookKeyMatched: true } } }); },
  async getOtpStatusByRequestId(requestId: string) { const otp = await prisma.phoneOtp.findFirst({ where: { providerRequestId: requestId, provider: 'PLUSOFON' }, orderBy: { createdAt: 'desc' } }); if (!otp) throw new Error('OTP_INVALID'); if (otp.consumedAt) return { requestId, status: 'verified' as const, provider: 'plusofon' as const }; const now = new Date(); if (otp.expiresAt <= now) return { requestId, status: 'expired' as const, provider: 'plusofon' as const }; if (otp.deliveryStatus === 'REVOKED') return { requestId, status: 'cancelled' as const, provider: 'plusofon' as const }; if (otp.deliveryStatus === 'EXPIRED') return { requestId, status: 'expired' as const, provider: 'plusofon' as const }; return { requestId, status: 'pending' as const, provider: 'plusofon' as const }; },
  async requestOtp(payload: { phone: string; purpose: OtpPurpose; ip?: string; userAgent?: string }): Promise<OtpRequestResult> {
    const phone = normalizePhone(payload.phone); const purpose = purposeToDb[payload.purpose];
    if (payload.purpose === 'password_reset' || payload.purpose === 'login_device') return requestPlusofonOtp({ ...payload, phone });
    if (env.otpProvider === 'plusofon') return requestPlusofonOtp({ ...payload, phone });
    const code = generateOtpCode(); const expiresAt = new Date(Date.now() + env.otpTtlMinutes * 60 * 1000); const created = await reserveOtpAttempt(phone, purpose, { phone, purpose, codeHash: hashOtpCode(code), expiresAt, maxAttempts: env.otpMaxAttempts, ip: payload.ip, userAgent: payload.userAgent, providerPayload: { source: 'backend', purpose: payload.purpose } });
    if (!created) return { ok: true, throttled: true };
    const message = `Ваш код для ${formatPurpose(payload.purpose)}: ${code}`; const callbackUrl = `${env.backendUrl.replace(/\/$/, '')}/auth/otp/telegram/callback`; const internalRequestId = `otp_${created.id}_${Date.now()}`; const providerPayload = created.id;
    const delivery = await otpDeliveryService.sendOtp({ phone, code, ttlSeconds: env.otpTtlMinutes * 60, message, requestId: internalRequestId, callbackUrl, providerPayload });
    await prisma.phoneOtp.update({ where: { id: created.id }, data: { channel: delivery.channel, provider: delivery.provider, providerRequestId: delivery.providerRequestId, providerPayload: delivery.providerPayload ?? undefined, deliveryStatus: delivery.deliveryStatus } });
    return { ok: true, devOtp: env.isProduction ? undefined : code, delivery: { channel: delivery.channel, provider: delivery.provider, deliveryStatus: delivery.deliveryStatus, devMode: delivery.devMode ?? false } };
  },
  async verifyOtp(payload: { phone: string; code: string; purpose: OtpPurpose }) { const phone = normalizePhone(payload.phone); const purpose = purposeToDb[payload.purpose]; const now = new Date(); const otp = await prisma.phoneOtp.findFirst({ where: { phone, purpose, consumedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } }); if (!otp) throw new Error('OTP_INVALID'); if (otp.attempts >= otp.maxAttempts) throw new Error('OTP_TOO_MANY'); const hashed = hashOtpCode(payload.code); if (hashed !== otp.codeHash) { await prisma.phoneOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } }); throw new Error('OTP_INVALID'); } await prisma.phoneOtp.update({ where: { id: otp.id }, data: { consumedAt: now } }); return { phone }; },
  async verifyOtpByRequestId(payload: { phone?: string; requestId: string; purpose: OtpPurpose }) { const normalizedIncomingPhone = payload.phone ? normalizePhone(payload.phone) : null; const purpose = purposeToDb[payload.purpose]; const now = new Date(); const otp = await prisma.phoneOtp.findFirst({ where: { purpose, provider: 'PLUSOFON', providerRequestId: payload.requestId }, orderBy: { createdAt: 'desc' } }); if (!otp) throw new Error('OTP_INVALID'); if (normalizedIncomingPhone && otp.phone !== normalizedIncomingPhone) { console.info('[OTP][VERIFY_BY_REQUEST_ID][PHONE_MISMATCH]', { requestId: payload.requestId, purpose: payload.purpose }); throw new Error('PHONE_MISMATCH'); } if (otp.expiresAt <= now) throw new Error('OTP_EXPIRED'); if (!otp.consumedAt) { const statusResult = await this.getOtpStatusByRequestId(payload.requestId); if (statusResult.status !== 'verified') throw new Error('OTP_INVALID'); await this.markOtpVerifiedByProviderRequestId({ requestId: payload.requestId, status: 'verified' }); } return { phone: otp.phone }; },
  async updateDeliveryStatus(payload: { providerRequestId?: string; providerPayload?: string; deliveryStatus: OtpDeliveryStatus; }) { const otpIdFromPayload = typeof payload.providerPayload === 'string' ? payload.providerPayload.trim() : null; const otp = payload.providerRequestId ? await prisma.phoneOtp.findFirst({ where: { providerRequestId: payload.providerRequestId } }) : otpIdFromPayload ? await prisma.phoneOtp.findUnique({ where: { id: otpIdFromPayload } }) : null; if (!otp) return null; return prisma.phoneOtp.update({ where: { id: otp.id }, data: { deliveryStatus: payload.deliveryStatus, providerRequestId: payload.providerRequestId ?? otp.providerRequestId, providerPayload: payload.providerPayload ?? undefined } }); },
  mapIncomingDeliveryStatus(status: string): OtpDeliveryStatus | null { const normalized = status.toLowerCase(); if (normalized === 'delivered') return 'DELIVERED'; if (normalized === 'read') return 'READ'; if (normalized === 'expired') return 'EXPIRED'; if (normalized === 'revoked') return 'REVOKED'; if (normalized === 'sent') return 'SENT'; return null; },
  validateTelegramCallbackSignature(payload: { timestamp: string; signature: string; rawBody: string; }) { const secret = env.telegramGatewayCallbackSecret || crypto.createHash('sha256').update(env.telegramGatewayToken).digest('hex'); const computed = crypto.createHmac('sha256', secret).update(`${payload.timestamp}\n${payload.rawBody}`).digest('hex'); if (computed.length !== payload.signature.length) return false; return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(payload.signature)); }
};
