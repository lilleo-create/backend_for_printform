import { Request, Router } from 'express';
import { z } from 'zod';
import { authService } from '../services/authService';
import { authenticate, AuthRequest } from '../middleware/authMiddleware';
import { userRepository } from '../repositories/userRepository';
import { env } from '../config/env';
import { otpService, OtpPurpose } from '../services/otpService';
import { normalizePhone } from '../utils/phone';
import { authLimiter, otpRequestLimiter, otpVerifyLimiter } from '../middleware/rateLimiters';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';

export const authRoutes = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

const fullNameSchema = z.string().trim().min(3).max(120).regex(/^[A-Za-zА-Яа-яЁё\-\s]+$/, 'Допустимы буквы, пробел и дефис').refine((value) => value.split(/\s+/).filter(Boolean).length >= 2, 'Введите ФИО минимум из двух слов');

const registerSchema = loginSchema.extend({
  name: z.string().trim().min(2),
  fullName: fullNameSchema,
  phone: z.string().min(5),
  address: z.string().min(3).optional(),
  privacyAccepted: z.boolean().optional(),
  role: z.enum(['BUYER', 'SELLER']).optional()
});

const updateProfileSchema = z.object({
  name: z.string().trim().min(2).optional(),
  fullName: z.string().trim().min(2).max(120).transform((value) => value.replace(/\s+/g, ' ')).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(5).optional(),
  address: z.string().min(3).optional()
});

const otpRequestSchema = z.object({
  phone: z.string().min(5),
  purpose: z.enum(['buyer_register_phone', 'buyer_change_phone', 'buyer_sensitive_action', 'seller_connect_phone', 'seller_change_payout_details', 'seller_payout_settings_verify']).optional(),
  turnstileToken: z.string().optional()
});

const otpVerifySchema = z.object({
  phone: z.string().min(5),
  code: z.string().min(4).optional(),
  requestId: z.string().min(2).optional(),
  purpose: z.enum(['buyer_register_phone', 'buyer_change_phone', 'buyer_sensitive_action', 'seller_connect_phone', 'seller_change_payout_details', 'seller_payout_settings_verify']).optional()
}).refine((value) => Boolean(value.code || value.requestId), {
  message: 'code or requestId is required',
  path: ['code']
});

const passwordResetRequestSchema = z.object({
  phone: z.string().min(5)
});

const passwordResetVerifySchema = z.object({
  phone: z.string().min(5),
  code: z.string().min(4)
});

const passwordResetConfirmSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(6)
});

const cookieOptions = {
  httpOnly: true,
  sameSite: env.isProduction ? 'strict' : 'lax',
  secure: env.isProduction
} as const;

const verifyTurnstile = async (token: string) => {
  if (!env.turnstileSecretKey) {
    return true;
  }
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      secret: env.turnstileSecretKey,
      response: token
    })
  });
  if (!response.ok) {
    return false;
  }
  const result = (await response.json()) as { success: boolean };
  return Boolean(result.success);
};

const parseAuthToken = (req: AuthRequest) => {
  const header = req.headers.authorization;
  if (!header) {
    return null;
  }
  return header.replace('Bearer ', '');
};

const decodeAuthToken = (token: string) => {
  return jwt.verify(token, env.jwtSecret) as { userId?: string; registrationSessionId?: string; role?: string; scope?: string };
};

const parsePlusofonWebhookPayload = (body: unknown) => {
  const source = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const data = source.data && typeof source.data === 'object' ? (source.data as Record<string, unknown>) : null;
  const merged = data ? { ...source, ...data } : source;

  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = merged[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return null;
  };

  return {
    requestId: pick('request_id', 'requestId', 'id', 'key'),
    status: pick('status', 'state'),
    phone: pick('phone', 'phone_number', 'recipient')
  };
};

const createPasswordResetToken = (payload: { userId: string }) => {
  return jwt.sign({ ...payload, scope: 'password_reset' }, env.jwtSecret, { expiresIn: '10m' });
};

authRoutes.post('/register', authLimiter, async (req, res, next) => {
  try {
    const payload = registerSchema.parse(req.body);
    const phone = normalizePhone(payload.phone);
    const result = await authService.startRegistration(
      payload.name,
      payload.fullName,
      payload.email,
      payload.password,
      payload.role,
      phone,
      payload.address
    );
    const tempToken = authService.issueRegistrationOtpToken(result.pending.id);
    res.json({
      requiresOtp: true,
      tempToken,
      user: {
        id: result.pending.id,
        name: result.pending.name,
        fullName: result.pending.fullName,
        role: result.pending.role,
        email: result.pending.email,
        phone: result.pending.phone,
        address: result.pending.address
      }
    });
  } catch (error) {
    next(error);
  }
});

