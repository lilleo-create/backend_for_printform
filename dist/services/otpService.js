"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.otpService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const prisma_1 = require("../lib/prisma");
const env_1 = require("../config/env");
const otp_1 = require("../utils/otp");
const phone_1 = require("../utils/phone");
const otpDeliveryService_1 = require("./otpDeliveryService");
const plusofonService_1 = require("./plusofonService");
const axios_1 = __importDefault(require("axios"));
const otpRequestWindowMs = 15 * 60 * 1000;
const otpMaxPerPhoneWindow = 3;
const providerUnavailableMessage = 'Не удалось получить номер для подтверждения. Попробуйте ещё раз позже';
const mapPlusofonRequestError = (error) => {
    if (axios_1.default.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401 || status === 403)
            return { code: 'OTP_PROVIDER_AUTH_FAILED', message: 'Сервис подтверждения номера временно недоступен' };
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')
            return { code: 'OTP_PROVIDER_TIMEOUT', message: providerUnavailableMessage };
        return { code: 'OTP_PROVIDER_UNAVAILABLE', message: providerUnavailableMessage };
    }
    return { code: 'OTP_REQUEST_FAILED', message: 'Ошибка при запуске подтверждения номера' };
};
const purposeToDb = {
    buyer_register_phone: 'BUYER_REGISTER_PHONE',
    buyer_change_phone: 'BUYER_CHANGE_PHONE',
    buyer_sensitive_action: 'BUYER_SENSITIVE_ACTION',
    seller_connect_phone: 'SELLER_CONNECT_PHONE',
    seller_change_payout_details: 'SELLER_CHANGE_PAYOUT_DETAILS',
    seller_payout_settings_verify: 'SELLER_PAYOUT_SETTINGS_VERIFY',
    password_reset: 'PASSWORD_RESET',
    login_device: 'LOGIN_DEVICE'
};
const toJsonSafe = (value) => { try {
    return value == null ? {} : JSON.parse(JSON.stringify(value));
}
catch {
    return { value: String(value) };
} };
const formatPurpose = (purpose) => ({ buyer_register_phone: 'подтверждения телефона при регистрации', buyer_change_phone: 'смены телефона', buyer_sensitive_action: 'подтверждения чувствительного действия', seller_connect_phone: 'подключения продавца', seller_change_payout_details: 'изменения реквизитов продавца', seller_payout_settings_verify: 'подтверждения настроек выплат', password_reset: 'сброса пароля', login_device: 'подтверждения нового устройства' }[purpose]);
const guardOtpRequestRateLimits = async (phone, purpose) => {
    const now = new Date();
    const windowStart = new Date(now.getTime() - otpRequestWindowMs);
    const recentCount = await prisma_1.prisma.phoneOtp.count({ where: { phone, purpose, createdAt: { gte: windowStart } } });
    if (recentCount >= otpMaxPerPhoneWindow)
        return { throttled: true, now };
    const lastOtp = await prisma_1.prisma.phoneOtp.findFirst({ where: { phone, purpose }, orderBy: { createdAt: 'desc' } });
    if (lastOtp && now.getTime() - lastOtp.createdAt.getTime() < env_1.env.otpCooldownSeconds * 1000)
        return { throttled: true, now };
    return { throttled: false, now };
};
const requestPlusofonOtp = async (payload) => {
    const phone = (0, phone_1.normalizePhone)(payload.phone);
    const purpose = purposeToDb[payload.purpose];
    const rateLimit = payload.skipRateLimit ? { throttled: false, now: new Date() } : await guardOtpRequestRateLimits(phone, purpose);
    if (rateLimit.throttled)
        return { ok: true, throttled: true };
    const now = rateLimit.now;
    let requested;
    try {
        requested = await plusofonService_1.plusofonService.requestCallToAuth(phone);
    }
    catch (error) {
        return { ok: false, error: mapPlusofonRequestError(error) };
    }
    const expiresAt = new Date(now.getTime() + env_1.env.plusofonVerificationExpiresSec * 1000);
    await prisma_1.prisma.phoneOtp.create({ data: { phone, purpose, codeHash: (0, otp_1.hashOtpCode)(`plusofon:${requested.requestId}:${phone}:${now.toISOString()}`), channel: 'PHONE_CALL', provider: 'PLUSOFON', providerRequestId: requested.requestId, providerPayload: { source: 'plusofon', purpose: payload.purpose, verificationType: requested.verificationType, callToAuthNumber: requested.callToAuthNumber, raw: toJsonSafe(requested.raw) }, deliveryStatus: 'SENT', maxAttempts: env_1.env.otpMaxAttempts, ip: payload.ip, userAgent: payload.userAgent, expiresAt } });
    return { ok: true, data: { requestId: requested.requestId, verificationType: requested.verificationType, callToAuthNumber: requested.callToAuthNumber, phone: requested.phone, provider: 'plusofon' } };
};
exports.otpService = {
    normalizePhone: phone_1.normalizePhone,
    async requestCallOtp(payload) {
        return requestPlusofonOtp(payload);
    },
    mapPlusofonStatus(statusRaw) { const normalized = (statusRaw ?? '').toLowerCase(); if (['success', 'verified', 'confirmed'].includes(normalized))
        return 'verified'; if (normalized === 'expired')
        return 'expired'; if (normalized === 'failed')
        return 'failed'; if (normalized in { 'cancelled': 1, 'canceled': 1 })
        return 'cancelled'; return 'pending'; },
    async markOtpVerifiedByProviderRequestId(payload) { const otp = await prisma_1.prisma.phoneOtp.findFirst({ where: { providerRequestId: payload.requestId, provider: 'PLUSOFON' }, orderBy: { createdAt: 'desc' } }); if (!otp)
        return null; const status = payload.status ?? 'verified'; const now = new Date(); const deliveryStatus = status === 'expired' ? 'EXPIRED' : status === 'verified' ? 'DELIVERED' : 'REVOKED'; return prisma_1.prisma.phoneOtp.update({ where: { id: otp.id }, data: { deliveryStatus, consumedAt: status === 'verified' ? otp.consumedAt ?? now : otp.consumedAt, providerPayload: payload.providerPayload ?? otp.providerPayload ?? undefined } }); },
    async getOtpStatusByRequestId(requestId) { const otp = await prisma_1.prisma.phoneOtp.findFirst({ where: { providerRequestId: requestId, provider: 'PLUSOFON' }, orderBy: { createdAt: 'desc' } }); if (!otp)
        throw new Error('OTP_INVALID'); if (otp.consumedAt)
        return { requestId, status: 'verified', provider: 'plusofon' }; const now = new Date(); if (otp.expiresAt <= now)
        return { requestId, status: 'expired', provider: 'plusofon' }; if (otp.deliveryStatus === 'REVOKED')
        return { requestId, status: 'cancelled', provider: 'plusofon' }; if (otp.deliveryStatus === 'EXPIRED')
        return { requestId, status: 'expired', provider: 'plusofon' }; return { requestId, status: 'pending', provider: 'plusofon' }; },
    async requestOtp(payload) {
        const phone = (0, phone_1.normalizePhone)(payload.phone);
        const purpose = purposeToDb[payload.purpose];
        const rateLimit = await guardOtpRequestRateLimits(phone, purpose);
        if (rateLimit.throttled)
            return { ok: true, throttled: true };
        if (payload.purpose === 'password_reset' || payload.purpose === 'login_device')
            return requestPlusofonOtp({ ...payload, phone, skipRateLimit: true });
        const isPlusofonCallToAuth = env_1.env.otpProvider === 'plusofon' && payload.purpose === 'buyer_register_phone';
        if (isPlusofonCallToAuth)
            return requestPlusofonOtp({ ...payload, phone, skipRateLimit: true });
        const now = rateLimit.now;
        const code = (0, otp_1.generateOtpCode)();
        const expiresAt = new Date(now.getTime() + env_1.env.otpTtlMinutes * 60 * 1000);
        const created = await prisma_1.prisma.phoneOtp.create({ data: { phone, purpose, codeHash: (0, otp_1.hashOtpCode)(code), expiresAt, maxAttempts: env_1.env.otpMaxAttempts, ip: payload.ip, userAgent: payload.userAgent, providerPayload: { source: 'backend', purpose: payload.purpose } } });
        const message = `Ваш код для ${formatPurpose(payload.purpose)}: ${code}`;
        const callbackUrl = `${env_1.env.backendUrl.replace(/\/$/, '')}/auth/otp/telegram/callback`;
        const internalRequestId = `otp_${created.id}_${Date.now()}`;
        const providerPayload = created.id;
        const delivery = await otpDeliveryService_1.otpDeliveryService.sendOtp({ phone, code, ttlSeconds: env_1.env.otpTtlMinutes * 60, message, requestId: internalRequestId, callbackUrl, providerPayload });
        await prisma_1.prisma.phoneOtp.update({ where: { id: created.id }, data: { channel: delivery.channel, provider: delivery.provider, providerRequestId: delivery.providerRequestId, providerPayload: delivery.providerPayload ?? undefined, deliveryStatus: delivery.deliveryStatus } });
        return { ok: true, devOtp: env_1.env.isProduction ? undefined : code, delivery: { channel: delivery.channel, provider: delivery.provider, deliveryStatus: delivery.deliveryStatus, devMode: delivery.devMode ?? false } };
    },
    async verifyOtp(payload) { const phone = (0, phone_1.normalizePhone)(payload.phone); const purpose = purposeToDb[payload.purpose]; const now = new Date(); const otp = await prisma_1.prisma.phoneOtp.findFirst({ where: { phone, purpose, consumedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } }); if (!otp)
        throw new Error('OTP_INVALID'); if (otp.attempts >= otp.maxAttempts)
        throw new Error('OTP_TOO_MANY'); const hashed = (0, otp_1.hashOtpCode)(payload.code); if (hashed !== otp.codeHash) {
        await prisma_1.prisma.phoneOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
        throw new Error('OTP_INVALID');
    } await prisma_1.prisma.phoneOtp.update({ where: { id: otp.id }, data: { consumedAt: now } }); return { phone }; },
    async verifyOtpByRequestId(payload) { const normalizedIncomingPhone = payload.phone ? (0, phone_1.normalizePhone)(payload.phone) : null; const purpose = purposeToDb[payload.purpose]; const now = new Date(); const otp = await prisma_1.prisma.phoneOtp.findFirst({ where: { purpose, provider: 'PLUSOFON', providerRequestId: payload.requestId }, orderBy: { createdAt: 'desc' } }); if (!otp)
        throw new Error('OTP_INVALID'); if (normalizedIncomingPhone && otp.phone !== normalizedIncomingPhone) {
        console.info('[OTP][VERIFY_BY_REQUEST_ID][PHONE_MISMATCH]', { requestId: payload.requestId, purpose: payload.purpose, storedChallengePhone: otp.phone, incomingPhoneRaw: payload.phone, incomingPhoneNormalized: normalizedIncomingPhone, callToAuthNumber: otp.providerPayload && typeof otp.providerPayload === 'object' && !Array.isArray(otp.providerPayload) && 'callToAuthNumber' in otp.providerPayload ? otp.providerPayload.callToAuthNumber : null });
        throw new Error('PHONE_MISMATCH');
    } if (otp.expiresAt <= now)
        throw new Error('OTP_EXPIRED'); if (!otp.consumedAt) {
        const statusResult = await this.getOtpStatusByRequestId(payload.requestId);
        if (statusResult.status !== 'verified')
            throw new Error('OTP_INVALID');
        await this.markOtpVerifiedByProviderRequestId({ requestId: payload.requestId, status: 'verified' });
    } return { phone: otp.phone }; },
    async updateDeliveryStatus(payload) { const otpIdFromPayload = typeof payload.providerPayload === 'string' ? payload.providerPayload.trim() : null; const otp = payload.providerRequestId ? await prisma_1.prisma.phoneOtp.findFirst({ where: { providerRequestId: payload.providerRequestId } }) : otpIdFromPayload ? await prisma_1.prisma.phoneOtp.findUnique({ where: { id: otpIdFromPayload } }) : null; if (!otp)
        return null; return prisma_1.prisma.phoneOtp.update({ where: { id: otp.id }, data: { deliveryStatus: payload.deliveryStatus, providerRequestId: payload.providerRequestId ?? otp.providerRequestId, providerPayload: payload.providerPayload ?? undefined } }); },
    mapIncomingDeliveryStatus(status) { const normalized = status.toLowerCase(); if (normalized === 'delivered')
        return 'DELIVERED'; if (normalized === 'read')
        return 'READ'; if (normalized === 'expired')
        return 'EXPIRED'; if (normalized === 'revoked')
        return 'REVOKED'; if (normalized === 'sent')
        return 'SENT'; return null; },
    validateTelegramCallbackSignature(payload) { const secret = env_1.env.telegramGatewayCallbackSecret || crypto_1.default.createHash('sha256').update(env_1.env.telegramGatewayToken).digest('hex'); const computed = crypto_1.default.createHmac('sha256', secret).update(`${payload.timestamp}\n${payload.rawBody}`).digest('hex'); if (computed.length !== payload.signature.length)
        return false; return crypto_1.default.timingSafeEqual(Buffer.from(computed), Buffer.from(payload.signature)); }
};
