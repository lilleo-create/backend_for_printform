import { OtpChannel, OtpDeliveryStatus, OtpProvider } from '@prisma/client';
import { env } from '../config/env';
import { smsProvider } from './smsProvider';
import { telegramGatewayService } from './telegramGatewayService';

export type OtpDeliveryResult = {
  channel: OtpChannel;
  provider: OtpProvider;
  deliveryStatus: OtpDeliveryStatus;
  providerRequestId?: string;
  providerPayload?: string;
  devMode?: boolean;
};

const mapStatusToDb = (status: 'sent' | 'delivered' | 'read' | 'expired' | 'revoked'): OtpDeliveryStatus => {
  if (status === 'delivered') return 'DELIVERED';
  if (status === 'read') return 'READ';
  if (status === 'expired') return 'EXPIRED';
  if (status === 'revoked') return 'REVOKED';
  return 'SENT';
};

const isValidExternalHttpsCallbackUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    return hostname !== 'localhost' && hostname !== '127.0.0.1';
  } catch {
    return false;
  }
};


const buildTelegramPayload = (otpId: string) => {
  const normalized = otpId.trim();
  if (!normalized) {
    console.error('[OTP] telegram payload invalid', {
      reason: 'EMPTY',
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
      payloadLengthChars: payload.length,
      payloadLengthBytes: payloadBytes
    });
    throw new Error('TELEGRAM_PAYLOAD_INVALID:TOO_LONG');
  }

  return { payload, payloadBytes };
};

export const otpDeliveryService = {
  async sendOtp(payload: {
    phone: string;
    code: string;
    ttlSeconds: number;
    message: string;
    requestId: string;
    callbackUrl: string;
    providerPayload: string;
  }): Promise<OtpDeliveryResult> {
    console.info('[OTP] delivery config', {
      otpProvider: env.otpProvider,
      hasTelegramGatewayToken: Boolean(env.telegramGatewayToken),
      smsProvider: env.smsProvider
    });

    const callbackUrlEnabled = isValidExternalHttpsCallbackUrl(payload.callbackUrl);
    const callbackUrlForTelegram = callbackUrlEnabled ? payload.callbackUrl : undefined;

    if (!callbackUrlEnabled) {
      console.warn('[OTP] telegram callback_url disabled for local dev or invalid URL', {
        callbackUrlIncludedInRequest: false
      });
    } else {
      console.info('[OTP] telegram callback_url enabled', {
        callbackUrlIncludedInRequest: true
      });
    }

    if (env.otpProvider === 'telegram') {
      if (!telegramGatewayService.isEnabled()) {
        console.warn('[OTP] telegram provider selected but TELEGRAM_GATEWAY_TOKEN is empty, using dev fallback');
      } else {
        try {
          console.info('[OTP] telegram checkSendAbility:request', {
            internalRequestId: payload.requestId
          });
          const ability = await telegramGatewayService.checkSendAbility(payload.phone);
          const telegramRequestId = ability.requestId;
          console.info('[OTP] telegram checkSendAbility:response', {
            internalRequestId: payload.requestId,
            telegramRequestId,
            canSend: ability.canSend
          });

          if (!ability.canSend) {
            const error = new Error('TELEGRAM_CANNOT_SEND');
            console.error('[OTP] telegram checkSendAbility rejected sending', {
              internalRequestId: payload.requestId,
              telegramRequestId,
              rejected: true
            });
            throw error;
          }

          if (!telegramRequestId) {
            throw new Error('TELEGRAM_REQUEST_ID_MISSING');
          }

          const { payload: telegramPayload, payloadBytes } = buildTelegramPayload(payload.providerPayload);

          console.info('[OTP] telegram sendVerificationMessage:request', {
            internalRequestId: payload.requestId,
            telegramRequestId,
            callbackUrlIncludedInRequest: Boolean(callbackUrlForTelegram),
            ttlSeconds: payload.ttlSeconds,
            payloadLengthBytes: payloadBytes
          });
          console.debug('[OTP] telegram payload details', {
            internalRequestId: payload.requestId,
            telegramRequestId,
            payloadLengthChars: telegramPayload.length,
            payloadLengthBytes: payloadBytes
          });

          const sent = await telegramGatewayService.sendVerificationMessage({
            phoneNumber: payload.phone,
            code: payload.code,
            requestId: telegramRequestId,
            ttlSeconds: payload.ttlSeconds,
            callbackUrl: callbackUrlForTelegram,
            providerPayload: telegramPayload
          });
          console.info('[OTP] telegram sendVerificationMessage:response', {
            internalRequestId: payload.requestId,
            telegramRequestId,
            callbackUrlIncludedInRequest: Boolean(callbackUrlForTelegram),
            delivered: sent.ok,
            deliveryStatus: sent.deliveryStatus
          });

          if (!sent.ok) {
            throw new Error('TELEGRAM_SEND_FAILED');
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
        } catch (error) {
          console.error('[OTP] telegram delivery failed', {
            internalRequestId: payload.requestId,
            callbackUrlIncludedInRequest: Boolean(callbackUrlForTelegram),
            errorCode: error instanceof Error ? error.name : 'UNKNOWN'
          });
          if (error instanceof Error && error.message.startsWith('TELEGRAM_')) {
            throw error;
          }
          throw new Error('TELEGRAM_SEND_FAILED');
        }
      }
    }


    if (env.otpProvider === 'plusofon') {
      throw new Error('PLUSOFON_FLOW_REQUIRES_CALL_TO_AUTH');
    }

    if (env.smsProvider === 'twilio') {
      await smsProvider.sendOtp(payload.phone, payload.message);
      return {
        channel: 'SMS',
        provider: 'TWILIO',
        deliveryStatus: 'SENT'
      };
    }

    await smsProvider.sendOtp(payload.phone, payload.message);
    return {
      channel: 'CONSOLE',
      provider: 'CONSOLE',
      deliveryStatus: 'SENT',
      devMode: true
    };
  }
};
