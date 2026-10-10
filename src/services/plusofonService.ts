import axios from 'axios';
import { env } from '../config/env';

export type PlusofonRequestResult = {
  // Plusofon's documented correlation identifier for a reverse Flash Call.
  // It is intentionally exposed as the opaque requestId used by our API.
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
  Client: env.plusofonClientId,
  'Content-Type': 'application/json'
});

export const plusofonService = {
  isEnabled() {
    return Boolean(env.plusofonClientId && env.plusofonFlashAccessToken);
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

      // `key` is returned by call-to-auth and is repeated by the successful
      // callback. A transport request id cannot safely correlate a webhook.
      const requestId = pickFromRecord(candidate, ['key']);

      if (!requestId) {
        throw new Error('PLUSOFON_KEY_MISSING');
      }

      const callToAuthNumber =
        pickFromRecord(candidate, [
          'call_to_auth_number',
          'number',
          'phone_number',
          'phone',
          'caller_id',
          'redirect_number',
          'auth_number'
        ]) ?? null;

      return {
        requestId,
        verificationType: 'call_to_auth',
        callToAuthNumber,
        phone,
        raw
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('[PLUSOFON] requestCallToAuth failed', {
          status: error.response?.status
        });
      }
      throw error;
    }
  }
};
