import { Request, Response, Router } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { authService } from "../services/authService";
import { authenticate, AuthRequest } from "../middleware/authMiddleware";
import { userRepository } from "../repositories/userRepository";
import { env } from "../config/env";
import {
  otpService,
  OtpPurpose,
  OtpRequestResult,
} from "../services/otpService";
import { normalizePhone } from "../utils/phone";
import {
  authLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
} from "../middleware/rateLimiters";
import { prisma } from "../lib/prisma";
import { deviceTrustService } from "../services/deviceTrustService";

export const authRoutes = Router();

const loginIdentifierSchema = z
  .object({
    phone: z.string().min(5).optional(),
    email: z.string().trim().min(5).optional(),
    password: z.string().min(6),
  })
  .transform((value) => ({
    password: value.password,
    phone: value.phone?.trim() || value.email?.trim() || undefined,
  }))
  .refine((value) => Boolean(value.phone), {
    message: "phone is required",
    path: ["phone"],
  });
const loginSchema = loginIdentifierSchema;
const loginFieldsSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(5).optional(),
  password: z.string().min(6),
});
const fullNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[A-Za-zА-Яа-яЁё\-\s]+$/, "Допустимы буквы, пробел и дефис")
  .refine(
    (value) => value.split(/\s+/).filter(Boolean).length >= 2,
    "Введите ФИО минимум из двух слов",
  );
const registerSchema = loginFieldsSchema
  .omit({ phone: true, email: true })
  .extend({
    email: z.string().email(),
    name: z.string().trim().min(2),
    fullName: fullNameSchema,
    phone: z.string().min(5),
    address: z.string().min(3).optional(),
    privacyAccepted: z.boolean().optional(),
    role: z.enum(["BUYER", "SELLER"]).optional(),
  });
const updateProfileSchema = z.object({
  name: z.string().trim().min(2).optional(),
  fullName: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .transform((value) => value.replace(/\s+/g, " "))
    .optional(),
  email: z.string().email().optional(),
  phone: z.string().min(5).optional(),
  address: z.string().min(3).optional(),
});
const otpPurposeSchema = z.enum([
  "buyer_register_phone",
  "buyer_change_phone",
  "buyer_sensitive_action",
  "seller_connect_phone",
  "seller_change_payout_details",
  "seller_payout_settings_verify",
  "login_device",
  "password_reset",
]);
const otpRequestSchema = z.object({
  phone: z.string().min(5),
  purpose: otpPurposeSchema.optional(),
  turnstileToken: z.string().optional(),
});
const otpVerifySchema = z
  .object({
    phone: z.string().min(5),
    code: z.string().min(4).optional(),
    requestId: z.string().min(2).optional(),
    purpose: otpPurposeSchema.optional(),
    tempToken: z.string().min(10).optional(),
  })
  .refine((value) => Boolean(value.code || value.requestId), {
    message: "code or requestId is required",
    path: ["code"],
  });
const passwordResetRequestSchema = z.object({ phone: z.string().min(5) });
const passwordResetVerifySchema = z
  .object({
    phone: z.string().min(5),
    code: z.string().min(4).optional(),
    requestId: z.string().min(2).optional(),
    tempToken: z.string().min(10).optional(),
  })
  .refine((value) => Boolean(value.code || value.requestId), {
    message: "code or requestId is required",
    path: ["code"],
  });
const deviceLoginVerifySchema = z
  .object({
    phone: z.string().min(5),
    code: z.string().min(4).optional(),
    requestId: z.string().min(2).optional(),
    tempToken: z.string().min(10).optional(),
  })
  .refine((value) => Boolean(value.code || value.requestId), {
    message: "code or requestId is required",
    path: ["code"],
  });
const passwordResetConfirmSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(6),
});
const passwordResetResendSchema = z.object({
  phone: z.string().min(5),
  tempToken: z.string().min(10).optional(),
});

type DecodedAuthToken = {
  userId?: string;
  registrationSessionId?: string;
  role?: string;
  scope?: string;
};

type OtpChallengePurpose = Extract<
  OtpPurpose,
  "login_device" | "password_reset"
>;

type OtpChallengePayload = {
  phone: string;
  purpose: OtpChallengePurpose;
  req: Request;
  tempToken: string;
  user: ReturnType<typeof authService.getPublicUser>;
  errorCode:
    | "DEVICE_VERIFICATION_REQUIRED"
    | "PASSWORD_RESET_VERIFICATION_REQUIRED";
  errorMessage: string;
};

