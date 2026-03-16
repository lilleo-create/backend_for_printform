"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.otpDeliveryService = void 0;
const env_1 = require("../config/env");
const smsProvider_1 = require("./smsProvider");
const telegramGatewayService_1 = require("./telegramGatewayService");
const mapStatusToDb = (status) => {
    if (status === 'delivered')
        return 'DELIVERED';
    if (status === 'read')
        return 'READ';
    if (status === 'expired')
        return 'EXPIRED';
    if (status === 'revoked')
        return 'REVOKED';
    return 'SENT';
};
const isValidExternalHttpsCallbackUrl = (url) => {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') {
            return false;
        }
        const hostname = parsed.hostname.toLowerCase();
        return hostname !== 'localhost' && hostname !== '127.0.0.1';
    }
    catch {
        return false;
    }
};
const buildTelegramPayload = (otpId) => {
    const normalized = otpId.trim();
    if (!normalized) {
        console.error('[OTP] telegram payload invalid', {
            reason: 'EMPTY',
            payload: otpId,
            payloadLengthChars: otpId.length,
            payloadLengthBytes: Buffer.byteLength(otpId, 'utf8')
        });
        throw new Error('TELEGRAM_PAYLOAD_INVALID:EMPTY');
    }
    const payload = normalized;
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    if (payloadBytes > 128) {
        console.error('[OTP] telegram payload invalid', {
            reason: 'TOO_LONG',
            payload,
            payloadLengthChars: payload.length,
            payloadLengthBytes: payloadBytes
        });
        throw new Error('TELEGRAM_PAYLOAD_INVALID:TOO_LONG');
    }
    return { payload, payloadBytes };
};
exports.otpDeliveryService = {
    async sendOtp(payload) {
        console.info('[OTP] delivery config', {
            otpProvider: env_1.env.otpProvider,
            hasTelegramGatewayToken: Boolean(env_1.env.telegramGatewayToken),
            telegramGatewayBaseUrl: env_1.env.telegramGatewayBaseUrl,
            smsProvider: env_1.env.smsProvider
        });
        const callbackUrlEnabled = isValidExternalHttpsCallbackUrl(payload.callbackUrl);
        const callbackUrlForTelegram = callbackUrlEnabled ? payload.callbackUrl : undefined;
        if (!callbackUrlEnabled) {
            console.warn('[OTP] telegram callback_url disabled for local dev or invalid URL', {
                callbackUrl: payload.callbackUrl,
                callbackUrlIncludedInRequest: false
            });
        }
        else {
            console.info('[OTP] telegram callback_url enabled', {
                callbackUrl: payload.callbackUrl,
                callbackUrlIncludedInRequest: true
            });
        }
        if (env_1.env.otpProvider === 'telegram') {
            if (!telegramGatewayService_1.telegramGatewayService.isEnabled()) {
                console.warn('[OTP] telegram provider selected but TELEGRAM_GATEWAY_TOKEN is empty, using dev fallback');
            }
            else {
                try {
                    console.info('[OTP] telegram checkSendAbility:request', {
                        phone: payload.phone,
                        internalRequestId: payload.requestId
                    });
                    const ability = await telegramGatewayService_1.telegramGatewayService.checkSendAbility(payload.phone);
                    const telegramRequestId = ability.requestId;
                    console.info('[OTP] telegram checkSendAbility:response', {
                        phone: payload.phone,
                        internalRequestId: payload.requestId,
                        telegramRequestId,
                        response: ability
                    });
                    if (!ability.canSend) {
                        const reason = ability.reason ?? 'UNKNOWN_REASON';
                        const error = new Error(`TELEGRAM_CANNOT_SEND:${reason}`);
                        console.error('[OTP] telegram checkSendAbility rejected sending', {
                            phone: payload.phone,
                            internalRequestId: payload.requestId,
                            telegramRequestId,
                            reason
                        });
                        throw error;
                    }
                    if (!telegramRequestId) {
                        throw new Error('TELEGRAM_REQUEST_ID_MISSING');
                    }
                    const { payload: telegramPayload, payloadBytes } = buildTelegramPayload(payload.providerPayload);
                    console.info('[OTP] telegram sendVerificationMessage:request', {
                        phone: payload.phone,
                        internalRequestId: payload.requestId,
                        telegramRequestId,
                        request_id: telegramRequestId,
                        callbackUrl: callbackUrlForTelegram,
                        callbackUrlIncludedInRequest: Boolean(callbackUrlForTelegram),
                        ttlSeconds: payload.ttlSeconds,
                        payload: telegramPayload
                    });
                    console.debug('[OTP] telegram payload details', {
                        internalRequestId: payload.requestId,
                        telegramRequestId,
                        payload: telegramPayload,
                        payloadLengthChars: telegramPayload.length,
                        payloadLengthBytes: payloadBytes
                    });
                    const sent = await telegramGatewayService_1.telegramGatewayService.sendVerificationMessage({
                        phoneNumber: payload.phone,
                        code: payload.code,
                        requestId: telegramRequestId,
                        ttlSeconds: payload.ttlSeconds,
                        callbackUrl: callbackUrlForTelegram,
                        providerPayload: telegramPayload
                    });
                    console.info('[OTP] telegram sendVerificationMessage:response', {
                        phone: payload.phone,
                        internalRequestId: payload.requestId,
                        telegramRequestId,
                        callbackUrlIncludedInRequest: Boolean(callbackUrlForTelegram),
                        response: sent
                    });
                    if (!sent.ok) {
                        throw new Error(`TELEGRAM_SEND_FAILED:${sent.error ?? 'UNKNOWN_ERROR'}`);
                    }
                    if (!sent.deliveryStatus) {
                        throw new Error('TELEGRAM_SEND_FAILED:UNKNOWN_DELIVERY_STATUS');
                    }
                    return {
                        channel: 'TELEGRAM',
                        provider: 'TELEGRAM_GATEWAY',
                        deliveryStatus: mapStatusToDb(sent.deliveryStatus),
                        providerRequestId: sent.providerRequestId ?? telegramRequestId,
                        providerPayload: typeof sent.providerPayload === 'string' ? sent.providerPayload : payload.providerPayload
                    };
                }
                catch (error) {
                    console.error('[OTP] telegram delivery failed', {
                        phone: payload.phone,
                        internalRequestId: payload.requestId,
                        callbackUrlIncludedInRequest: Boolean(callbackUrlForTelegram),
                        error
                    });
                    if (error instanceof Error && error.message.startsWith('TELEGRAM_')) {
                        throw error;
                    }
                    throw new Error(`TELEGRAM_SEND_FAILED:${error instanceof Error ? error.message : 'UNKNOWN_ERROR'}`);
                }
            }
        }
        if (env_1.env.otpProvider === 'plusofon') {
            throw new Error('PLUSOFON_FLOW_REQUIRES_CALL_TO_AUTH');
        }
        if (env_1.env.smsProvider === 'twilio') {
            await smsProvider_1.smsProvider.sendOtp(payload.phone, payload.message);
            return {
                channel: 'SMS',
                provider: 'TWILIO',
                deliveryStatus: 'SENT'
            };
        }
        await smsProvider_1.smsProvider.sendOtp(payload.phone, payload.message);
        return {
            channel: 'CONSOLE',
            provider: 'CONSOLE',
            deliveryStatus: 'SENT',
            devMode: true
        };
    }
};