authRoutes.post('/login', authLimiter, async (req, res, next) => {
  try {
    const payload = loginSchema.parse(req.body);
    const result = await authService.login(payload.email, payload.password);
    if (!result.user.phoneVerifiedAt) {
      const tempToken = authService.issueOtpToken(result.user);
      return res.json({
        requiresOtp: true,
        tempToken,
        user: {
          id: result.user.id,
          name: result.user.name,
          fullName: result.user.fullName,
          role: result.user.role,
          email: result.user.email,
          phone: result.user.phone,
          address: result.user.address
        }
      });
    }
    const tokens = await authService.issueTokens(result.user);
    res.cookie('refreshToken', tokens.refreshToken, cookieOptions);
    return res.json({
      data: {
        accessToken: tokens.accessToken,
        user: {
          id: result.user.id,
          name: result.user.name,
          fullName: result.user.fullName,
          role: result.user.role,
          email: result.user.email,
          phone: result.user.phone,
          address: result.user.address
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

authRoutes.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies.refreshToken as string | undefined;
    if (!token) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    }
    const result = await authService.refresh(token);
    return res.json({ token: result.accessToken });
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_REFRESH') {
      console.warn('[auth][refresh] invalid refresh token', { hasCookie: Boolean(req.cookies.refreshToken) });
      return res.status(401).json({ error: { code: 'INVALID_REFRESH', message: 'Необходимо войти снова' } });
    }
    return next(error);
  }
});

authRoutes.post('/logout', async (req, res, next) => {
  try {
    const token = req.cookies.refreshToken as string | undefined;
    if (token) {
      await authService.logout(token);
    }
    res.clearCookie('refreshToken', cookieOptions);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

authRoutes.post('/password-reset/request', otpRequestLimiter, async (req, res, next) => {
  try {
    const payload = passwordResetRequestSchema.parse(req.body);
    const phone = normalizePhone(payload.phone);
    const user = await userRepository.findByPhone(phone);
    if (!user) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }
    const result = await otpService.requestOtp({
      phone,
      purpose: 'password_reset',
      ip: req.ip,
      userAgent: req.get('user-agent')
    });

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: {
          code: result.error.code,
          message: result.error.message
        }
      });
    }

    return res.json({ ok: true, devOtp: result.devOtp, delivery: result.delivery });
  } catch (error) {
    return next(error);
  }
});

authRoutes.post('/password-reset/verify', otpVerifyLimiter, async (req, res, next) => {
  try {
    const payload = passwordResetVerifySchema.parse(req.body);
    const phone = normalizePhone(payload.phone);
    const user = await userRepository.findByPhone(phone);
    if (!user) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }
    await otpService.verifyOtp({ phone, code: payload.code, purpose: 'password_reset' });
    const resetToken = createPasswordResetToken({ userId: user.id });
    return res.json({ ok: true, resetToken });
  } catch (error) {
    return next(error);
  }
});

authRoutes.post('/password-reset/confirm', authLimiter, async (req, res, next) => {
  try {
    const payload = passwordResetConfirmSchema.parse(req.body);
    const decoded = jwt.verify(payload.token, env.jwtSecret) as { userId: string; scope?: string };
    if (decoded.scope !== 'password_reset') {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    }
    const user = await userRepository.findById(decoded.userId);
    if (!user) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }
    const hashed = await bcrypt.hash(payload.password, 10);
    await userRepository.updatePassword(user.id, hashed);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

authRoutes.post('/otp/request', otpRequestLimiter, async (req, res, next) => {
  try {
    const payload = otpRequestSchema.parse(req.body);
    if (env.turnstileSecretKey) {
      if (!payload.turnstileToken) {
        return res.status(400).json({ error: { code: 'TURNSTILE_REQUIRED' } });
      }
      const verified = await verifyTurnstile(payload.turnstileToken);
      if (!verified) {
        return res.status(400).json({ error: { code: 'TURNSTILE_FAILED' } });
      }
    }
    const purpose = (payload.purpose ?? 'buyer_register_phone') as OtpPurpose;
    const token = parseAuthToken(req);
    let decoded: { userId?: string; registrationSessionId?: string; role?: string; scope?: string } | null = null;
    if (token) {
      try {
        decoded = decodeAuthToken(token);
      } catch {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
      }
    }
    if (purpose === 'buyer_register_phone') {
      if (!decoded || decoded.scope !== 'otp_register' || !decoded.registrationSessionId) {
        return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } });
      }
      const pending = await prisma.pendingRegistration.findUnique({ where: { id: decoded.registrationSessionId } });
      if (!pending || pending.usedAt || pending.expiresAt < new Date()) {
        return res.status(401).json({ error: { code: 'REGISTRATION_SESSION_INVALID' } });
      }
      if (normalizePhone(payload.phone) !== pending.phone) {
        return res.status(400).json({ error: { code: 'PHONE_MISMATCH' } });
      }
    } else if (!decoded || (decoded.scope && decoded.scope !== 'access')) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    }
    const result = await otpService.requestOtp({
      phone: payload.phone,
      purpose,
      ip: req.ip,
      userAgent: req.get('user-agent')
    });

    if (!result.ok) {
      const status =
        result.error.code === 'OTP_PROVIDER_TIMEOUT'
          ? 504
          : result.error.code === 'OTP_REQUEST_FAILED'
          ? 500
          : 503;

      return res.status(status).json({
        ok: false,
        error: {
          code: result.error.code,
          message: result.error.message
        }
      });
    }

    if (result.throttled) {
      return res.json({
        ok: true,
        data: null,
        throttled: true
      });
    }

    if (result.data) {
      return res.json({
        ok: true,
        data: {
          requestId: result.data.requestId,
          verificationType: result.data.verificationType,
          callToAuthNumber: result.data.callToAuthNumber,
          phone: result.data.phone,
          provider: result.data.provider
        }
      });
    }

    return res.json({
      ok: true,
      data: null,
      devOtp: result.devOtp,
      delivery: result.delivery
    });
  } catch (error) {
    return next(error);
  }
});