type OtpLifecycleSnapshot = {
  requestId: string | null;
  otpRequest: {
    requestId: string;
    phone: string;
    provider: "plusofon";
    verificationType: "call_to_auth";
    callToAuthNumber: string | null;
  } | null;
  resendAvailableAt: string | null;
  retryAfterSeconds: number;
  challengeExpiresAt: string | null;
};

const refreshCookieOptions = authService.getRefreshCookieOptions();
const trustedDeviceCookieOptions = deviceTrustService.getCookieOptions();
const refreshCookieClearOptions = {
  ...refreshCookieOptions,
  maxAge: undefined,
} as const;
const trustedDeviceCookieClearOptions = {
  ...trustedDeviceCookieOptions,
  maxAge: undefined,
} as const;

const verifyTurnstile = async (token: string) => {
  if (!env.turnstileSecretKey) return true;
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: env.turnstileSecretKey,
        response: token,
      }),
    },
  );
  if (!response.ok) return false;
  return Boolean(((await response.json()) as { success: boolean }).success);
};

const parseAuthToken = (req: AuthRequest) => {
  const authorizationToken = req.headers.authorization
    ?.replace("Bearer ", "")
    .trim();
  if (authorizationToken) return authorizationToken;
  const headerToken = req.get("x-temp-token")?.trim();
  if (headerToken) return headerToken;
  const bodyToken =
    req.body &&
    typeof req.body === "object" &&
    "tempToken" in req.body &&
    typeof (req.body as Record<string, unknown>).tempToken === "string"
      ? (req.body as Record<string, string>).tempToken.trim()
      : "";
  return bodyToken || null;
};
const decodeAuthToken = (token: string) =>
  jwt.verify(token, env.jwtSecret) as DecodedAuthToken;
const createPasswordResetToken = (payload: { userId: string }) =>
  jwt.sign({ ...payload, scope: "password_reset" }, env.jwtSecret, {
    expiresIn: "10m",
  });
const inferOtpPurposeFromScope = (
  scope: string | undefined,
): Extract<
  OtpPurpose,
  "buyer_register_phone" | "login_device" | "password_reset"
> | null => {
  if (scope === "otp_register") return "buyer_register_phone";
  if (scope === "otp_login_device") return "login_device";
  if (scope === "otp_password_reset") return "password_reset";
  return null;
};
const canUseExistingOtpFlow = (
  scope: string | undefined,
  purpose: OtpPurpose,
) => {
  if (purpose === "buyer_register_phone") return scope === "otp_register";
  if (purpose === "login_device") return scope === "otp_login_device";
  if (purpose === "password_reset") return scope === "otp_password_reset";
  return scope === "access";
};

const buildOtpLifecycleSnapshot = async (
  phoneRaw: string,
  purpose: OtpChallengePurpose,
): Promise<OtpLifecycleSnapshot> => {
  const phone = normalizePhone(phoneRaw);
  const latest = await prisma.phoneOtp.findFirst({
    where: {
      phone,
      purpose: (purpose === "login_device"
        ? "LOGIN_DEVICE"
        : "PASSWORD_RESET") as any,
    },
    orderBy: { createdAt: "desc" },
  });
  if (!latest) {
    return {
      requestId: null,
      otpRequest: null,
      resendAvailableAt: null,
      retryAfterSeconds: 0,
      challengeExpiresAt: null,
    };
  }

  const resendAvailableAtDate = new Date(
    latest.createdAt.getTime() + env.otpCooldownSeconds * 1000,
  );
  const retryAfterSeconds = Math.max(
    0,
    Math.ceil((resendAvailableAtDate.getTime() - Date.now()) / 1000),
  );
  const providerRequestId = latest.providerRequestId ?? null;

  return {
    requestId: providerRequestId,
    otpRequest: providerRequestId
      ? {
          requestId: providerRequestId,
          phone,
          provider: "plusofon",
          verificationType: "call_to_auth",
          callToAuthNumber:
            latest.providerPayload &&
            typeof latest.providerPayload === "object" &&
            !Array.isArray(latest.providerPayload) &&
            "callToAuthNumber" in latest.providerPayload &&
            typeof (latest.providerPayload as Record<string, unknown>)
              .callToAuthNumber === "string"
              ? (latest.providerPayload as Record<string, string>)
                  .callToAuthNumber || null
              : null,
        }
      : null,
    resendAvailableAt: resendAvailableAtDate.toISOString(),
    retryAfterSeconds,
    challengeExpiresAt: latest.expiresAt.toISOString(),
  };
};

