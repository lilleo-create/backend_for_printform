"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const authService_1 = require("../services/authService");
const authMiddleware_1 = require("../middleware/authMiddleware");
const userRepository_1 = require("../repositories/userRepository");
const env_1 = require("../config/env");
const otpService_1 = require("../services/otpService");
const phone_1 = require("../utils/phone");
const rateLimiters_1 = require("../middleware/rateLimiters");
const prisma_1 = require("../lib/prisma");
const deviceTrustService_1 = require("../services/deviceTrustService");
exports.authRoutes = (0, express_1.Router)();
const loginIdentifierSchema = zod_1.z
    .object({
    phone: zod_1.z.string().min(5).optional(),
    email: zod_1.z.string().trim().min(5).optional(),
    password: zod_1.z.string().min(6),
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
const loginFieldsSchema = zod_1.z.object({
    email: zod_1.z.string().email().optional(),
    phone: zod_1.z.string().min(5).optional(),
    password: zod_1.z.string().min(6),
});
const fullNameSchema = zod_1.z
    .string()
    .trim()
    .min(3)
    .max(120)
    .regex(/^[A-Za-zА-Яа-яЁё\-\s]+$/, "Допустимы буквы, пробел и дефис")
    .refine((value) => value.split(/\s+/).filter(Boolean).length >= 2, "Введите ФИО минимум из двух слов");
const registerSchema = loginFieldsSchema
    .omit({ phone: true, email: true })
    .extend({
    email: zod_1.z.string().email(),
    name: zod_1.z.string().trim().min(2),
    fullName: fullNameSchema,
    phone: zod_1.z.string().min(5),
    address: zod_1.z.string().min(3).optional(),
    privacyAccepted: zod_1.z.boolean().optional(),
    role: zod_1.z.enum(["BUYER", "SELLER"]).optional(),
});
const updateProfileSchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(2).optional(),
    fullName: zod_1.z
        .string()
        .trim()
        .min(2)
        .max(120)
        .transform((value) => value.replace(/\s+/g, " "))
        .optional(),
    email: zod_1.z.string().email().optional(),
    phone: zod_1.z.string().min(5).optional(),
    address: zod_1.z.string().min(3).optional(),
});
const otpPurposeSchema = zod_1.z.enum([
    "buyer_register_phone",
    "buyer_change_phone",
    "buyer_sensitive_action",
    "seller_connect_phone",
    "seller_change_payout_details",
    "seller_payout_settings_verify",
    "login_device",
    "password_reset",
]);
const otpRequestSchema = zod_1.z.object({
    phone: zod_1.z.string().min(5),
    purpose: otpPurposeSchema.optional(),
    turnstileToken: zod_1.z.string().optional(),
});
const otpVerifySchema = zod_1.z
    .object({
    phone: zod_1.z.string().min(5).optional(),
    code: zod_1.z.string().min(4).optional(),
    requestId: zod_1.z.string().min(2).optional(),
    purpose: otpPurposeSchema.optional(),
    tempToken: zod_1.z.string().min(10).optional(),
})
    .refine((value) => Boolean(value.code || value.requestId), {
    message: "code or requestId is required",
    path: ["code"],
})
    .refine((value) => Boolean(value.requestId || value.phone), {
    message: "phone is required when requestId is missing",
    path: ["phone"],
});
const passwordResetRequestSchema = zod_1.z.object({ phone: zod_1.z.string().min(5) });
const passwordResetVerifySchema = zod_1.z
    .object({
    phone: zod_1.z.string().min(5).optional(),
    code: zod_1.z.string().min(4).optional(),
    requestId: zod_1.z.string().min(2).optional(),
    tempToken: zod_1.z.string().min(10).optional(),
})
    .refine((value) => Boolean(value.code || value.requestId), {
    message: "code or requestId is required",
    path: ["code"],
})
    .refine((value) => Boolean(value.requestId || value.phone), {
    message: "phone is required when requestId is missing",
    path: ["phone"],
});
const deviceLoginVerifySchema = zod_1.z
    .object({
    phone: zod_1.z.string().min(5).optional(),
    code: zod_1.z.string().min(4).optional(),
    requestId: zod_1.z.string().min(2).optional(),
    tempToken: zod_1.z.string().min(10).optional(),
})
    .refine((value) => Boolean(value.code || value.requestId), {
    message: "code or requestId is required",
    path: ["code"],
})
    .refine((value) => Boolean(value.requestId || value.phone), {
    message: "phone is required when requestId is missing",
    path: ["phone"],
});
const passwordResetConfirmSchema = zod_1.z.object({
    token: zod_1.z.string().min(10),
    password: zod_1.z.string().min(6),
});
const passwordResetResendSchema = zod_1.z.object({
    phone: zod_1.z.string().min(5),
    tempToken: zod_1.z.string().min(10).optional(),
});
const refreshCookieOptions = authService_1.authService.getRefreshCookieOptions();
const trustedDeviceCookieOptions = deviceTrustService_1.deviceTrustService.getCookieOptions();
const refreshCookieClearOptions = {
    ...refreshCookieOptions,
    maxAge: undefined,
};
const trustedDeviceCookieClearOptions = {
    ...trustedDeviceCookieOptions,
    maxAge: undefined,
};
const verifyTurnstile = async (token) => {
    if (!env_1.env.turnstileSecretKey)
        return true;
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            secret: env_1.env.turnstileSecretKey,
            response: token,
        }),
    });
    if (!response.ok)
        return false;
    return Boolean((await response.json()).success);
};
const parseAuthToken = (req) => {
    const authorizationToken = req.headers.authorization
        ?.replace("Bearer ", "")
        .trim();
    if (authorizationToken)
        return authorizationToken;
    const headerToken = req.get("x-temp-token")?.trim();
    if (headerToken)
        return headerToken;
    const bodyToken = req.body &&
        typeof req.body === "object" &&
        "tempToken" in req.body &&
        typeof req.body.tempToken === "string"
        ? req.body.tempToken.trim()
        : "";
    return bodyToken || null;
};
const decodeAuthToken = (token) => jsonwebtoken_1.default.verify(token, env_1.env.jwtSecret);
const createPasswordResetToken = (payload) => jsonwebtoken_1.default.sign({ ...payload, scope: "password_reset" }, env_1.env.jwtSecret, {
    expiresIn: "10m",
});
const inferOtpPurposeFromScope = (scope) => {
    if (scope === "otp_register")
        return "buyer_register_phone";
    if (scope === "otp_login_device")
        return "login_device";
    if (scope === "otp_password_reset")
        return "password_reset";
    return null;
};
const canUseExistingOtpFlow = (scope, purpose) => {
    if (purpose === "buyer_register_phone")
        return scope === "otp_register";
    if (purpose === "login_device")
        return scope === "otp_login_device";
    if (purpose === "password_reset")
        return scope === "otp_password_reset";
    return scope === "access";
};
const buildOtpLifecycleSnapshot = async (phoneRaw, purpose) => {
    const phone = (0, phone_1.normalizePhone)(phoneRaw);
    const latest = await prisma_1.prisma.phoneOtp.findFirst({
        where: {
            phone,
            purpose: (purpose === "login_device"
                ? "LOGIN_DEVICE"
                : "PASSWORD_RESET"),
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
    const resendAvailableAtDate = new Date(latest.createdAt.getTime() + env_1.env.otpCooldownSeconds * 1000);
    const retryAfterSeconds = Math.max(0, Math.ceil((resendAvailableAtDate.getTime() - Date.now()) / 1000));
    const providerRequestId = latest.providerRequestId ?? null;
    return {
        requestId: providerRequestId,
        otpRequest: providerRequestId
            ? {
                requestId: providerRequestId,
                phone,
                provider: "plusofon",
                verificationType: "call_to_auth",
                callToAuthNumber: latest.providerPayload &&
                    typeof latest.providerPayload === "object" &&
                    !Array.isArray(latest.providerPayload) &&
                    "callToAuthNumber" in latest.providerPayload &&
                    typeof latest.providerPayload
                        .callToAuthNumber === "string"
                    ? latest.providerPayload
                        .callToAuthNumber || null
                    : null,
            }
            : null,
        resendAvailableAt: resendAvailableAtDate.toISOString(),
        retryAfterSeconds,
        challengeExpiresAt: latest.expiresAt.toISOString(),
    };
};
const resolveOtpPurpose = (requestedPurpose, decoded) => {
    const inferredPurpose = inferOtpPurposeFromScope(decoded?.scope);
    if (inferredPurpose &&
        requestedPurpose &&
        requestedPurpose !== inferredPurpose) {
        return {
            ok: false,
            error: {
                status: 409,
                body: {
                    error: { code: "OTP_SCOPE_MISMATCH" },
                    expectedPurpose: inferredPurpose,
                },
            },
        };
    }
    return {
        ok: true,
        purpose: inferredPurpose ?? requestedPurpose ?? "buyer_register_phone",
    };
};
const buildOtpChallengeResponse = async (payload) => {
    const lifecycle = await buildOtpLifecycleSnapshot(payload.phone, payload.purpose);
    const normalizedPhone = (0, phone_1.normalizePhone)(payload.phone);
    const fallbackRequest = payload.otpRequest.ok &&
        "data" in payload.otpRequest &&
        payload.otpRequest.data
        ? payload.otpRequest.data
        : null;
    const resendAvailableAt = lifecycle.resendAvailableAt ??
        new Date(Date.now() + env_1.env.otpCooldownSeconds * 1000).toISOString();
    const challengeExpiresAt = lifecycle.challengeExpiresAt ??
        new Date(Date.now() + env_1.env.otpTtlMinutes * 60 * 1000).toISOString();
    const retryAfterSeconds = lifecycle.resendAvailableAt
        ? lifecycle.retryAfterSeconds
        : env_1.env.otpCooldownSeconds;
    const requestId = lifecycle.requestId ?? fallbackRequest?.requestId ?? null;
    const otpRequest = lifecycle.otpRequest ?? fallbackRequest;
    return {
        error: {
            code: payload.errorCode,
            message: payload.errorMessage,
        },
        requiresDeviceVerification: payload.purpose === "login_device",
        requiresPasswordResetVerification: payload.purpose === "password_reset",
        verificationMethod: "existing_otp_flow",
        verificationScope: payload.purpose === "login_device"
            ? "otp_login_device"
            : "otp_password_reset",
        tempToken: payload.tempToken,
        phone: normalizedPhone,
        requestId,
        otpRequest,
        otpThrottled: payload.otpRequest.ok && payload.otpRequest.throttled === true,
        resendAvailableAt,
        retryAfterSeconds,
        challengeExpiresAt,
        currentActiveRequestId: requestId,
        user: payload.user,
    };
};
const isTurnstileRequiredForPurpose = (purpose) => purpose === "buyer_register_phone";
const parsePlusofonWebhookPayload = (body) => {
    const source = body && typeof body === "object" ? body : {};
    const data = source.data && typeof source.data === "object"
        ? source.data
        : null;
    const merged = data ? { ...source, ...data } : source;
    const pick = (...keys) => {
        for (const key of keys) {
            const value = merged[key];
            if (typeof value === "string" && value.trim())
                return value.trim();
        }
        return null;
    };
    return {
        requestId: pick("request_id", "requestId", "id", "key"),
        status: pick("status", "state"),
        phone: pick("phone", "phone_number", "recipient"),
    };
};
const clearSessionCookies = (res, includeTrustedDevice = false) => {
    res.clearCookie(env_1.env.authRefreshCookieName, refreshCookieClearOptions);
    if (includeTrustedDevice)
        res.clearCookie(env_1.env.trustedDeviceCookieName, trustedDeviceCookieClearOptions);
};
const finalizeAuthorizedSession = async (args) => {
    const tokens = await authService_1.authService.issueTokens(args.user, args.trustedDeviceId);
    args.res.cookie(env_1.env.authRefreshCookieName, tokens.refreshToken, refreshCookieOptions);
    if (args.rawTrustedDeviceToken)
        args.res.cookie(env_1.env.trustedDeviceCookieName, args.rawTrustedDeviceToken, trustedDeviceCookieOptions);
    return args.res.json({
        data: {
            accessToken: tokens.accessToken,
            user: authService_1.authService.getPublicUser(args.user),
            session: {
                accessTokenTtlMinutes: env_1.env.authAccessTokenTtlMinutes,
                refreshTokenTtlDays: env_1.env.authRefreshTokenTtlDays,
                trustedDevice: Boolean(args.trustedDeviceId),
            },
        },
    });
};
const isTrustedDeviceFlowEnabled = () => env_1.env.isProduction || env_1.env.authTrustedDeviceEnforced;
const normalizeLoginError = (error) => {
    if (!(error instanceof Error))
        return error;
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
const mapOtpRequestErrorStatus = (result) => result.error.code === "OTP_PROVIDER_TIMEOUT"
    ? 504
    : result.error.code === "OTP_REQUEST_FAILED"
        ? 500
        : 503;
const startExistingOtpChallenge = async (payload) => {
    const otpRequest = await otpService_1.otpService.requestOtp({
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
const parseAndDecodeOtpToken = (req, res) => {
    const token = parseAuthToken(req);
    if (!token) {
        return {
            response: res.status(401).json({ error: { code: "UNAUTHORIZED" } }),
        };
    }
    try {
        return { decoded: decodeAuthToken(token) };
    }
    catch {
        return {
            response: res.status(401).json({ error: { code: "UNAUTHORIZED" } }),
        };
    }
};
const verifyPurposeAccess = async (purpose, decoded, phoneRaw) => {
    if (!decoded || !canUseExistingOtpFlow(decoded.scope, purpose)) {
        return {
            error: {
                status: 401,
                body: {
                    error: {
                        code: purpose === "buyer_register_phone"
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
    const phone = phoneRaw ? (0, phone_1.normalizePhone)(phoneRaw) : null;
    if (purpose === "buyer_register_phone") {
        const pending = await prisma_1.prisma.pendingRegistration.findUnique({
            where: { id: decoded.registrationSessionId },
        });
        if (!pending || pending.usedAt || pending.expiresAt < new Date())
            return {
                error: {
                    status: 401,
                    body: { error: { code: "REGISTRATION_SESSION_INVALID" } },
                },
            };
        if (!phone)
            return {
                error: { status: 400, body: { error: { code: "PHONE_REQUIRED" } } },
            };
        if (phone !== pending.phone)
            return {
                error: { status: 400, body: { error: { code: "PHONE_MISMATCH" } } },
            };
        return { phone };
    }
    const user = decoded.userId
        ? await userRepository_1.userRepository.findById(decoded.userId)
        : null;
    if (!user?.phone)
        return { error: { status: 404, body: { error: { code: "NOT_FOUND" } } } };
    if (!phone)
        return { phone: user.phone, user };
    if (phone !== user.phone) {
        console.info("[AUTH][OTP_VERIFY][PHONE_MISMATCH]", {
            purpose,
            userId: user.id,
            storedUserPhone: user.phone,
            incomingPhoneRaw: phoneRaw,
            incomingPhoneNormalized: phone,
        });
        return {
            error: { status: 400, body: { error: { code: "PHONE_MISMATCH" } } },
        };
    }
    return { phone, user };
};
exports.authRoutes.post("/register", rateLimiters_1.authLimiter, async (req, res, next) => {
    try {
        const payload = registerSchema.parse(req.body);
        const phone = (0, phone_1.normalizePhone)(payload.phone);
        const result = await authService_1.authService.startRegistration(payload.name, payload.fullName, payload.email, payload.password, payload.role, phone, payload.address);
        const tempToken = authService_1.authService.issueRegistrationOtpToken(result.pending.id);
        res.json({
            requiresOtp: true,
            tempToken,
            user: authService_1.authService.getPublicUser({
                ...result.pending,
                id: result.pending.id,
            }),
        });
    }
    catch (error) {
        next(error);
    }
});
exports.authRoutes.post("/login", rateLimiters_1.authLimiter, async (req, res, next) => {
    try {
        await deviceTrustService_1.deviceTrustService.cleanupExpired();
        const payload = loginSchema.parse(req.body);
        if (!payload.phone)
            return res.status(400).json({
                error: { code: "VALIDATION_ERROR", message: "phone is required" },
            });
        const phone = (0, phone_1.normalizePhone)(payload.phone);
        const result = await authService_1.authService.login({ phone }, payload.password);
        const user = result.user;
        if (!user.phoneVerifiedAt) {
            const tempToken = authService_1.authService.issueOtpToken(user);
            return res.json({
                requiresOtp: true,
                tempToken,
                user: authService_1.authService.getPublicUser(user),
            });
        }
        if (!isTrustedDeviceFlowEnabled()) {
            clearSessionCookies(res);
            return finalizeAuthorizedSession({ res, req, user });
        }
        const trustedDeviceToken = req.cookies?.[env_1.env.trustedDeviceCookieName];
        const trustedDevice = await deviceTrustService_1.deviceTrustService.findTrustedDeviceForRequest(user.id, trustedDeviceToken, req);
        if (!trustedDevice) {
            if (!user.phone)
                return res.status(404).json({ error: { code: "NOT_FOUND" } });
            clearSessionCookies(res);
            const challenge = await startExistingOtpChallenge({
                phone: user.phone,
                purpose: "login_device",
                req,
                tempToken: authService_1.authService.issueLoginDeviceOtpToken(user),
                errorCode: "DEVICE_VERIFICATION_REQUIRED",
                errorMessage: "Для входа с нового устройства нужно дополнительное подтверждение",
                user: authService_1.authService.getPublicUser(user),
            });
            return res.status(challenge.status).json(challenge.body);
        }
        return finalizeAuthorizedSession({
            res,
            req,
            user,
            trustedDeviceId: trustedDevice.id,
        });
    }
    catch (error) {
        const normalized = normalizeLoginError(error);
        if (normalized &&
            typeof normalized === "object" &&
            "status" in normalized &&
            "body" in normalized) {
            clearSessionCookies(res);
            return res.status(normalized.status).json(normalized.body);
        }
        next(error);
    }
});
exports.authRoutes.post("/refresh", async (req, res, next) => {
    try {
        const token = req.cookies[env_1.env.authRefreshCookieName];
        if (!token)
            return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
        const result = await authService_1.authService.refresh(token);
        res.cookie(env_1.env.authRefreshCookieName, result.refreshToken, refreshCookieOptions);
        return res.json({
            token: result.accessToken,
            accessToken: result.accessToken,
            refreshTokenRotated: true,
            refreshTokenTtlDays: env_1.env.authRefreshTokenTtlDays,
            accessTokenTtlMinutes: env_1.env.authAccessTokenTtlMinutes,
        });
    }
    catch (error) {
        clearSessionCookies(res);
        if (error instanceof Error && error.message === "INVALID_REFRESH")
            return res.status(401).json({
                error: { code: "INVALID_REFRESH", message: "Необходимо войти снова" },
            });
        return next(error);
    }
});
exports.authRoutes.post("/logout", async (req, res, next) => {
    try {
        const token = req.cookies[env_1.env.authRefreshCookieName];
        if (token)
            await authService_1.authService.logout(token);
        clearSessionCookies(res, true);
        res.json({ success: true });
    }
    catch (error) {
        next(error);
    }
});
exports.authRoutes.post("/password-reset/request", rateLimiters_1.otpRequestLimiter, async (req, res, next) => {
    try {
        const payload = passwordResetRequestSchema.parse(req.body);
        const phone = (0, phone_1.normalizePhone)(payload.phone);
        const user = await userRepository_1.userRepository.findByPhone(phone);
        if (!user)
            return res.status(404).json({ error: { code: "NOT_FOUND" } });
        clearSessionCookies(res, true);
        const challenge = await startExistingOtpChallenge({
            phone,
            purpose: "password_reset",
            req,
            tempToken: authService_1.authService.issuePasswordResetOtpToken(user),
            errorCode: "PASSWORD_RESET_VERIFICATION_REQUIRED",
            errorMessage: "Для восстановления пароля нужно подтвердить номер телефона",
            user: authService_1.authService.getPublicUser(user),
        });
        return res.status(challenge.status).json(challenge.body);
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.post("/password-reset/resend", rateLimiters_1.otpRequestLimiter, async (req, res, next) => {
    try {
        const payload = passwordResetResendSchema.parse(req.body);
        const parsed = parseAndDecodeOtpToken(req, res);
        if (parsed.response)
            return parsed.response;
        const access = await verifyPurposeAccess("password_reset", parsed.decoded, payload.phone);
        if (access.error)
            return res.status(access.error.status).json(access.error.body);
        clearSessionCookies(res, true);
        const challenge = await startExistingOtpChallenge({
            phone: payload.phone,
            purpose: "password_reset",
            req,
            tempToken: parseAuthToken(req),
            errorCode: "PASSWORD_RESET_VERIFICATION_REQUIRED",
            errorMessage: "Для восстановления пароля нужно подтвердить номер телефона",
            user: authService_1.authService.getPublicUser(access.user),
        });
        const status = "otpThrottled" in challenge.body && challenge.body.otpThrottled
            ? 429
            : challenge.status;
        return res.status(status).json(challenge.body);
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.post("/password-reset/verify", rateLimiters_1.otpVerifyLimiter, async (req, res, next) => {
    try {
        const payload = passwordResetVerifySchema.parse(req.body);
        const parsed = parseAndDecodeOtpToken(req, res);
        if (parsed.response)
            return parsed.response;
        const access = await verifyPurposeAccess("password_reset", parsed.decoded, payload.phone);
        if (access.error)
            return res.status(access.error.status).json(access.error.body);
        await (payload.requestId
            ? otpService_1.otpService.verifyOtpByRequestId({
                phone: payload.phone,
                requestId: payload.requestId,
                purpose: "password_reset",
            })
            : otpService_1.otpService.verifyOtp({
                phone: payload.phone,
                code: payload.code,
                purpose: "password_reset",
            }));
        return res.json({
            ok: true,
            resetToken: createPasswordResetToken({ userId: access.user.id }),
        });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.post("/login/device/verify", rateLimiters_1.otpVerifyLimiter, async (req, res, next) => {
    try {
        const payload = deviceLoginVerifySchema.parse(req.body);
        const parsed = parseAndDecodeOtpToken(req, res);
        if (parsed.response)
            return parsed.response;
        const access = await verifyPurposeAccess("login_device", parsed.decoded, payload.phone);
        if (access.error)
            return res.status(access.error.status).json(access.error.body);
        const verification = payload.requestId
            ? await otpService_1.otpService.verifyOtpByRequestId({
                phone: payload.phone,
                requestId: payload.requestId,
                purpose: "login_device",
            })
            : await otpService_1.otpService.verifyOtp({
                phone: payload.phone,
                code: payload.code,
                purpose: "login_device",
            });
        const user = access.user;
        if (!user)
            return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
        if (user.phone && user.phone !== verification.phone)
            return res.status(400).json({ error: { code: "PHONE_MISMATCH" } });
        const trusted = await deviceTrustService_1.deviceTrustService.trustCurrentDevice(user.id, req);
        return finalizeAuthorizedSession({
            res,
            req,
            user,
            trustedDeviceId: trusted.device.id,
            rawTrustedDeviceToken: trusted.token,
        });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.post("/password-reset/confirm", rateLimiters_1.authLimiter, async (req, res, next) => {
    try {
        const payload = passwordResetConfirmSchema.parse(req.body);
        const decoded = jsonwebtoken_1.default.verify(payload.token, env_1.env.jwtSecret);
        if (decoded.scope !== "password_reset")
            return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
        const user = await userRepository_1.userRepository.findById(decoded.userId);
        if (!user)
            return res.status(404).json({ error: { code: "NOT_FOUND" } });
        const hashed = await bcryptjs_1.default.hash(payload.password, 10);
        await userRepository_1.userRepository.updatePasswordAndInvalidateSessions(user.id, hashed);
        clearSessionCookies(res, true);
        return res.json({ ok: true });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.post("/otp/request", rateLimiters_1.otpRequestLimiter, async (req, res, next) => {
    try {
        const payload = otpRequestSchema.parse(req.body);
        const parsed = parseAndDecodeOtpToken(req, res);
        if (parsed.response)
            return parsed.response;
        const resolvedPurpose = resolveOtpPurpose(payload.purpose, parsed.decoded);
        if (!resolvedPurpose.ok) {
            return res
                .status(resolvedPurpose.error.status)
                .json(resolvedPurpose.error.body);
        }
        const purpose = resolvedPurpose.purpose;
        if (env_1.env.turnstileSecretKey && isTurnstileRequiredForPurpose(purpose)) {
            if (!payload.turnstileToken)
                return res.status(400).json({ error: { code: "TURNSTILE_REQUIRED" } });
            const verified = await verifyTurnstile(payload.turnstileToken);
            if (!verified)
                return res.status(400).json({ error: { code: "TURNSTILE_FAILED" } });
        }
        const access = await verifyPurposeAccess(purpose, parsed.decoded, payload.phone);
        if (access.error)
            return res.status(access.error.status).json(access.error.body);
        const result = await otpService_1.otpService.requestOtp({
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
                tempToken: parseAuthToken(req),
                user: authService_1.authService.getPublicUser(access.user),
                errorCode: purpose === "login_device"
                    ? "DEVICE_VERIFICATION_REQUIRED"
                    : "PASSWORD_RESET_VERIFICATION_REQUIRED",
                errorMessage: purpose === "login_device"
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
        if (result.data)
            return res.json({ ok: true, data: result.data });
        return res.json({
            ok: true,
            data: null,
            devOtp: result.devOtp,
            delivery: result.delivery,
        });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.get("/otp/status/:requestId", async (req, res, next) => {
    try {
        const requestId = zod_1.z.string().min(2).parse(req.params.requestId);
        const token = parseAuthToken(req);
        if (!token)
            return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
        let decoded;
        try {
            decoded = decodeAuthToken(token);
        }
        catch {
            return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
        }
        if (!decoded.scope ||
            ![
                "otp_register",
                "access",
                "otp_login_device",
                "otp_password_reset",
            ].includes(decoded.scope))
            return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
        const status = await otpService_1.otpService.getOtpStatusByRequestId(requestId);
        return res.json({ ok: true, data: status });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.post("/otp/verify", rateLimiters_1.otpVerifyLimiter, async (req, res, next) => {
    try {
        const payload = otpVerifySchema.parse(req.body);
        const parsed = parseAndDecodeOtpToken(req, res);
        if (parsed.response)
            return parsed.response;
        const resolvedPurpose = resolveOtpPurpose(payload.purpose, parsed.decoded);
        if (!resolvedPurpose.ok) {
            return res
                .status(resolvedPurpose.error.status)
                .json(resolvedPurpose.error.body);
        }
        const purpose = resolvedPurpose.purpose;
        const access = await verifyPurposeAccess(purpose, parsed.decoded, payload.phone);
        if (access.error)
            return res.status(access.error.status).json(access.error.body);
        const verification = payload.requestId
            ? await otpService_1.otpService.verifyOtpByRequestId({
                phone: payload.phone,
                requestId: payload.requestId,
                purpose,
            })
            : await otpService_1.otpService.verifyOtp({
                phone: payload.phone,
                code: payload.code,
                purpose,
            });
        const { phone } = verification;
        let user;
        if (purpose === "buyer_register_phone") {
            const registrationSessionId = parsed.decoded?.registrationSessionId;
            if (!registrationSessionId)
                return res.status(401).json({ error: { code: "OTP_TOKEN_REQUIRED" } });
            user = (await authService_1.authService.completeRegistration(registrationSessionId, phone)).user;
        }
        else {
            const userId = parsed.decoded?.userId;
            if (!userId)
                return res.status(401).json({
                    error: {
                        code: purpose === "password_reset"
                            ? "PASSWORD_RESET_TOKEN_REQUIRED"
                            : "OTP_TOKEN_REQUIRED",
                    },
                });
            user = await userRepository_1.userRepository.findById(userId);
            if (!user)
                return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
            if (user.phone && user.phone !== phone)
                return res.status(400).json({ error: { code: "PHONE_MISMATCH" } });
            if (!user.phone) {
                const existingPhone = await userRepository_1.userRepository.findByPhone(phone);
                if (existingPhone && existingPhone.id !== user.id)
                    return res.status(409).json({ error: { code: "PHONE_EXISTS" } });
            }
            if (!user.phoneVerifiedAt || user.phone !== phone)
                user = await userRepository_1.userRepository.updateProfile(user.id, {
                    phone,
                    phoneVerifiedAt: new Date(),
                });
        }
        if (purpose === "login_device") {
            const trusted = await deviceTrustService_1.deviceTrustService.trustCurrentDevice(user.id, req);
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
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.post("/otp/telegram/callback", async (req, res, next) => {
    try {
        const timestamp = req.get("X-Request-Timestamp");
        const signature = req.get("X-Request-Signature");
        const rawBody = req.rawBody ??
            JSON.stringify(req.body ?? {});
        if (!timestamp || !signature)
            return res
                .status(400)
                .json({ error: { code: "INVALID_SIGNATURE_HEADERS" } });
        const valid = otpService_1.otpService.validateTelegramCallbackSignature({
            timestamp,
            signature,
            rawBody,
        });
        if (!valid)
            return res.status(401).json({ error: { code: "INVALID_SIGNATURE" } });
        const body = req.body;
        const mappedStatus = otpService_1.otpService.mapIncomingDeliveryStatus(body.status ?? "");
        if (!mappedStatus)
            return res.status(200).json({ ok: true, ignored: true });
        await otpService_1.otpService.updateDeliveryStatus({
            providerRequestId: body.request_id,
            providerPayload: body.payload,
            deliveryStatus: mappedStatus,
        });
        return res.json({ ok: true });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.post("/otp/plusofon/webhook", async (req, res, next) => {
    try {
        if (env_1.env.plusofonWebhookSecret) {
            const headerSecret = req.get("X-Webhook-Secret") ?? req.get("X-Plusofon-Secret") ?? "";
            if (!headerSecret || headerSecret !== env_1.env.plusofonWebhookSecret)
                return res.status(401).json({ error: { code: "INVALID_SIGNATURE" } });
        }
        const body = req.body;
        const parsed = parsePlusofonWebhookPayload(body);
        if (!parsed.requestId)
            return res.status(200).json({ ok: true, ignored: true });
        const effectiveStatus = parsed.status ?? (parsed.phone ? "verified" : "pending");
        const mapped = otpService_1.otpService.mapPlusofonStatus(effectiveStatus);
        if (mapped !== "pending")
            await otpService_1.otpService.markOtpVerifiedByProviderRequestId({
                requestId: parsed.requestId,
                status: mapped,
                providerPayload: body,
            });
        return res.json({ ok: true });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.get("/me", authMiddleware_1.authenticate, async (req, res, next) => {
    try {
        const user = await userRepository_1.userRepository.findById(req.user.userId);
        if (!user)
            return res.status(404).json({ error: { code: "NOT_FOUND" } });
        return res.json({
            data: {
                id: user.id,
                name: user.name,
                fullName: user.fullName,
                role: user.role,
                email: user.email,
            },
        });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.patch("/me", authMiddleware_1.authenticate, async (req, res, next) => {
    try {
        const payload = updateProfileSchema.parse(req.body);
        const existingUser = await userRepository_1.userRepository.findById(req.user.userId);
        if (!existingUser)
            return res.status(404).json({ error: { code: "NOT_FOUND" } });
        if (payload.email) {
            const existing = await userRepository_1.userRepository.findByEmail(payload.email);
            if (existing && existing.id !== req.user.userId)
                return res.status(400).json({ error: { code: "EMAIL_EXISTS" } });
        }
        let phone = payload.phone;
        let phoneVerifiedAt = existingUser.phoneVerifiedAt;
        if (payload.phone) {
            phone = (0, phone_1.normalizePhone)(payload.phone);
            const existingPhone = await userRepository_1.userRepository.findByPhone(phone);
            if (existingPhone && existingPhone.id !== req.user.userId)
                return res.status(400).json({ error: { code: "PHONE_EXISTS" } });
            if (existingUser.phone !== phone)
                phoneVerifiedAt = null;
        }
        const updated = await userRepository_1.userRepository.updateProfile(req.user.userId, {
            name: payload.name,
            email: payload.email,
            phone: payload.phone ? (phone ?? null) : existingUser.phone,
            phoneVerifiedAt: payload.phone
                ? (phoneVerifiedAt ?? null)
                : existingUser.phoneVerifiedAt,
            address: payload.address ?? null,
            fullName: payload.fullName ?? existingUser.fullName,
        });
        return res.json({ data: authService_1.authService.getPublicUser(updated) });
    }
    catch (error) {
        return next(error);
    }
});
