import { Request, Router } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { authService } from '../services/authService';
import { authenticate, AuthRequest } from '../middleware/authMiddleware';
import { userRepository } from '../repositories/userRepository';
import { env } from '../config/env';
import { otpService, OtpPurpose } from '../services/otpService';
import { normalizePhone } from '../utils/phone';
import { authLimiter, otpRequestLimiter, otpVerifyLimiter } from '../middleware/rateLimiters';
import { prisma } from '../lib/prisma';
import { deviceTrustService } from '../services/deviceTrustService';

export const authRoutes = Router();

const loginFieldsSchema = z.object({ email: z.string().email().optional(), phone: z.string().min(5).optional(), password: z.string().min(6) });
const loginSchema = loginFieldsSchema.refine((value) => Boolean(value.phone || value.email), { message: 'phone or email is required', path: ['phone'] });
const fullNameSchema = z.string().trim().min(3).max(120).regex(/^[A-Za-zА-Яа-яЁё\-\s]+$/, 'Допустимы буквы, пробел и дефис').refine((value) => value.split(/\s+/).filter(Boolean).length >= 2, 'Введите ФИО минимум из двух слов');
const registerSchema = loginFieldsSchema.omit({ phone: true, email: true }).extend({ email: z.string().email(), name: z.string().trim().min(2), fullName: fullNameSchema, phone: z.string().min(5), address: z.string().min(3).optional(), privacyAccepted: z.boolean().optional(), role: z.enum(['BUYER', 'SELLER']).optional() });
const updateProfileSchema = z.object({ name: z.string().trim().min(2).optional(), fullName: z.string().trim().min(2).max(120).transform((value) => value.replace(/\s+/g, ' ')).optional(), email: z.string().email().optional(), phone: z.string().min(5).optional(), address: z.string().min(3).optional() });
const otpRequestSchema = z.object({ phone: z.string().min(5), purpose: z.enum(['buyer_register_phone', 'buyer_change_phone', 'buyer_sensitive_action', 'seller_connect_phone', 'seller_change_payout_details', 'seller_payout_settings_verify']).optional(), turnstileToken: z.string().optional() });
const otpVerifySchema = z.object({ phone: z.string().min(5), code: z.string().min(4).optional(), requestId: z.string().min(2).optional(), purpose: z.enum(['buyer_register_phone', 'buyer_change_phone', 'buyer_sensitive_action', 'seller_connect_phone', 'seller_change_payout_details', 'seller_payout_settings_verify']).optional() }).refine((value) => Boolean(value.code || value.requestId), { message: 'code or requestId is required', path: ['code'] });
const passwordResetRequestSchema = z.object({ phone: z.string().min(5) });
const passwordResetVerifySchema = z.object({ phone: z.string().min(5), requestId: z.string().min(2) });
const passwordResetConfirmSchema = z.object({ token: z.string().min(10), password: z.string().min(6) });
const loginDeviceRequestSchema = z.object({ phone: z.string().min(5) });
const loginDeviceVerifySchema = z.object({ phone: z.string().min(5), requestId: z.string().min(2) });

const refreshCookieOptions = authService.getRefreshCookieOptions();
const trustedDeviceCookieOptions = deviceTrustService.getCookieOptions();

const verifyTurnstile = async (token: string) => {
  if (!env.turnstileSecretKey) return true;
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret: env.turnstileSecretKey, response: token }) });
  if (!response.ok) return false;
  return Boolean(((await response.json()) as { success: boolean }).success);
};

