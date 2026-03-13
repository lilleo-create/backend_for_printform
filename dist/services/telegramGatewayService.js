"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.telegramGatewayService = exports.mapTelegramDeliveryStatus = void 0;
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../config/env");
const mapTelegramDeliveryStatus = (status) => {
    const normalized = status.toLowerCase();
    if (normalized === 'sent')
        return 'sent';
    if (normalized === 'delivered')
        return 'delivered';
    if (normalized === 'read')
        return 'read';
    if (normalized === 'expired')
        return 'expired';
    if (normalized === 'revoked')
        return 'revoked';
    return null;
};
exports.mapTelegramDeliveryStatus = mapTelegramDeliveryStatus;
const request = async (path, body) => {
    const url = `${env_1.env.telegramGatewayBaseUrl}${path}`;
    const requestBody = JSON.stringify(body);
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env_1.env.telegramGatewayToken}`,
            'Content-Type': 'application/json'
        },
        body: requestBody
    });
    const text = await response.text();
    if (!response.ok) {
        console.error('[OTP][TelegramGateway] API error', {
            path,
            status: response.status,
            requestBody: body,
            responseBody: text
        });
        throw new Error(`TELEGRAM_GATEWAY_ERROR:${response.status}:${text}`);
    }
    const parsed = text ? JSON.parse(text) : {};
    return parsed;
};
exports.telegramGatewayService = {
    isEnabled() {
        return Boolean(env_1.env.telegramGatewayToken);
    },
    async checkSendAbility(phoneNumber) {
        const response = await request('/checkSendAbility', {
            phone_number: phoneNumber
        });
        const result = response.result ?? {};
        return {
            canSend: result.can_send ?? response.can_send ?? response.ok ?? false,
            reason: result.reason ?? response.reason,
            requestId: result.request_id ?? response.request_id,
            raw: response
        };
    },
    async sendVerificationMessage(payload) {
        const requestPayload = {
            phone_number: payload.phoneNumber,
            code: payload.code,
            request_id: payload.requestId,
            ttl: payload.ttlSeconds,
            payload: payload.providerPayload
        };
        if (payload.callbackUrl) {
            requestPayload.callback_url = payload.callbackUrl;
        }
        const response = await request('/sendVerificationMessage', requestPayload);
        const result = response.result ?? {};
        const normalizedStatus = (0, exports.mapTelegramDeliveryStatus)(result.status ?? response.status ?? '');
        const error = result.error ?? response.error;
        const isOk = result.ok ?? response.ok ?? false;
        return {
            ok: isOk,
            error,
            providerRequestId: result.request_id ?? response.request_id ?? payload.requestId,
            providerPayload: result.payload ?? response.payload ?? payload.providerPayload,
            deliveryStatus: normalizedStatus,
            raw: response
        };
    },
    async revokeVerificationMessage(requestId) {
        await request('/revokeVerificationMessage', { request_id: requestId });
    },
    validateCallbackSignature(payload) {
        const secret = env_1.env.telegramGatewayCallbackSecret ||
            crypto_1.default.createHash('sha256').update(env_1.env.telegramGatewayToken).digest('hex');
        const computed = crypto_1.default
            .createHmac('sha256', secret)
            .update(`${payload.timestamp}\n${payload.rawBody}`)
            .digest('hex');
        return crypto_1.default.timingSafeEqual(Buffer.from(computed), Buffer.from(payload.signature));
    }
};
