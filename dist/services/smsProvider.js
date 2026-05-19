"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.smsProvider = void 0;
const env_1 = require("../config/env");
class ConsoleSmsProvider {
    async sendOtp(phoneE164, message) {
        console.log(`[SMS] ${phoneE164}: ${message}`);
    }
}
class TwilioSmsProvider {
    async sendOtp(phoneE164, message) {
        const body = new URLSearchParams({
            To: phoneE164,
            From: env_1.env.twilioFrom,
            Body: message
        });
        const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env_1.env.twilioAccountSid}/Messages.json`, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${Buffer.from(`${env_1.env.twilioAccountSid}:${env_1.env.twilioAuthToken}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body
        });
        if (!response.ok) {
            throw new Error('SMS_SEND_FAILED');
        }
    }
}
exports.smsProvider = env_1.env.smsProvider === 'twilio' ? new TwilioSmsProvider() : new ConsoleSmsProvider();