const parseAuthToken = (req: AuthRequest) => req.headers.authorization?.replace('Bearer ', '') ?? null;
const decodeAuthToken = (token: string) => jwt.verify(token, env.jwtSecret) as { userId?: string; registrationSessionId?: string; role?: string; scope?: string };
const createPasswordResetToken = (payload: { userId: string }) => jwt.sign({ ...payload, scope: 'password_reset' }, env.jwtSecret, { expiresIn: '10m' });
const parsePlusofonWebhookPayload = (body: unknown) => { const source = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}; const data = source.data && typeof source.data === 'object' ? (source.data as Record<string, unknown>) : null; const merged = data ? { ...source, ...data } : source; const pick = (...keys: string[]) => { for (const key of keys) { const value = merged[key]; if (typeof value === 'string' && value.trim()) return value.trim(); } return null; }; return { requestId: pick('request_id', 'requestId', 'id', 'key'), status: pick('status', 'state'), phone: pick('phone', 'phone_number', 'recipient') }; };
const clearSessionCookies = (res: Parameters<typeof authRoutes.post>[1], includeTrustedDevice = false) => {
  res.clearCookie(env.authRefreshCookieName, refreshCookieOptions);
  if (includeTrustedDevice) res.clearCookie(env.trustedDeviceCookieName, trustedDeviceCookieOptions);
};
const finalizeAuthorizedSession = async (args: { res: any; req: Request; user: any; trustedDeviceId?: string | null; rawTrustedDeviceToken?: string | null; }) => {
  const tokens = await authService.issueTokens(args.user, args.trustedDeviceId);
  args.res.cookie(env.authRefreshCookieName, tokens.refreshToken, refreshCookieOptions);
  if (args.rawTrustedDeviceToken) args.res.cookie(env.trustedDeviceCookieName, args.rawTrustedDeviceToken, trustedDeviceCookieOptions);
  return args.res.json({ data: { accessToken: tokens.accessToken, user: authService.getPublicUser(args.user), session: { accessTokenTtlMinutes: env.authAccessTokenTtlMinutes, refreshTokenTtlDays: env.authRefreshTokenTtlDays, trustedDevice: Boolean(args.trustedDeviceId) } } });
};

authRoutes.post('/register', authLimiter, async (req, res, next) => { try { const payload = registerSchema.parse(req.body); const phone = normalizePhone(payload.phone); const result = await authService.startRegistration(payload.name, payload.fullName, payload.email, payload.password, payload.role, phone, payload.address); const tempToken = authService.issueRegistrationOtpToken(result.pending.id); res.json({ requiresOtp: true, tempToken, user: authService.getPublicUser({ ...result.pending, id: result.pending.id }) }); } catch (error) { next(error); } });

authRoutes.post('/login', authLimiter, async (req, res, next) => {
  try {
    await deviceTrustService.cleanupExpired();
    const payload = loginSchema.parse(req.body);
    const phone = payload.phone ? normalizePhone(payload.phone) : undefined;
    const result = await authService.login({ phone, email: payload.email?.trim().toLowerCase() }, payload.password);
    const user = result.user;

    if (!user.phoneVerifiedAt) {
      const tempToken = authService.issueOtpToken(user);
      return res.json({ requiresOtp: true, tempToken, user: authService.getPublicUser(user) });
    }

    const trustedDeviceToken = req.cookies?.[env.trustedDeviceCookieName] as string | undefined;
    const trustedDevice = await deviceTrustService.findTrustedDeviceForRequest(user.id, trustedDeviceToken, req);

    if (!trustedDevice) {
      clearSessionCookies(res);
      const tempToken = authService.issueLoginDeviceOtpToken(user);
      return res.json({ requiresDeviceVerification: true, tempToken, user: authService.getPublicUser(user), verification: { channel: 'PHONE_CALL', provider: 'PLUSOFON', phone: user.phone, reason: 'new_device' } });
    }

    return finalizeAuthorizedSession({ res, req, user, trustedDeviceId: trustedDevice.id });
  } catch (error) { next(error); }
});

authRoutes.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies[env.authRefreshCookieName] as string | undefined;
    if (!token) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    const result = await authService.refresh(token);
    res.cookie(env.authRefreshCookieName, result.refreshToken, refreshCookieOptions);
    return res.json({ token: result.accessToken, refreshTokenRotated: true, refreshTokenTtlDays: env.authRefreshTokenTtlDays });
  } catch (error) {
    clearSessionCookies(res);
    if (error instanceof Error && error.message === 'INVALID_REFRESH') return res.status(401).json({ error: { code: 'INVALID_REFRESH', message: 'Необходимо войти снова' } });
    return next(error);
  }
});

