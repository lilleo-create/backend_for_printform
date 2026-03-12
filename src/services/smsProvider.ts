import { env } from '../config/env';

export interface SmsProvider {
  sendOtp(phoneE164: string, message: string): Promise<void>;
}

class ConsoleSmsProvider implements SmsProvider {
  async sendOtp(phoneE164: string, message: string) {
    console.log(`[SMS] ${phoneE164}: ${message}`);
  }
}

class TwilioSmsProvider implements SmsProvider {
  async sendOtp(phoneE164: string, message: string) {
    const body = new URLSearchParams({
      To: phoneE164,
      From: env.twilioFrom,
      Body: message
    });
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${env.twilioAccountSid}:${env.twilioAuthToken}`
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
      }
    );
    if (!response.ok) {
      throw new Error('SMS_SEND_FAILED');
    }
  }
}

export const smsProvider: SmsProvider =
  env.smsProvider === 'twilio' ? new TwilioSmsProvider() : new ConsoleSmsProvider();
