import crypto from 'crypto';
import { env } from '../config/env';

export type TelegramDeliveryStatus = 'sent' | 'delivered' | 'read' | 'expired' | 'revoked';

export const mapTelegramDeliveryStatus = (status: string): TelegramDeliveryStatus | null => {
  const normalized = status.toLowerCase();
  if (normalized === 'sent') return 'sent';
  if (normalized === 'delivered') return 'delivered';
  if (normalized === 'read') return 'read';
  if (normalized === 'expired') return 'expired';
  if (normalized === 'revoked') return 'revoked';
  return null;
};

const request = async <T>(path: string, body: Record<string, unknown>) => {
  const url = `${env.telegramGatewayBaseUrl}${path}`;
  const requestBody = JSON.stringify(body);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.telegramGatewayToken}`,
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

  const parsed = text ? (JSON.parse(text) as T) : ({} as T);
  return parsed;
};

export const telegramGatewayService = {
  isEnabled() {
    return Boolean(env.telegramGatewayToken);
  },

  async checkSendAbility(phoneNumber: string) {
    type CheckSendAbilityResponse = {
      ok?: boolean;
      can_send?: boolean;
      reason?: string;
      request_id?: string;
      result?: { can_send?: boolean; reason?: string; request_id?: string };
    };
    const response = await request<CheckSendAbilityResponse>('/checkSendAbility', {
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

  async sendVerificationMessage(payload: {
    phoneNumber: string;
    code: string;
    requestId: string;
    ttlSeconds: number;
    callbackUrl?: string;
    providerPayload: string;
  }) {
    type SendResponse = {
      ok?: boolean;
      error?: string;
      request_id?: string;
      payload?: unknown;
      status?: string;
      result?: { ok?: boolean; error?: string; request_id?: string; payload?: unknown; status?: string };
    };
    const requestPayload: Record<string, unknown> = {
      phone_number: payload.phoneNumber,
      code: payload.code,
      request_id: payload.requestId,
      ttl: payload.ttlSeconds,
      payload: payload.providerPayload
    };

    if (payload.callbackUrl) {
      requestPayload.callback_url = payload.callbackUrl;
    }

    const response = await request<SendResponse>('/sendVerificationMessage', requestPayload);

    const result = response.result ?? {};
    const normalizedStatus = mapTelegramDeliveryStatus(result.status ?? response.status ?? '');
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

  async revokeVerificationMessage(requestId: string) {
    await request('/revokeVerificationMessage', { request_id: requestId });
  },

  validateCallbackSignature(payload: { timestamp: string; signature: string; rawBody: string }) {
    const secret =
      env.telegramGatewayCallbackSecret ||
      crypto.createHash('sha256').update(env.telegramGatewayToken).digest('hex');
    const computed = crypto
      .createHmac('sha256', secret)
      .update(`${payload.timestamp}\n${payload.rawBody}`)
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(payload.signature));
  }
};