authRoutes.post('/logout', async (req, res, next) => { try { const token = req.cookies[env.authRefreshCookieName] as string | undefined; if (token) await authService.logout(token); clearSessionCookies(res, true); res.json({ success: true }); } catch (error) { next(error); } });

authRoutes.post('/password-reset/request', otpRequestLimiter, async (req, res, next) => { try { const payload = passwordResetRequestSchema.parse(req.body); const phone = normalizePhone(payload.phone); const user = await userRepository.findByPhone(phone); if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND' } }); const result = await otpService.requestCallOtp({ phone, purpose: 'password_reset', ip: req.ip, userAgent: req.get('user-agent') }); if (!result.ok) return res.status(503).json({ ok: false, error: result.error }); return res.json({ ok: true, data: result.data }); } catch (error) { return next(error); } });
authRoutes.post('/password-reset/verify', otpVerifyLimiter, async (req, res, next) => { try { const payload = passwordResetVerifySchema.parse(req.body); const phone = normalizePhone(payload.phone); const user = await userRepository.findByPhone(phone); if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND' } }); await otpService.verifyOtpByRequestId({ phone, requestId: payload.requestId, purpose: 'password_reset' }); return res.json({ ok: true, resetToken: createPasswordResetToken({ userId: user.id }) }); } catch (error) { return next(error); } });
authRoutes.post('/password-reset/confirm', authLimiter, async (req, res, next) => { try { const payload = passwordResetConfirmSchema.parse(req.body); const decoded = jwt.verify(payload.token, env.jwtSecret) as { userId: string; scope?: string }; if (decoded.scope !== 'password_reset') return res.status(401).json({ error: { code: 'UNAUTHORIZED' } }); const user = await userRepository.findById(decoded.userId); if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND' } }); const hashed = await bcrypt.hash(payload.password, 10); await userRepository.updatePasswordAndInvalidateSessions(user.id, hashed); clearSessionCookies(res, true); return res.json({ ok: true }); } catch (error) { return next(error); } });

authRoutes.post('/login/device/request', otpRequestLimiter, async (req, res, next) => { try { const payload = loginDeviceRequestSchema.parse(req.body); const token = parseAuthToken(req as AuthRequest); if (!token) return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } }); const decoded = decodeAuthToken(token); if (decoded.scope !== 'otp_login_device' || !decoded.userId) return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } }); const user = await userRepository.findById(decoded.userId); if (!user?.phone) return res.status(404).json({ error: { code: 'NOT_FOUND' } }); const phone = normalizePhone(payload.phone); if (phone !== user.phone) return res.status(400).json({ error: { code: 'PHONE_MISMATCH' } }); const result = await otpService.requestCallOtp({ phone, purpose: 'login_device', ip: req.ip, userAgent: req.get('user-agent') }); if (!result.ok) return res.status(503).json({ ok: false, error: result.error }); return res.json({ ok: true, data: result.data }); } catch (error) { return next(error); } });
authRoutes.post('/login/device/verify', otpVerifyLimiter, async (req, res, next) => { try { const payload = loginDeviceVerifySchema.parse(req.body); const token = parseAuthToken(req as AuthRequest); if (!token) return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } }); const decoded = decodeAuthToken(token); if (decoded.scope !== 'otp_login_device' || !decoded.userId) return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } }); const user = await userRepository.findById(decoded.userId); if (!user?.phone) return res.status(404).json({ error: { code: 'NOT_FOUND' } }); const phone = normalizePhone(payload.phone); if (phone !== user.phone) return res.status(400).json({ error: { code: 'PHONE_MISMATCH' } }); await otpService.verifyOtpByRequestId({ phone, requestId: payload.requestId, purpose: 'login_device' }); const trusted = await deviceTrustService.trustCurrentDevice(user.id, req); return finalizeAuthorizedSession({ res, req, user, trustedDeviceId: trusted.device.id, rawTrustedDeviceToken: trusted.token }); } catch (error) { return next(error); } });