authRoutes.get('/otp/status/:requestId', async (req, res, next) => {
  try {
    const requestId = z.string().min(2).parse(req.params.requestId);
    const token = parseAuthToken(req as AuthRequest);

    if (!token) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    }

    let decoded: { userId?: string; registrationSessionId?: string; role?: string; scope?: string };
    try {
      decoded = decodeAuthToken(token);
    } catch {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    }

    if (!decoded.scope || !['otp_register', 'access'].includes(decoded.scope)) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    }

    const status = await otpService.getOtpStatusByRequestId(requestId);
    return res.json({
      ok: true,
      data: {
        requestId: status.requestId,
        status: status.status,
        provider: status.provider
      }
    });
  } catch (error) {
    return next(error);
  }
});

authRoutes.post('/otp/verify', otpVerifyLimiter, async (req, res, next) => {
  try {
    const payload = otpVerifySchema.parse(req.body);
    const purpose = (payload.purpose ?? 'buyer_register_phone') as OtpPurpose;
    const token = parseAuthToken(req);
    let decoded: { userId?: string; registrationSessionId?: string; role?: string; scope?: string } | null = null;
    if (token) {
      try {
        decoded = decodeAuthToken(token);
      } catch {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
      }
    }
    const needsOtpToken = purpose === 'buyer_register_phone';
    if (needsOtpToken && (!decoded || decoded.scope !== 'otp_register' || !decoded.registrationSessionId)) {
      return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } });
    }
    if (!needsOtpToken && (!decoded || (decoded.scope && decoded.scope !== 'access'))) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    }

    const verification = payload.requestId
      ? await otpService.verifyOtpByRequestId({
          phone: payload.phone,
          requestId: payload.requestId,
          purpose
        })
      : await otpService.verifyOtp({
          phone: payload.phone,
          code: payload.code!,
          purpose
        });

    const { phone } = verification;

    let user;
    if (needsOtpToken) {
      const registrationSessionId = decoded?.registrationSessionId;
      if (!registrationSessionId) {
        return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } });
      }
      const created = await authService.completeRegistration(registrationSessionId, phone);
      user = created.user;
    } else {
      const userId = decoded?.userId;
      if (!userId) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
      }
      user = await userRepository.findById(userId);
      if (!user) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
      }
      if (user.phone && user.phone !== phone) {
        return res.status(400).json({ error: { code: 'PHONE_MISMATCH' } });
      }
      if (!user.phone) {
        const existingPhone = await userRepository.findByPhone(phone);
        if (existingPhone && existingPhone.id !== user.id) {
          return res.status(409).json({ error: { code: 'PHONE_EXISTS' } });
        }
      }
      if (!user.phoneVerifiedAt || user.phone !== phone) {
        user = await userRepository.updateProfile(user.id, { phone, phoneVerifiedAt: new Date() });
      }
    }
    const tokens = await authService.issueTokens(user);
    res.cookie('refreshToken', tokens.refreshToken, cookieOptions);
    return res.json({
      data: {
        accessToken: tokens.accessToken,
        user: {
          id: user.id,
          name: user.name,
          fullName: user.fullName,
          role: user.role,
          email: user.email,
          phone: user.phone,
          address: user.address
        }
      }
    });
  } catch (error) {
    return next(error);
  }
});