const resolveOtpPurpose = (
  requestedPurpose: OtpPurpose | undefined,
  decoded: DecodedAuthToken | null | undefined,
):
  | { purpose: OtpPurpose; error?: undefined }
  | {
      purpose?: undefined;
      error: {
        status: number;
        body: { error: { code: string }; expectedPurpose?: string };
      };
    } => {
  const inferredPurpose = inferOtpPurposeFromScope(decoded?.scope);
  if (
    inferredPurpose &&
    requestedPurpose &&
    requestedPurpose !== inferredPurpose
  ) {
    return {
      error: {
        status: 409,
        body: {
          error: { code: "OTP_SCOPE_MISMATCH" },
          expectedPurpose: inferredPurpose,
        },
      },
    } as const;
  }
  return {
    purpose: inferredPurpose ?? requestedPurpose ?? "buyer_register_phone",
  } as const;
};

const buildOtpChallengeResponse = async (
  payload: OtpChallengePayload & {
    otpRequest: Awaited<ReturnType<typeof otpService.requestOtp>>;
  },
) => {
  const lifecycle = await buildOtpLifecycleSnapshot(
    payload.phone,
    payload.purpose,
  );
  const normalizedPhone = normalizePhone(payload.phone);
  const fallbackRequest =
    payload.otpRequest.ok &&
    "data" in payload.otpRequest &&
    payload.otpRequest.data
      ? payload.otpRequest.data
      : null;
  const resendAvailableAt =
    lifecycle.resendAvailableAt ??
    new Date(Date.now() + env.otpCooldownSeconds * 1000).toISOString();
  const challengeExpiresAt =
    lifecycle.challengeExpiresAt ??
    new Date(Date.now() + env.otpTtlMinutes * 60 * 1000).toISOString();
  const retryAfterSeconds = lifecycle.resendAvailableAt
    ? lifecycle.retryAfterSeconds
    : env.otpCooldownSeconds;
  const requestId = lifecycle.requestId ?? fallbackRequest?.requestId ?? null;
  const otpRequest = lifecycle.otpRequest ?? fallbackRequest;

  return {
    error: {
      code: payload.errorCode,
      message: payload.errorMessage,
    },
    requiresDeviceVerification: payload.purpose === "login_device",
    requiresPasswordResetVerification: payload.purpose === "password_reset",
    verificationMethod: "existing_otp_flow" as const,
    verificationScope:
      payload.purpose === "login_device"
        ? "otp_login_device"
        : "otp_password_reset",
    tempToken: payload.tempToken,
    phone: normalizedPhone,
    requestId,
    otpRequest,
    otpThrottled:
      payload.otpRequest.ok && payload.otpRequest.throttled === true,
    resendAvailableAt,
    retryAfterSeconds,
    challengeExpiresAt,
    currentActiveRequestId: requestId,
    user: payload.user,
  };
};
const isTurnstileRequiredForPurpose = (purpose: OtpPurpose) =>
  purpose === "buyer_register_phone";
const parsePlusofonWebhookPayload = (body: unknown) => {
  const source =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data =
    source.data && typeof source.data === "object"
      ? (source.data as Record<string, unknown>)
      : null;
  const merged = data ? { ...source, ...data } : source;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = merged[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  };
  return {
    requestId: pick("request_id", "requestId", "id", "key"),
    status: pick("status", "state"),
    phone: pick("phone", "phone_number", "recipient"),
  };
};
const clearSessionCookies = (res: Response, includeTrustedDevice = false) => {
  res.clearCookie(env.authRefreshCookieName, refreshCookieClearOptions);
  if (includeTrustedDevice)
    res.clearCookie(
      env.trustedDeviceCookieName,
      trustedDeviceCookieClearOptions,
    );
};
const finalizeAuthorizedSession = async (args: {
  res: Response;
  req: Request;
  user: Awaited<ReturnType<typeof userRepository.findById>>;
  trustedDeviceId?: string | null;
  rawTrustedDeviceToken?: string | null;
}) => {
  const tokens = await authService.issueTokens(
    args.user!,
    args.trustedDeviceId,
  );
  args.res.cookie(
    env.authRefreshCookieName,
    tokens.refreshToken,
    refreshCookieOptions,
  );
  if (args.rawTrustedDeviceToken)
    args.res.cookie(
      env.trustedDeviceCookieName,
      args.rawTrustedDeviceToken,
      trustedDeviceCookieOptions,
    );
  return args.res.json({
    data: {
      accessToken: tokens.accessToken,
      user: authService.getPublicUser(args.user!),
      session: {
        accessTokenTtlMinutes: env.authAccessTokenTtlMinutes,
        refreshTokenTtlDays: env.authRefreshTokenTtlDays,
        trustedDevice: Boolean(args.trustedDeviceId),
      },
    },
  });
};
const isTrustedDeviceFlowEnabled = () =>
  env.isProduction || env.authTrustedDeviceEnforced;