authRoutes.post('/otp/request', otpRequestLimiter, async (req, res, next) => { try { const payload = otpRequestSchema.parse(req.body); if (env.turnstileSecretKey) { if (!payload.turnstileToken) return res.status(400).json({ error: { code: 'TURNSTILE_REQUIRED' } }); const verified = await verifyTurnstile(payload.turnstileToken); if (!verified) return res.status(400).json({ error: { code: 'TURNSTILE_FAILED' } }); } const purpose = (payload.purpose ?? 'buyer_register_phone') as OtpPurpose; const token = parseAuthToken(req as AuthRequest); let decoded = null as null | { userId?: string; registrationSessionId?: string; role?: string; scope?: string }; if (token) { try { decoded = decodeAuthToken(token); } catch { return res.status(401).json({ error: { code: 'UNAUTHORIZED' } }); } } if (purpose === 'buyer_register_phone') { if (!decoded || decoded.scope !== 'otp_register' || !decoded.registrationSessionId) return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } }); const pending = await prisma.pendingRegistration.findUnique({ where: { id: decoded.registrationSessionId } }); if (!pending || pending.usedAt || pending.expiresAt < new Date()) return res.status(401).json({ error: { code: 'REGISTRATION_SESSION_INVALID' } }); if (normalizePhone(payload.phone) !== pending.phone) return res.status(400).json({ error: { code: 'PHONE_MISMATCH' } }); } else if (!decoded || (decoded.scope && decoded.scope !== 'access')) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } }); const result = await otpService.requestOtp({ phone: payload.phone, purpose, ip: req.ip, userAgent: req.get('user-agent') }); if (!result.ok) return res.status(result.error.code === 'OTP_PROVIDER_TIMEOUT' ? 504 : result.error.code === 'OTP_REQUEST_FAILED' ? 500 : 503).json({ ok: false, error: result.error }); if (result.throttled) return res.json({ ok: true, data: null, throttled: true }); if (result.data) return res.json({ ok: true, data: result.data }); return res.json({ ok: true, data: null, devOtp: result.devOtp, delivery: result.delivery }); } catch (error) { return next(error); } });
authRoutes.get('/otp/status/:requestId', async (req, res, next) => { try { const requestId = z.string().min(2).parse(req.params.requestId); const token = parseAuthToken(req as AuthRequest); if (!token) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } }); let decoded; try { decoded = decodeAuthToken(token); } catch { return res.status(401).json({ error: { code: 'UNAUTHORIZED' } }); } if (!decoded.scope || !['otp_register', 'access', 'otp_login_device'].includes(decoded.scope)) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } }); const status = await otpService.getOtpStatusByRequestId(requestId); return res.json({ ok: true, data: status }); } catch (error) { return next(error); } });
authRoutes.post('/otp/verify', otpVerifyLimiter, async (req, res, next) => { try { const payload = otpVerifySchema.parse(req.body); const purpose = (payload.purpose ?? 'buyer_register_phone') as OtpPurpose; const token = parseAuthToken(req as AuthRequest); let decoded = null as null | { userId?: string; registrationSessionId?: string; role?: string; scope?: string }; if (token) { try { decoded = decodeAuthToken(token); } catch { return res.status(401).json({ error: { code: 'UNAUTHORIZED' } }); } } const needsOtpToken = purpose === 'buyer_register_phone'; if (needsOtpToken && (!decoded || decoded.scope !== 'otp_register' || !decoded.registrationSessionId)) return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } }); if (!needsOtpToken && (!decoded || (decoded.scope && decoded.scope !== 'access'))) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } }); const verification = payload.requestId ? await otpService.verifyOtpByRequestId({ phone: payload.phone, requestId: payload.requestId, purpose }) : await otpService.verifyOtp({ phone: payload.phone, code: payload.code!, purpose }); const { phone } = verification; let user; if (needsOtpToken) { const registrationSessionId = decoded?.registrationSessionId; if (!registrationSessionId) return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } }); user = (await authService.completeRegistration(registrationSessionId, phone)).user; } else { const userId = decoded?.userId; if (!userId) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } }); user = await userRepository.findById(userId); if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } }); if (user.phone && user.phone !== phone) return res.status(400).json({ error: { code: 'PHONE_MISMATCH' } }); if (!user.phone) { const existingPhone = await userRepository.findByPhone(phone); if (existingPhone && existingPhone.id !== user.id) return res.status(409).json({ error: { code: 'PHONE_EXISTS' } }); } if (!user.phoneVerifiedAt || user.phone !== phone) user = await userRepository.updateProfile(user.id, { phone, phoneVerifiedAt: new Date() }); }
    return finalizeAuthorizedSession({ res, req, user });
  } catch (error) { return next(error); } });

