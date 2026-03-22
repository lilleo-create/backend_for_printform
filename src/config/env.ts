import dotenv from 'dotenv';

dotenv.config();

const requireEnv = (key: string) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';

const port = Number(process.env.PORT ?? 4000);
if (Number.isNaN(port) || port <= 0) {
  throw new Error('PORT must be a valid number');
}

const authAccessTokenTtlMinutes = Number(process.env.AUTH_ACCESS_TOKEN_TTL_MINUTES ?? 15);
const authRefreshTokenTtlDays = Number(process.env.AUTH_REFRESH_TOKEN_TTL_DAYS ?? 30);
const trustedDeviceTtlDays = Number(process.env.TRUSTED_DEVICE_TTL_DAYS ?? 30);
const trustedDeviceCookieName = process.env.TRUSTED_DEVICE_COOKIE_NAME ?? 'trustedDeviceToken';
const authRefreshCookieName = process.env.AUTH_REFRESH_COOKIE_NAME ?? 'refreshToken';
const authCookieSameSiteRaw = (process.env.AUTH_COOKIE_SAME_SITE ?? 'lax').toLowerCase();
const authCookieSameSite = ['strict', 'lax', 'none'].includes(authCookieSameSiteRaw)
  ? (authCookieSameSiteRaw as 'strict' | 'lax' | 'none')
  : 'lax';
const authCookieDomain = process.env.AUTH_COOKIE_DOMAIN ?? '';

if (
  Number.isNaN(authAccessTokenTtlMinutes) ||
  Number.isNaN(authRefreshTokenTtlDays) ||
  Number.isNaN(trustedDeviceTtlDays)
) {
  throw new Error('AUTH_ACCESS_TOKEN_TTL_MINUTES, AUTH_REFRESH_TOKEN_TTL_DAYS, TRUSTED_DEVICE_TTL_DAYS must be numbers');
}

const jwtSecret = requireEnv('JWT_SECRET');
const jwtRefreshSecret = requireEnv('JWT_REFRESH_SECRET');
const otpPepper = requireEnv('OTP_HASH_PEPPER');

if (jwtSecret.length < 32 || jwtRefreshSecret.length < 32 || otpPepper.length < 32) {
  throw new Error('JWT secrets and OTP_HASH_PEPPER must be at least 32 characters long');
}

const smsProvider = process.env.SMS_PROVIDER ?? 'console';
if (smsProvider === 'twilio') {
  requireEnv('TWILIO_ACCOUNT_SID');
  requireEnv('TWILIO_AUTH_TOKEN');
  requireEnv('TWILIO_FROM');
}

const rawOtpProvider = (process.env.OTP_PROVIDER ?? 'telegram').toLowerCase();
const otpProvider =
  rawOtpProvider === 'telegram_gateway' || rawOtpProvider === 'telegram-gateway'
    ? 'telegram'
    : rawOtpProvider;
const telegramGatewayBaseUrl = process.env.TELEGRAM_GATEWAY_BASE_URL ?? 'https://gatewayapi.telegram.org';
const telegramGatewayToken = process.env.TELEGRAM_GATEWAY_TOKEN ?? '';
const telegramGatewayCallbackSecret = process.env.TELEGRAM_GATEWAY_CALLBACK_SECRET ?? '';
if (otpProvider === 'telegram' && !telegramGatewayToken && isProduction) {
  throw new Error('TELEGRAM_GATEWAY_TOKEN is required when OTP_PROVIDER=telegram in production');
}

const plusofonBaseUrl = process.env.PLUSOFON_BASE_URL ?? 'https://api.plusofon.ru';
const plusofonFlashCallEndpoint = process.env.PLUSOFON_FLASH_CALL_ENDPOINT ?? '/api/v1/flash-call/call-to-auth';
const plusofonFlashAccessToken = process.env.PLUSOFON_FLASH_ACCESS_TOKEN ?? '';
const plusofonClientId = process.env.PLUSOFON_CLIENT_ID ?? '10553';
const plusofonWebhookPublicUrl = process.env.PLUSOFON_WEBHOOK_PUBLIC_URL ?? '';
const plusofonWebhookSecret = process.env.PLUSOFON_WEBHOOK_SECRET ?? '';
const plusofonRequestTimeoutMs = Number(process.env.PLUSOFON_REQUEST_TIMEOUT_MS ?? 10000);
const plusofonVerificationExpiresSec = Number(process.env.PLUSOFON_VERIFICATION_EXPIRES_SEC ?? 300);

if (otpProvider === 'plusofon' && !plusofonFlashAccessToken && isProduction) {
  throw new Error('PLUSOFON_FLASH_ACCESS_TOKEN is required when OTP_PROVIDER=plusofon in production');
}

if (Number.isNaN(plusofonRequestTimeoutMs) || Number.isNaN(plusofonVerificationExpiresSec)) {
  throw new Error('PLUSOFON_REQUEST_TIMEOUT_MS and PLUSOFON_VERIFICATION_EXPIRES_SEC must be numbers');
}

const otpTtlMinutes = Number(process.env.OTP_TTL_MINUTES ?? 10);
const otpCooldownSeconds = Number(process.env.OTP_COOLDOWN_SECONDS ?? 60);
const otpMaxAttempts = Number(process.env.OTP_MAX_ATTEMPTS ?? 5);

if (
  Number.isNaN(otpTtlMinutes) ||
  Number.isNaN(otpCooldownSeconds) ||
  Number.isNaN(otpMaxAttempts)
) {
  throw new Error('OTP_TTL_MINUTES, OTP_COOLDOWN_SECONDS, OTP_MAX_ATTEMPTS must be numbers');
}

export const env = {
  nodeEnv,
  isProduction,
  port,
  databaseUrl: requireEnv('DATABASE_URL'),
  backendUrl: process.env.BACKEND_URL ?? `http://localhost:${port}`,
  authAccessTokenTtlMinutes,
  authRefreshTokenTtlDays,
  trustedDeviceTtlDays,
  trustedDeviceCookieName,
  authRefreshCookieName,
  authCookieSameSite,
  authCookieDomain,
  jwtSecret,
  jwtRefreshSecret,
  frontendUrl: requireEnv('FRONTEND_URL'),
  otpPepper,
  otpProvider,
  otpTtlMinutes,
  otpCooldownSeconds,
  otpMaxAttempts,
  smsProvider,
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? '',
  twilioFrom: process.env.TWILIO_FROM ?? '',
  telegramGatewayBaseUrl,
  telegramGatewayToken,
  telegramGatewayCallbackSecret,
  plusofonBaseUrl,
  plusofonFlashCallEndpoint,
  plusofonFlashAccessToken,
plusofonClientId,  
plusofonWebhookPublicUrl,
  plusofonWebhookSecret,
  plusofonRequestTimeoutMs,
  plusofonVerificationExpiresSec,
  turnstileSecretKey: process.env.TURNSTILE_SECRET_KEY ?? '',
  googleSheetsId: process.env.GOOGLE_SHEETS_ID ?? '',
  googleServiceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? '',
  googlePrivateKey: process.env.GOOGLE_PRIVATE_KEY ?? ''
};