const normalizeLoginError = (error: unknown) => {
  if (!(error instanceof Error)) return error;
  if (error.message === "INVALID_CREDENTIALS") {
    return {
      status: 400,
      body: {
        error: {
          code: "INVALID_CREDENTIALS",
          message: "Неверный номер телефона или пароль",
        },
      },
    };
  }
  if (error.message === "INVALID_PHONE") {
    return {
      status: 400,
      body: {
        error: {
          code: "INVALID_PHONE",
          message: "Неверный номер телефона или пароль",
        },
      },
    };
  }
  return error;
};

const mapOtpRequestErrorStatus = (
  result: Extract<OtpRequestResult, { ok: false }>,
) =>
  result.error.code === "OTP_PROVIDER_TIMEOUT"
    ? 504
    : result.error.code === "OTP_REQUEST_FAILED"
      ? 500
      : 503;

const startExistingOtpChallenge = async (payload: OtpChallengePayload) => {
  const otpRequest = await otpService.requestOtp({
    phone: payload.phone,
    purpose: payload.purpose,
    ip: payload.req.ip,
    userAgent: payload.req.get("user-agent"),
  });
  if (!otpRequest.ok) {
    return {
      status: mapOtpRequestErrorStatus(otpRequest),
      body: { ok: false, error: otpRequest.error },
    };
  }

  return {
    status: payload.errorCode === "DEVICE_VERIFICATION_REQUIRED" ? 403 : 200,
    body: await buildOtpChallengeResponse({ ...payload, otpRequest }),
  };
};

const parseAndDecodeOtpToken = (req: AuthRequest, res: Response) => {
  const token = parseAuthToken(req);
  if (!token) {
    return {
      response: res.status(401).json({ error: { code: "UNAUTHORIZED" } }),
    };
  }

  try {
    return { decoded: decodeAuthToken(token) };
  } catch {
    return {
      response: res.status(401).json({ error: { code: "UNAUTHORIZED" } }),
    };
  }
};

type PurposeAccessResult =
  | {
      phone: string;
      user?: Awaited<ReturnType<typeof userRepository.findById>> | null;
      error?: undefined;
    }
  | {
      phone?: undefined;
      user?: undefined;
      error: { status: number; body: { error: { code: string } } };
    };

const verifyPurposeAccess = async (
  purpose: OtpPurpose,
  decoded: DecodedAuthToken | null | undefined,
  phoneRaw: string,
): Promise<PurposeAccessResult> => {
  if (!decoded || !canUseExistingOtpFlow(decoded.scope, purpose)) {
    return {
      error: {
        status: 401,
        body: {
          error: {
            code:
              purpose === "buyer_register_phone"
                ? "OTP_TOKEN_REQUIRED"
                : purpose === "login_device"
                  ? "DEVICE_LOGIN_TOKEN_REQUIRED"
                  : purpose === "password_reset"
                    ? "PASSWORD_RESET_TOKEN_REQUIRED"
                    : "UNAUTHORIZED",
          },
        },
      },
    };
  }

  const phone = normalizePhone(phoneRaw);
  if (purpose === "buyer_register_phone") {
    const pending = await prisma.pendingRegistration.findUnique({
      where: { id: decoded.registrationSessionId },
    });
    if (!pending || pending.usedAt || pending.expiresAt < new Date())
      return {
        error: {
          status: 401,
          body: { error: { code: "REGISTRATION_SESSION_INVALID" } },
        },
      };
    if (phone !== pending.phone)
      return {
        error: { status: 400, body: { error: { code: "PHONE_MISMATCH" } } },
      };
    return { phone };
  }

  const user = decoded.userId
    ? await userRepository.findById(decoded.userId)
    : null;
  if (!user?.phone)
    return { error: { status: 404, body: { error: { code: "NOT_FOUND" } } } };
  if (phone !== user.phone)
    return {
      error: { status: 400, body: { error: { code: "PHONE_MISMATCH" } } },
    };
  return { phone, user };
};

authRoutes.post("/register", authLimiter, async (req, res, next) => {
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
      payload.address,
    );
    const tempToken = authService.issueRegistrationOtpToken(result.pending.id);
    res.json({
      requiresOtp: true,
      tempToken,
      user: authService.getPublicUser({
        ...result.pending,
        id: result.pending.id,
      }),
    });
  } catch (error) {
    next(error);
  }
});