authRoutes.post('/otp/telegram/callback', async (req, res, next) => { try { const timestamp = req.get('X-Request-Timestamp'); const signature = req.get('X-Request-Signature'); const rawBody = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {}); if (!timestamp || !signature) return res.status(400).json({ error: { code: 'INVALID_SIGNATURE_HEADERS' } }); const valid = otpService.validateTelegramCallbackSignature({ timestamp, signature, rawBody }); if (!valid) return res.status(401).json({ error: { code: 'INVALID_SIGNATURE' } }); const body = req.body as { request_id?: string; payload?: string; status?: string; }; const mappedStatus = otpService.mapIncomingDeliveryStatus(body.status ?? ''); if (!mappedStatus) return res.status(200).json({ ok: true, ignored: true }); await otpService.updateDeliveryStatus({ providerRequestId: body.request_id, providerPayload: body.payload, deliveryStatus: mappedStatus }); return res.json({ ok: true }); } catch (error) { return next(error); } });
authRoutes.post('/otp/plusofon/webhook', async (req, res, next) => { try { if (env.plusofonWebhookSecret) { const headerSecret = req.get('X-Webhook-Secret') ?? req.get('X-Plusofon-Secret') ?? ''; if (!headerSecret || headerSecret !== env.plusofonWebhookSecret) return res.status(401).json({ error: { code: 'INVALID_SIGNATURE' } }); } const body = req.body as unknown; const parsed = parsePlusofonWebhookPayload(body); if (!parsed.requestId) return res.status(200).json({ ok: true, ignored: true }); const effectiveStatus = parsed.status ?? (parsed.phone ? 'verified' : 'pending'); const mapped = otpService.mapPlusofonStatus(effectiveStatus); if (mapped !== 'pending') await otpService.markOtpVerifiedByProviderRequestId({ requestId: parsed.requestId, status: mapped, providerPayload: body }); return res.json({ ok: true }); } catch (error) { return next(error); } });

authRoutes.get('/me', authenticate, async (req: AuthRequest, res, next) => { try { const user = await userRepository.findById(req.user!.userId); if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND' } }); return res.json({ data: { id: user.id, name: user.name, fullName: user.fullName, role: user.role, email: user.email } }); } catch (error) { return next(error); } });
authRoutes.patch('/me', authenticate, async (req: AuthRequest, res, next) => { try { const payload = updateProfileSchema.parse(req.body); const existingUser = await userRepository.findById(req.user!.userId); if (!existingUser) return res.status(404).json({ error: { code: 'NOT_FOUND' } }); if (payload.email) { const existing = await userRepository.findByEmail(payload.email); if (existing && existing.id !== req.user!.userId) return res.status(400).json({ error: { code: 'EMAIL_EXISTS' } }); } let phone = payload.phone; let phoneVerifiedAt = existingUser.phoneVerifiedAt; if (payload.phone) { phone = normalizePhone(payload.phone); const existingPhone = await userRepository.findByPhone(phone); if (existingPhone && existingPhone.id !== req.user!.userId) return res.status(400).json({ error: { code: 'PHONE_EXISTS' } }); if (existingUser.phone !== phone) phoneVerifiedAt = null; } const updated = await userRepository.updateProfile(req.user!.userId, { name: payload.name, email: payload.email, phone: payload.phone ? phone ?? null : existingUser.phone, phoneVerifiedAt: payload.phone ? phoneVerifiedAt ?? null : existingUser.phoneVerifiedAt, address: payload.address ?? null, fullName: payload.fullName ?? existingUser.fullName }); return res.json({ data: authService.getPublicUser(updated) }); } catch (error) { return next(error); } });
