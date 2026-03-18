"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.plusofonService = void 0;
const axios_1 = __importDefault(require("axios"));
const env_1 = require("../config/env");
const pickString = (value) => {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    return normalized.length ? normalized : null;
};
const pickFromRecord = (source, keys) => {
    for (const key of keys) {
        const direct = pickString(source[key]);
        if (direct) {
            return direct;
        }
    }
    return null;
};
const asRecord = (value) => {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
};
const getCandidateRecord = (raw) => {
    const root = asRecord(raw);
    if (!root) {
        return {};
    }
    const nestedData = asRecord(root.data);
    if (nestedData) {
        return { ...root, ...nestedData };
    }
    return root;
};
const buildUrl = (endpoint) => {
    const base = env_1.env.plusofonBaseUrl.replace(/\/$/, '');
    const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${base}${path}`;
};
const requestHeaders = () => ({
    Authorization: `Bearer ${env_1.env.plusofonFlashAccessToken}`,
    Client: env_1.env.plusofonClientId,
    'Content-Type': 'application/json'
});
exports.plusofonService = {
    isEnabled() {
        return Boolean(env_1.env.plusofonFlashAccessToken);
    },
    async requestCallToAuth(phone) {
        if (!this.isEnabled()) {
            throw new Error('PLUSOFON_NOT_CONFIGURED');
        }
        const url = buildUrl(env_1.env.plusofonFlashCallEndpoint);
        const payload = {
            phone,
            hook_url: env_1.env.plusofonWebhookPublicUrl || undefined
        };
        try {
            const response = await axios_1.default.post(url, payload, {
                headers: requestHeaders(),
                timeout: env_1.env.plusofonRequestTimeoutMs
            });
            const raw = response.data;
            console.log('[PLUSOFON RAW requestCallToAuth]', JSON.stringify(raw, null, 2));
            const candidate = getCandidateRecord(raw);
            console.log('[PLUSOFON DEBUG requestCallToAuth]', {
                plusofonBaseUrl: env_1.env.plusofonBaseUrl,
                plusofonFlashCallEndpoint: env_1.env.plusofonFlashCallEndpoint,
                plusofonWebhookPublicUrl: env_1.env.plusofonWebhookPublicUrl,
                tokenConfigured: Boolean(env_1.env.plusofonFlashAccessToken),
                url,
                hasAuthorizationHeader: Boolean(requestHeaders().Authorization)
            });
            const requestId = pickFromRecord(candidate, ['request_id', 'requestId', 'id', 'key']) ??
                pickString(response.headers['x-request-id']);
            if (!requestId) {
                throw new Error('PLUSOFON_REQUEST_ID_MISSING');
            }
            const callToAuthNumber = pickFromRecord(candidate, [
                'call_to_auth_number',
                'number',
                'phone_number',
                'phone',
                'caller_id',
                'redirect_number',
                'auth_number'
            ]) ?? null;
            const resolvedPhone = pickFromRecord(candidate, ['phone', 'recipient', 'phone_number']) ?? phone;
            return {
                requestId,
                verificationType: 'call_to_auth',
                callToAuthNumber,
                phone: resolvedPhone,
                raw
            };
        }
        catch (error) {
            if (axios_1.default.isAxiosError(error)) {
                console.error('[PLUSOFON] requestCallToAuth failed', {
                    url,
                    payload,
                    status: error.response?.status,
                    responseData: error.response?.data,
                    responseHeaders: error.response?.headers
                });
            }
            throw error;
        }
    },
    async checkStatus(requestId) {
        if (!this.isEnabled()) {
            throw new Error('PLUSOFON_NOT_CONFIGURED');
        }
        const endpoint = env_1.env.plusofonFlashCallEndpoint.replace(/\/$/, '');
        const statusUrl = buildUrl(`${endpoint}/${encodeURIComponent(requestId)}`);
        const response = await axios_1.default.get(statusUrl, {
            headers: requestHeaders(),
            timeout: env_1.env.plusofonRequestTimeoutMs
        });
        const raw = response.data;
        console.log('[PLUSOFON RAW checkStatus]', JSON.stringify(raw, null, 2));
        const candidate = getCandidateRecord(raw);
        const status = pickFromRecord(candidate, ['status', 'state']) ?? 'pending';
        return {
            requestId: pickFromRecord(candidate, ['request_id', 'requestId', 'id', 'key']) ?? requestId,
            status,
            raw
        };
    }
};