authRoutes.post("/login", authLimiter, async (req, res, next) => {
  try {
    await deviceTrustService.cleanupExpired();
    const payload = loginSchema.parse(req.body);
    if (!payload.phone)
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "phone is required" },
      });
    const phone = normalizePhone(payload.phone);
    const result = await authService.login({ phone }, payload.password);
    const user = result.user;

    if (!user.phoneVerifiedAt) {
      const tempToken = authService.issueOtpToken(user);
      return res.json({
        requiresOtp: true,
        tempToken,
        user: authService.getPublicUser(user),
      });
    }

    if (!isTrustedDeviceFlowEnabled()) {
      clearSessionCookies(res);
      return finalizeAuthorizedSession({ res, req, user });
    }

    const trustedDeviceToken = req.cookies?.[env.trustedDeviceCookieName] as
      | string
      | undefined;
    const trustedDevice = await deviceTrustService.findTrustedDeviceForRequest(
      user.id,
      trustedDeviceToken,
      req,
    );

    if (!trustedDevice) {
      if (!user.phone)
        return res.status(404).json({ error: { code: "NOT_FOUND" } });
      clearSessionCookies(res);
      const challenge = await startExistingOtpChallenge({
        phone: user.phone,
        purpose: "login_device",
        req,
        tempToken: authService.issueLoginDeviceOtpToken(user),
        errorCode: "DEVICE_VERIFICATION_REQUIRED",
        errorMessage:
          "Для входа с нового устройства нужно дополнительное подтверждение",
        user: authService.getPublicUser(user),
      });
      return res.status(challenge.status).json(challenge.body);
    }

    return finalizeAuthorizedSession({
      res,
      req,
      user,
      trustedDeviceId: trustedDevice.id,
    });
  } catch (error) {
    const normalized = normalizeLoginError(error);
    if (
      normalized &&
      typeof normalized === "object" &&
      "status" in normalized &&
      "body" in normalized
    ) {
      clearSessionCookies(res);
      return res.status(normalized.status as number).json(normalized.body);
    }
    next(error);
  }
});

authRoutes.post("/refresh", async (req, res, next) => {
  try {
    const token = req.cookies[env.authRefreshCookieName] as string | undefined;
    if (!token)
      return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
    const result = await authService.refresh(token);
    res.cookie(
      env.authRefreshCookieName,
      result.refreshToken,
      refreshCookieOptions,
    );
    return res.json({
      token: result.accessToken,
      refreshTokenRotated: true,
      refreshTokenTtlDays: env.authRefreshTokenTtlDays,
    });
  } catch (error) {
    clearSessionCookies(res);
    if (error instanceof Error && error.message === "INVALID_REFRESH")
      return res.status(401).json({
        error: { code: "INVALID_REFRESH", message: "Необходимо войти снова" },
      });
    return next(error);
  }
});

