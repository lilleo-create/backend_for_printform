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
const otpRequestWindowMs = 15 * 60 * 1000;
const otpMaxPerPhoneWindow = 3;
const purposeToDb = {
    buyer_register_phone: 'BUYER_REGISTER_PHONE',
    buyer_change_phone: 'BUYER_CHANGE_PHONE',
    buyer_sensitive_action: 'BUYER_SENSITIVE_ACTION',
    seller_connect_phone: 'SELLER_CONNECT_PHONE',
    seller_change_payout_details: 'SELLER_CHANGE_PAYOUT_DETAILS',
    seller_payout_settings_verify: 'SELLER_PAYOUT_SETTINGS_VERIFY',
    password_reset: 'PASSWORD_RESET'
};
const formatPurpose = (purpose) => {
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
exports.otpService = {
    normalizePhone: phone_1.normalizePhone,
    async requestOtp(payload) {
        const phone = (0, phone_1.normalizePhone)(payload.phone);
        const purpose = purposeToDb[payload.purpose];
        const now = new Date();
        const windowStart = new Date(now.getTime() - otpRequestWindowMs);
        const recentCount = await prisma_1.prisma.phoneOtp.count({
            where: {
                phone,
                purpose,
                createdAt: { gte: windowStart }
            }
        });
        if (recentCount >= otpMaxPerPhoneWindow) {
            return { ok: true, throttled: true };
        }
        const lastOtp = await prisma_1.prisma.phoneOtp.findFirst({
            where: { phone, purpose },
            orderBy: { createdAt: 'desc' }
        });
        if (lastOtp && now.getTime() - lastOtp.createdAt.getTime() < env_1.env.otpCooldownSeconds * 1000) {
            return { ok: true, throttled: true };
        }
        const code = (0, otp_1.generateOtpCode)();
        const expiresAt = new Date(now.getTime() + env_1.env.otpTtlMinutes * 60 * 1000);
        const created = await prisma_1.prisma.phoneOtp.create({
            data: {
                phone,
                purpose,
                codeHash: (0, otp_1.hashOtpCode)(code),
                expiresAt,
                maxAttempts: env_1.env.otpMaxAttempts,
                ip: payload.ip,
                userAgent: payload.userAgent,
                providerPayload: { source: 'backend', purpose: payload.purpose }
            }
        });
        const message = `Ваш код для ${formatPurpose(payload.purpose)}: ${code}`;
        const callbackUrl = `${env_1.env.backendUrl.replace(/\/$/, '')}/auth/otp/telegram/callback`;
        const internalRequestId = `otp_${created.id}_${Date.now()}`;
        const providerPayload = created.id;
        console.info('[OTP] provider env snapshot', {
            otpProvider: env_1.env.otpProvider,
            hasTelegramGatewayToken: Boolean(env_1.env.telegramGatewayToken),
            telegramGatewayBaseUrl: env_1.env.telegramGatewayBaseUrl
        });
        const delivery = await otpDeliveryService_1.otpDeliveryService.sendOtp({
            phone,
            code,
            ttlSeconds: env_1.env.otpTtlMinutes * 60,
            message,
            requestId: internalRequestId,
            callbackUrl,
            providerPayload
        });
        await prisma_1.prisma.phoneOtp.update({
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
            devOtp: env_1.env.isProduction ? undefined : code,
            delivery: {
                channel: delivery.channel,
                provider: delivery.provider,
                deliveryStatus: delivery.deliveryStatus,
                devMode: delivery.devMode ?? false
            }
        };
    },
    async verifyOtp(payload) {
        const phone = (0, phone_1.normalizePhone)(payload.phone);
        const purpose = purposeToDb[payload.purpose];
        const now = new Date();
        const otp = await prisma_1.prisma.phoneOtp.findFirst({
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
        const hashed = (0, otp_1.hashOtpCode)(payload.code);
        if (hashed !== otp.codeHash) {
            await prisma_1.prisma.phoneOtp.update({
                where: { id: otp.id },
                data: { attempts: { increment: 1 } }
            });
            console.info('[OTP] verify_failed', { phone, purpose: payload.purpose });
            throw new Error('OTP_INVALID');
        }
        await prisma_1.prisma.phoneOtp.update({
            where: { id: otp.id },
            data: { consumedAt: now }
        });
        console.info('[OTP] verified', { phone, purpose: payload.purpose });
        return { phone };
    },
    async updateDeliveryStatus(payload) {
        const otpIdFromPayload = typeof payload.providerPayload === 'string' ? payload.providerPayload.trim() : null;
        const otp = payload.providerRequestId
            ? await prisma_1.prisma.phoneOtp.findFirst({ where: { providerRequestId: payload.providerRequestId } })
            : otpIdFromPayload
                ? await prisma_1.prisma.phoneOtp.findUnique({ where: { id: otpIdFromPayload } })
                : null;
        if (!otp) {
            return null;
        }
        return prisma_1.prisma.phoneOtp.update({
            where: { id: otp.id },
            data: {
                deliveryStatus: payload.deliveryStatus,
                providerRequestId: payload.providerRequestId ?? otp.providerRequestId,
                providerPayload: payload.providerPayload ?? undefined
            }
        });
    },
    mapIncomingDeliveryStatus(status) {
        const normalized = status.toLowerCase();
        if (normalized === 'delivered')
            return 'DELIVERED';
        if (normalized === 'read')
            return 'READ';
        if (normalized === 'expired')
            return 'EXPIRED';
        if (normalized === 'revoked')
            return 'REVOKED';
        if (normalized === 'sent')
            return 'SENT';
        return null;
    },
    validateTelegramCallbackSignature(payload) {
        const secret = env_1.env.telegramGatewayCallbackSecret ||
            crypto_1.default.createHash('sha256').update(env_1.env.telegramGatewayToken).digest('hex');
        const computed = crypto_1.default
            .createHmac('sha256', secret)
            .update(`${payload.timestamp}\n${payload.rawBody}`)
            .digest('hex');
        if (computed.length !== payload.signature.length) {
            return false;
        }
        return crypto_1.default.timingSafeEqual(Buffer.from(computed), Buffer.from(payload.signature));
    }
};