authRoutes.post('/otp/telegram/callback', async (req, res, next) => {
  try {
    const timestamp = req.get('X-Request-Timestamp');
    const signature = req.get('X-Request-Signature');
    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});

    if (!timestamp || !signature) {
      return res.status(400).json({ error: { code: 'INVALID_SIGNATURE_HEADERS' } });
    }

    const valid = otpService.validateTelegramCallbackSignature({
      timestamp,
      signature,
      rawBody
    });

    if (!valid) {
      return res.status(401).json({ error: { code: 'INVALID_SIGNATURE' } });
    }

    const body = req.body as {
      request_id?: string;
      payload?: string;
      status?: string;
    };

    console.info('[OTP] telegram callback received', {
      providerRequestId: body.request_id,
      payload: body.payload,
      status: body.status
    });

    const mappedStatus = otpService.mapIncomingDeliveryStatus(body.status ?? '');
    if (!mappedStatus) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    await otpService.updateDeliveryStatus({
      providerRequestId: body.request_id,
      providerPayload: body.payload,
      deliveryStatus: mappedStatus
    });

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});


authRoutes.post('/otp/plusofon/webhook', async (req, res, next) => {
  try {
    console.info('[PLUSOFON WEBHOOK HEADERS]', req.headers);
    console.info('[PLUSOFON WEBHOOK BODY]', req.body);

    if (env.plusofonWebhookSecret) {
      const headerSecret = req.get('X-Webhook-Secret') ?? req.get('X-Plusofon-Secret') ?? '';
      if (!headerSecret || headerSecret !== env.plusofonWebhookSecret) {
        console.warn('[PLUSOFON WEBHOOK] invalid signature', {
          headerSecretPresent: Boolean(headerSecret)
        });
        return res.status(401).json({ error: { code: 'INVALID_SIGNATURE' } });
      }
    }

    const body = req.body as unknown;
    const parsed = parsePlusofonWebhookPayload(body);

    console.info('[PLUSOFON WEBHOOK PARSED]', parsed);

    if (!parsed.requestId) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const effectiveStatus = parsed.status ?? (parsed.phone ? 'verified' : 'pending');
    const mapped = otpService.mapPlusofonStatus(effectiveStatus);

    console.info('[PLUSOFON WEBHOOK STATUS]', {
      requestId: parsed.requestId,
      providerStatus: parsed.status,
      effectiveStatus,
      mappedStatus: mapped
    });

    if (mapped !== 'pending') {
      await otpService.markOtpVerifiedByProviderRequestId({
        requestId: parsed.requestId,
        status: mapped,
        providerPayload: body
      });
    }

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

authRoutes.get('/me', authenticate, async (req: AuthRequest, res, next) => {
  try {
    const user = await userRepository.findById(req.user!.userId);
    if (!user) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }
    return res.json({
      data: {
        id: user.id,
        name: user.name,
        fullName: user.fullName,
        role: user.role,
        email: user.email
      }
    });
  } catch (error) {
    return next(error);
  }
});

authRoutes.patch('/me', authenticate, async (req: AuthRequest, res, next) => {
  try {
    const payload = updateProfileSchema.parse(req.body);
    const existingUser = await userRepository.findById(req.user!.userId);
    if (!existingUser) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }
    if (payload.email) {
      const existing = await userRepository.findByEmail(payload.email);
      if (existing && existing.id !== req.user!.userId) {
        return res.status(400).json({ error: { code: 'EMAIL_EXISTS' } });
      }
    }
    let phone = payload.phone;
    let phoneVerifiedAt = existingUser.phoneVerifiedAt;
    if (payload.phone) {
      phone = normalizePhone(payload.phone);
      const existingPhone = await userRepository.findByPhone(phone);
      if (existingPhone && existingPhone.id !== req.user!.userId) {
        return res.status(400).json({ error: { code: 'PHONE_EXISTS' } });
      }
      if (existingUser.phone !== phone) {
        phoneVerifiedAt = null;
      }
    }
    const phoneToUpdate = payload.phone ? phone ?? null : existingUser.phone;
    const phoneVerifiedAtToUpdate = payload.phone ? phoneVerifiedAt : existingUser.phoneVerifiedAt;
    const updated = await userRepository.updateProfile(req.user!.userId, {
      name: payload.name,
      email: payload.email,
      phone: phoneToUpdate ?? null,
      phoneVerifiedAt: phoneVerifiedAtToUpdate ?? null,
      address: payload.address ?? null,
      fullName: payload.fullName ?? existingUser.fullName
    });
    return res.json({
      data: {
        id: updated.id,
        name: updated.name,
        fullName: updated.fullName,
        role: updated.role,
        email: updated.email,
        phone: updated.phone,
        address: updated.address
      }
    });
  } catch (error) {
    return next(error);
  }
});