authRoutes.post("/logout", async (req, res, next) => {
  try {
    const token = req.cookies[env.authRefreshCookieName] as string | undefined;
    if (token) await authService.logout(token);
    clearSessionCookies(res, true);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

authRoutes.post(
  "/password-reset/request",
  otpRequestLimiter,
  async (req, res, next) => {
    try {
      const payload = passwordResetRequestSchema.parse(req.body);
      const phone = normalizePhone(payload.phone);
      const user = await userRepository.findByPhone(phone);
      if (!user) return res.status(404).json({ error: { code: "NOT_FOUND" } });
      clearSessionCookies(res, true);
      const challenge = await startExistingOtpChallenge({
        phone,
        purpose: "password_reset",
        req,
        tempToken: authService.issuePasswordResetOtpToken(user),
        errorCode: "PASSWORD_RESET_VERIFICATION_REQUIRED",
        errorMessage:
          "Для восстановления пароля нужно подтвердить номер телефона",
        user: authService.getPublicUser(user),
      });
      return res.status(challenge.status).json(challenge.body);
    } catch (error) {
      return next(error);
    }
  },
);
authRoutes.post(
  "/password-reset/resend",
  otpRequestLimiter,
  async (req, res, next) => {
    try {
      const payload = passwordResetResendSchema.parse(req.body);
      const parsed = parseAndDecodeOtpToken(req as AuthRequest, res);
      if (parsed.response) return parsed.response;
      const access = await verifyPurposeAccess(
        "password_reset",
        parsed.decoded,
        payload.phone,
      );
      if (access.error)
        return res.status(access.error.status).json(access.error.body);
      clearSessionCookies(res, true);
      const challenge = await startExistingOtpChallenge({
        phone: payload.phone,
        purpose: "password_reset",
        req,
        tempToken: parseAuthToken(req as AuthRequest)!,
        errorCode: "PASSWORD_RESET_VERIFICATION_REQUIRED",
        errorMessage:
          "Для восстановления пароля нужно подтвердить номер телефона",
        user: authService.getPublicUser(access.user!),
      });
      const status =
        "otpThrottled" in challenge.body && challenge.body.otpThrottled
          ? 429
          : challenge.status;
      return res.status(status).json(challenge.body);
    } catch (error) {
      return next(error);
    }
  },
);

authRoutes.post(
  "/password-reset/verify",
  otpVerifyLimiter,
  async (req, res, next) => {
    try {
      const payload = passwordResetVerifySchema.parse(req.body);
      const parsed = parseAndDecodeOtpToken(req as AuthRequest, res);
      if (parsed.response) return parsed.response;
      const access = await verifyPurposeAccess(
        "password_reset",
        parsed.decoded,
        payload.phone,
      );
      if (access.error)
        return res.status(access.error.status).json(access.error.body);
      await (payload.requestId
        ? otpService.verifyOtpByRequestId({
            phone: payload.phone,
            requestId: payload.requestId,
            purpose: "password_reset",
          })
        : otpService.verifyOtp({
            phone: payload.phone,
            code: payload.code!,
            purpose: "password_reset",
          }));
      return res.json({
        ok: true,
        resetToken: createPasswordResetToken({ userId: access.user!.id }),
      });
    } catch (error) {
      return next(error);
    }
  },
);
authRoutes.post(
  "/login/device/verify",
  otpVerifyLimiter,
  async (req, res, next) => {
    try {
      const payload = deviceLoginVerifySchema.parse(req.body);
      const parsed = parseAndDecodeOtpToken(req as AuthRequest, res);
      if (parsed.response) return parsed.response;
      const access = await verifyPurposeAccess(
        "login_device",
        parsed.decoded,
        payload.phone,
      );
      if (access.error)
        return res.status(access.error.status).json(access.error.body);
      const verification = payload.requestId
        ? await otpService.verifyOtpByRequestId({
            phone: payload.phone,
            requestId: payload.requestId,
            purpose: "login_device",
          })
        : await otpService.verifyOtp({
            phone: payload.phone,
            code: payload.code!,
            purpose: "login_device",
          });
      const user = access.user;
      if (!user)
        return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
      if (user.phone && user.phone !== verification.phone)
        return res.status(400).json({ error: { code: "PHONE_MISMATCH" } });
      const trusted = await deviceTrustService.trustCurrentDevice(user.id, req);
      return finalizeAuthorizedSession({
        res,
        req,
        user,
        trustedDeviceId: trusted.device.id,
        rawTrustedDeviceToken: trusted.token,
      });
    } catch (error) {
      return next(error);
    }
  },
);
authRoutes.post(
  "/password-reset/confirm",
  authLimiter,
  async (req, res, next) => {
    try {
      const payload = passwordResetConfirmSchema.parse(req.body);
      const decoded = jwt.verify(payload.token, env.jwtSecret) as {
        userId: string;
        scope?: string;
      };
      if (decoded.scope !== "password_reset")
        return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
      const user = await userRepository.findById(decoded.userId);
      if (!user) return res.status(404).json({ error: { code: "NOT_FOUND" } });
      const hashed = await bcrypt.hash(payload.password, 10);
      await userRepository.updatePasswordAndInvalidateSessions(user.id, hashed);
      clearSessionCookies(res, true);
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  },
);

authRoutes.post("/otp/request", otpRequestLimiter, async (req, res, next) => {
  try {
    const payload = otpRequestSchema.parse(req.body);
    const parsed = parseAndDecodeOtpToken(req as AuthRequest, res);
    if (parsed.response) return parsed.response;
    const resolvedPurpose = resolveOtpPurpose(
      payload.purpose as OtpPurpose | undefined,
      parsed.decoded,
    );
    if ("error" in resolvedPurpose)
      return res
        .status(resolvedPurpose.error.status)
        .json(resolvedPurpose.error.body);
    const purpose = resolvedPurpose.purpose;
    if (env.turnstileSecretKey && isTurnstileRequiredForPurpose(purpose)) {
      if (!payload.turnstileToken)
        return res.status(400).json({ error: { code: "TURNSTILE_REQUIRED" } });
      const verified = await verifyTurnstile(payload.turnstileToken);
      if (!verified)
        return res.status(400).json({ error: { code: "TURNSTILE_FAILED" } });
    }
    const access = await verifyPurposeAccess(
      purpose,
      parsed.decoded,
      payload.phone,
    );
    if (access.error)
      return res.status(access.error.status).json(access.error.body);
    const result = await otpService.requestOtp({
      phone: payload.phone,
      purpose,
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });
    if (!result.ok)
      return res
        .status(mapOtpRequestErrorStatus(result))
        .json({ ok: false, error: result.error });
    if (purpose === "login_device" || purpose === "password_reset") {
      const challengeBody = await buildOtpChallengeResponse({
        phone: payload.phone,
        purpose,
        req,
        tempToken: parseAuthToken(req as AuthRequest)!,
        user: authService.getPublicUser(access.user!),
        errorCode:
          purpose === "login_device"
            ? "DEVICE_VERIFICATION_REQUIRED"
            : "PASSWORD_RESET_VERIFICATION_REQUIRED",
        errorMessage:
          purpose === "login_device"
            ? "Для входа с нового устройства нужно дополнительное подтверждение"
            : "Для восстановления пароля нужно подтвердить номер телефона",
        otpRequest: result,
      });
      return res.status(result.throttled ? 429 : 200).json(challengeBody);
    }
    if (result.throttled)
      return res
        .status(429)
        .json({ ok: false, error: { code: "RATE_LIMITED" } });
    if (result.data) return res.json({ ok: true, data: result.data });
    return res.json({
      ok: true,
      data: null,
      devOtp: result.devOtp,
      delivery: result.delivery,
    });
  } catch (error) {
    return next(error);
  }
});
authRoutes.get("/otp/status/:requestId", async (req, res, next) => {
  try {
    const requestId = z.string().min(2).parse(req.params.requestId);
    const token = parseAuthToken(req as AuthRequest);
    if (!token)
      return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
    let decoded;
    try {
      decoded = decodeAuthToken(token);
    } catch {
      return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
    }
    if (
      !decoded.scope ||
      ![
        "otp_register",
        "access",
        "otp_login_device",
        "otp_password_reset",
      ].includes(decoded.scope)
    )
      return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
    const status = await otpService.getOtpStatusByRequestId(requestId);
    return res.json({ ok: true, data: status });
  } catch (error) {
    return next(error);
  }
});
authRoutes.post("/otp/verify", otpVerifyLimiter, async (req, res, next) => {
  try {
    const payload = otpVerifySchema.parse(req.body);
    const parsed = parseAndDecodeOtpToken(req as AuthRequest, res);
    if (parsed.response) return parsed.response;
    const resolvedPurpose = resolveOtpPurpose(
      payload.purpose as OtpPurpose | undefined,
      parsed.decoded,
    );
    if ("error" in resolvedPurpose)
      return res
        .status(resolvedPurpose.error.status)
        .json(resolvedPurpose.error.body);
    const purpose = resolvedPurpose.purpose;
    const access = await verifyPurposeAccess(
      purpose,
      parsed.decoded,
      payload.phone,
    );
    if (access.error)
      return res.status(access.error.status).json(access.error.body);
    const verification = payload.requestId
      ? await otpService.verifyOtpByRequestId({
          phone: payload.phone,
          requestId: payload.requestId,
          purpose,
        })
      : await otpService.verifyOtp({
          phone: payload.phone,
          code: payload.code!,
          purpose,
        });
    const { phone } = verification;
    let user;
    if (purpose === "buyer_register_phone") {
      const registrationSessionId = parsed.decoded?.registrationSessionId;
      if (!registrationSessionId)
        return res.status(401).json({ error: { code: "OTP_TOKEN_REQUIRED" } });
      user = (
        await authService.completeRegistration(registrationSessionId, phone)
      ).user;
    } else {
      const userId = parsed.decoded?.userId;
      if (!userId)
        return res.status(401).json({
          error: {
            code:
              purpose === "password_reset"
                ? "PASSWORD_RESET_TOKEN_REQUIRED"
                : "OTP_TOKEN_REQUIRED",
          },
        });
      user = await userRepository.findById(userId);
      if (!user)
        return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
      if (user.phone && user.phone !== phone)
        return res.status(400).json({ error: { code: "PHONE_MISMATCH" } });
      if (!user.phone) {
        const existingPhone = await userRepository.findByPhone(phone);
        if (existingPhone && existingPhone.id !== user.id)
          return res.status(409).json({ error: { code: "PHONE_EXISTS" } });
      }
      if (!user.phoneVerifiedAt || user.phone !== phone)
        user = await userRepository.updateProfile(user.id, {
          phone,
          phoneVerifiedAt: new Date(),
        });
    }
    if (purpose === "login_device") {
      const trusted = await deviceTrustService.trustCurrentDevice(user.id, req);
      return finalizeAuthorizedSession({
        res,
        req,
        user,
        trustedDeviceId: trusted.device.id,
        rawTrustedDeviceToken: trusted.token,
      });
    }
    if (purpose === "password_reset") {
      return res.json({
        ok: true,
        resetToken: createPasswordResetToken({ userId: user.id }),
      });
    }
    return finalizeAuthorizedSession({ res, req, user });
  } catch (error) {
    return next(error);
  }
});

authRoutes.post("/otp/telegram/callback", async (req, res, next) => {
  try {
    const timestamp = req.get("X-Request-Timestamp");
    const signature = req.get("X-Request-Signature");
    const rawBody =
      (req as Request & { rawBody?: string }).rawBody ??
      JSON.stringify(req.body ?? {});
    if (!timestamp || !signature)
      return res
        .status(400)
        .json({ error: { code: "INVALID_SIGNATURE_HEADERS" } });
    const valid = otpService.validateTelegramCallbackSignature({
      timestamp,
      signature,
      rawBody,
    });
    if (!valid)
      return res.status(401).json({ error: { code: "INVALID_SIGNATURE" } });
    const body = req.body as {
      request_id?: string;
      payload?: string;
      status?: string;
    };
    const mappedStatus = otpService.mapIncomingDeliveryStatus(
      body.status ?? "",
    );
    if (!mappedStatus) return res.status(200).json({ ok: true, ignored: true });
    await otpService.updateDeliveryStatus({
      providerRequestId: body.request_id,
      providerPayload: body.payload,
      deliveryStatus: mappedStatus,
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});
authRoutes.post("/otp/plusofon/webhook", async (req, res, next) => {
  try {
    if (env.plusofonWebhookSecret) {
      const headerSecret =
        req.get("X-Webhook-Secret") ?? req.get("X-Plusofon-Secret") ?? "";
      if (!headerSecret || headerSecret !== env.plusofonWebhookSecret)
        return res.status(401).json({ error: { code: "INVALID_SIGNATURE" } });
    }
    const body = req.body as unknown;
    const parsed = parsePlusofonWebhookPayload(body);
    if (!parsed.requestId)
      return res.status(200).json({ ok: true, ignored: true });
    const effectiveStatus =
      parsed.status ?? (parsed.phone ? "verified" : "pending");
    const mapped = otpService.mapPlusofonStatus(effectiveStatus);
    if (mapped !== "pending")
      await otpService.markOtpVerifiedByProviderRequestId({
        requestId: parsed.requestId,
        status: mapped,
        providerPayload: body,
      });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

authRoutes.get("/me", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const user = await userRepository.findById(req.user!.userId);
    if (!user) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    return res.json({
      data: {
        id: user.id,
        name: user.name,
        fullName: user.fullName,
        role: user.role,
        email: user.email,
      },
    });
  } catch (error) {
    return next(error);
  }
});
authRoutes.patch("/me", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const payload = updateProfileSchema.parse(req.body);
    const existingUser = await userRepository.findById(req.user!.userId);
    if (!existingUser)
      return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (payload.email) {
      const existing = await userRepository.findByEmail(payload.email);
      if (existing && existing.id !== req.user!.userId)
        return res.status(400).json({ error: { code: "EMAIL_EXISTS" } });
    }
    let phone = payload.phone;
    let phoneVerifiedAt = existingUser.phoneVerifiedAt;
    if (payload.phone) {
      phone = normalizePhone(payload.phone);
      const existingPhone = await userRepository.findByPhone(phone);
      if (existingPhone && existingPhone.id !== req.user!.userId)
        return res.status(400).json({ error: { code: "PHONE_EXISTS" } });
      if (existingUser.phone !== phone) phoneVerifiedAt = null;
    }
    const updated = await userRepository.updateProfile(req.user!.userId, {
      name: payload.name,
      email: payload.email,
      phone: payload.phone ? (phone ?? null) : existingUser.phone,
      phoneVerifiedAt: payload.phone
        ? (phoneVerifiedAt ?? null)
        : existingUser.phoneVerifiedAt,
      address: payload.address ?? null,
      fullName: payload.fullName ?? existingUser.fullName,
    });
    return res.json({ data: authService.getPublicUser(updated) });
  } catch (error) {
    return next(error);
  }
});
