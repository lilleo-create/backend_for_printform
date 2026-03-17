import axios from 'axios';
import { env } from '../config/env';

export type PlusofonRequestResult = {
  requestId: string;
  verificationType: 'call_to_auth';
  callToAuthNumber: string | null;
  phone: string;
  raw: unknown;
};

export type PlusofonStatusResult = {
  requestId: string;
  status: string;
  raw: unknown;
};

const pickString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length ? normalized : null;
};

const pickFromRecord = (source: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const direct = pickString(source[key]);
    if (direct) {
      return direct;
    }
  }

  return null;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};

const getCandidateRecord = (raw: unknown): Record<string, unknown> => {
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

const buildUrl = (endpoint: string) => {
  const base = env.plusofonBaseUrl.replace(/\/$/, '');
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${base}${path}`;
};

const requestHeaders = () => ({
  Authorization: `Bearer ${env.plusofonFlashAccessToken}`,
  'Content-Type': 'application/json'
});

export const plusofonService = {
  isEnabled() {
    return Boolean(env.plusofonFlashAccessToken);
  },

async requestCallToAuth(phone: string): Promise<PlusofonRequestResult> {
  if (!this.isEnabled()) {
    throw new Error('PLUSOFON_NOT_CONFIGURED');
  }

  const url = buildUrl(env.plusofonFlashCallEndpoint);
  const payload: Record<string, unknown> = {
    phone,
    hook_url: env.plusofonWebhookPublicUrl || undefined
  };

  try {
    const response = await axios.post(url, payload, {
      headers: requestHeaders(),
      timeout: env.plusofonRequestTimeoutMs
    });

    const raw = response.data as unknown;
    const candidate = getCandidateRecord(raw);
console.log('[PLUSOFON DEBUG requestCallToAuth]', {
  plusofonBaseUrl: env.plusofonBaseUrl,
  plusofonFlashCallEndpoint: env.plusofonFlashCallEndpoint,
  plusofonWebhookPublicUrl: env.plusofonWebhookPublicUrl,
  tokenConfigured: Boolean(env.plusofonFlashAccessToken),
  url,
  hasAuthorizationHeader: Boolean(requestHeaders().Authorization)
});
    const requestId =
      pickFromRecord(candidate, ['request_id', 'requestId', 'id', 'key']) ??
      pickString(response.headers['x-request-id']);

    if (!requestId) {
      throw new Error('PLUSOFON_REQUEST_ID_MISSING');
    }

    const callToAuthNumber =
      pickFromRecord(candidate, ['call_to_auth_number', 'number', 'phone_number']) ?? null;

    const resolvedPhone =
      pickFromRecord(candidate, ['phone', 'recipient', 'phone_number']) ?? phone;

    return {
      requestId,
      verificationType: 'call_to_auth',
      callToAuthNumber,
      phone: resolvedPhone,
      raw
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
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

  async checkStatus(requestId: string): Promise<PlusofonStatusResult> {
    if (!this.isEnabled()) {
      throw new Error('PLUSOFON_NOT_CONFIGURED');
    }

    const endpoint = env.plusofonFlashCallEndpoint.replace(/\/$/, '');
    const statusUrl = buildUrl(`${endpoint}/${encodeURIComponent(requestId)}`);
    const response = await axios.get(statusUrl, {
      headers: requestHeaders(),
      timeout: env.plusofonRequestTimeoutMs
    });

    const raw = response.data as unknown;
    const candidate = getCandidateRecord(raw);
    const status = pickFromRecord(candidate, ['status', 'state']) ?? 'pending';

    return {
      requestId:
        pickFromRecord(candidate, ['request_id', 'requestId', 'id', 'key']) ?? requestId,
      status,
      raw
    };
  }
};
