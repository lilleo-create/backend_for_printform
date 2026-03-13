"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const authService_1 = require("../services/authService");
const authMiddleware_1 = require("../middleware/authMiddleware");
const userRepository_1 = require("../repositories/userRepository");
const env_1 = require("../config/env");
const otpService_1 = require("../services/otpService");
const phone_1 = require("../utils/phone");
const rateLimiters_1 = require("../middleware/rateLimiters");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const prisma_1 = require("../lib/prisma");
exports.authRoutes = (0, express_1.Router)();
const loginSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6)
});
const fullNameSchema = zod_1.z.string().trim().min(3).max(120).regex(/^[A-Za-zА-Яа-яЁё\-\s]+$/, 'Допустимы буквы, пробел и дефис').refine((value) => value.split(/\s+/).filter(Boolean).length >= 2, 'Введите ФИО минимум из двух слов');
const registerSchema = loginSchema.extend({
    name: zod_1.z.string().trim().min(2),
    fullName: fullNameSchema,
    phone: zod_1.z.string().min(5),
    address: zod_1.z.string().min(3).optional(),
    privacyAccepted: zod_1.z.boolean().optional(),
    role: zod_1.z.enum(['BUYER', 'SELLER']).optional()
});
const updateProfileSchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(2).optional(),
    fullName: zod_1.z.string().trim().min(2).max(120).transform((value) => value.replace(/\s+/g, ' ')).optional(),
    email: zod_1.z.string().email().optional(),
    phone: zod_1.z.string().min(5).optional(),
    address: zod_1.z.string().min(3).optional()
});
const otpRequestSchema = zod_1.z.object({
    phone: zod_1.z.string().min(5),
    purpose: zod_1.z.enum(['buyer_register_phone', 'buyer_change_phone', 'buyer_sensitive_action', 'seller_connect_phone', 'seller_change_payout_details', 'seller_payout_settings_verify']).optional(),
    turnstileToken: zod_1.z.string().optional()
});
const otpVerifySchema = zod_1.z.object({
    phone: zod_1.z.string().min(5),
    code: zod_1.z.string().min(4),
    purpose: zod_1.z.enum(['buyer_register_phone', 'buyer_change_phone', 'buyer_sensitive_action', 'seller_connect_phone', 'seller_change_payout_details', 'seller_payout_settings_verify']).optional()
});
const passwordResetRequestSchema = zod_1.z.object({
    phone: zod_1.z.string().min(5)
});
const passwordResetVerifySchema = zod_1.z.object({
    phone: zod_1.z.string().min(5),
    code: zod_1.z.string().min(4)
});
const passwordResetConfirmSchema = zod_1.z.object({
    token: zod_1.z.string().min(10),
    password: zod_1.z.string().min(6)
});
const cookieOptions = {
    httpOnly: true,
    sameSite: env_1.env.isProduction ? 'strict' : 'lax',
    secure: env_1.env.isProduction
};
const verifyTurnstile = async (token) => {
    if (!env_1.env.turnstileSecretKey) {
        return true;
    }
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            secret: env_1.env.turnstileSecretKey,
            response: token
        })
    });
    if (!response.ok) {
        return false;
    }
    const result = (await response.json());
    return Boolean(result.success);
};
const parseAuthToken = (req) => {
    const header = req.headers.authorization;
    if (!header) {
        return null;
    }
    return header.replace('Bearer ', '');
};
const decodeAuthToken = (token) => {
    return jsonwebtoken_1.default.verify(token, env_1.env.jwtSecret);
};
const createPasswordResetToken = (payload) => {
    return jsonwebtoken_1.default.sign({ ...payload, scope: 'password_reset' }, env_1.env.jwtSecret, { expiresIn: '10m' });
};
exports.authRoutes.post('/register', rateLimiters_1.authLimiter, async (req, res, next) => {
    try {
        const payload = registerSchema.parse(req.body);
        const phone = (0, phone_1.normalizePhone)(payload.phone);
        const result = await authService_1.authService.startRegistration(payload.name, payload.fullName, payload.email, payload.password, payload.role, phone, payload.address);
        const tempToken = authService_1.authService.issueRegistrationOtpToken(result.pending.id);
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
    }
    catch (error) {
        next(error);
    }
});
exports.authRoutes.post('/login', rateLimiters_1.authLimiter, async (req, res, next) => {
    try {
        const payload = loginSchema.parse(req.body);
        const result = await authService_1.authService.login(payload.email, payload.password);
        if (!result.user.phoneVerifiedAt) {
            const tempToken = authService_1.authService.issueOtpToken(result.user);
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
        const tokens = await authService_1.authService.issueTokens(result.user);
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
    }
    catch (error) {
        next(error);
    }
});
exports.authRoutes.post('/refresh', async (req, res, next) => {
    try {
        const token = req.cookies.refreshToken;
        if (!token) {
            return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        }
        const result = await authService_1.authService.refresh(token);
        return res.json({ token: result.accessToken });
    }
    catch (error) {
        if (error instanceof Error && error.message === 'INVALID_REFRESH') {
            console.warn('[auth][refresh] invalid refresh token', { hasCookie: Boolean(req.cookies.refreshToken) });
            return res.status(401).json({ error: { code: 'INVALID_REFRESH', message: 'Необходимо войти снова' } });
        }
        return next(error);
    }
});
exports.authRoutes.post('/logout', async (req, res, next) => {
    try {
        const token = req.cookies.refreshToken;
        if (token) {
            await authService_1.authService.logout(token);
        }
        res.clearCookie('refreshToken', cookieOptions);
        res.json({ success: true });
    }
    catch (error) {
        next(error);
    }
});
exports.authRoutes.post('/password-reset/request', rateLimiters_1.otpRequestLimiter, async (req, res, next) => {
    try {
        const payload = passwordResetRequestSchema.parse(req.body);
        const phone = (0, phone_1.normalizePhone)(payload.phone);
        const user = await userRepository_1.userRepository.findByPhone(phone);
        if (!user) {
            return res.status(404).json({ error: { code: 'NOT_FOUND' } });
        }
        const result = await otpService_1.otpService.requestOtp({
            phone,
            purpose: 'password_reset',
            ip: req.ip,
            userAgent: req.get('user-agent')
        });
        return res.json({ ok: true, devOtp: result.devOtp, delivery: result.delivery });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.post('/password-reset/verify', rateLimiters_1.otpVerifyLimiter, async (req, res, next) => {
    try {
        const payload = passwordResetVerifySchema.parse(req.body);
        const phone = (0, phone_1.normalizePhone)(payload.phone);
        const user = await userRepository_1.userRepository.findByPhone(phone);
        if (!user) {
            return res.status(404).json({ error: { code: 'NOT_FOUND' } });
        }
        await otpService_1.otpService.verifyOtp({ phone, code: payload.code, purpose: 'password_reset' });
        const resetToken = createPasswordResetToken({ userId: user.id });
        return res.json({ ok: true, resetToken });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.post('/password-reset/confirm', rateLimiters_1.authLimiter, async (req, res, next) => {
    try {
        const payload = passwordResetConfirmSchema.parse(req.body);
        const decoded = jsonwebtoken_1.default.verify(payload.token, env_1.env.jwtSecret);
        if (decoded.scope !== 'password_reset') {
            return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        }
        const user = await userRepository_1.userRepository.findById(decoded.userId);
        if (!user) {
            return res.status(404).json({ error: { code: 'NOT_FOUND' } });
        }
        const hashed = await bcryptjs_1.default.hash(payload.password, 10);
        await userRepository_1.userRepository.updatePassword(user.id, hashed);
        return res.json({ ok: true });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.post('/otp/request', rateLimiters_1.otpRequestLimiter, async (req, res, next) => {
    try {
        const payload = otpRequestSchema.parse(req.body);
        if (env_1.env.turnstileSecretKey) {
            if (!payload.turnstileToken) {
                return res.status(400).json({ error: { code: 'TURNSTILE_REQUIRED' } });
            }
            const verified = await verifyTurnstile(payload.turnstileToken);
            if (!verified) {
                return res.status(400).json({ error: { code: 'TURNSTILE_FAILED' } });
            }
        }
        const purpose = (payload.purpose ?? 'buyer_register_phone');
        const token = parseAuthToken(req);
        let decoded = null;
        if (token) {
            try {
                decoded = decodeAuthToken(token);
            }
            catch {
                return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
            }
        }
        if (purpose === 'buyer_register_phone') {
            if (!decoded || decoded.scope !== 'otp_register' || !decoded.registrationSessionId) {
                return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } });
            }
            const pending = await prisma_1.prisma.pendingRegistration.findUnique({ where: { id: decoded.registrationSessionId } });
            if (!pending || pending.usedAt || pending.expiresAt < new Date()) {
                return res.status(401).json({ error: { code: 'REGISTRATION_SESSION_INVALID' } });
            }
            if ((0, phone_1.normalizePhone)(payload.phone) !== pending.phone) {
                return res.status(400).json({ error: { code: 'PHONE_MISMATCH' } });
            }
        }
        else if (!decoded || (decoded.scope && decoded.scope !== 'access')) {
            return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        }
        const result = await otpService_1.otpService.requestOtp({
            phone: payload.phone,
            purpose,
            ip: req.ip,
            userAgent: req.get('user-agent')
        });
        return res.json({ ok: true, devOtp: result.devOtp, delivery: result.delivery });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.post('/otp/verify', rateLimiters_1.otpVerifyLimiter, async (req, res, next) => {
    try {
        const payload = otpVerifySchema.parse(req.body);
        const purpose = (payload.purpose ?? 'buyer_register_phone');
        const token = parseAuthToken(req);
        let decoded = null;
        if (token) {
            try {
                decoded = decodeAuthToken(token);
            }
            catch {
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
        const { phone } = await otpService_1.otpService.verifyOtp({
            phone: payload.phone,
            code: payload.code,
            purpose
        });
        let user;
        if (needsOtpToken) {
            const registrationSessionId = decoded?.registrationSessionId;
            if (!registrationSessionId) {
                return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } });
            }
            const created = await authService_1.authService.completeRegistration(registrationSessionId, phone);
            user = created.user;
        }
        else {
            const userId = decoded?.userId;
            if (!userId) {
                return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
            }
            user = await userRepository_1.userRepository.findById(userId);
            if (!user) {
                return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
            }
            if (user.phone && user.phone !== phone) {
                return res.status(400).json({ error: { code: 'PHONE_MISMATCH' } });
            }
            if (!user.phone) {
                const existingPhone = await userRepository_1.userRepository.findByPhone(phone);
                if (existingPhone && existingPhone.id !== user.id) {
                    return res.status(409).json({ error: { code: 'PHONE_EXISTS' } });
                }
            }
            if (!user.phoneVerifiedAt || user.phone !== phone) {
                user = await userRepository_1.userRepository.updateProfile(user.id, { phone, phoneVerifiedAt: new Date() });
            }
        }
        const tokens = await authService_1.authService.issueTokens(user);
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
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.post('/otp/telegram/callback', async (req, res, next) => {
    try {
        const timestamp = req.get('X-Request-Timestamp');
        const signature = req.get('X-Request-Signature');
        const rawBody = req.rawBody ?? JSON.stringify(req.body ?? {});
        if (!timestamp || !signature) {
            return res.status(400).json({ error: { code: 'INVALID_SIGNATURE_HEADERS' } });
        }
        const valid = otpService_1.otpService.validateTelegramCallbackSignature({
            timestamp,
            signature,
            rawBody
        });
        if (!valid) {
            return res.status(401).json({ error: { code: 'INVALID_SIGNATURE' } });
        }
        const body = req.body;
        console.info('[OTP] telegram callback received', {
            providerRequestId: body.request_id,
            payload: body.payload,
            status: body.status
        });
        const mappedStatus = otpService_1.otpService.mapIncomingDeliveryStatus(body.status ?? '');
        if (!mappedStatus) {
            return res.status(200).json({ ok: true, ignored: true });
        }
        await otpService_1.otpService.updateDeliveryStatus({
            providerRequestId: body.request_id,
            providerPayload: body.payload,
            deliveryStatus: mappedStatus
        });
        return res.json({ ok: true });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.get('/me', authMiddleware_1.authenticate, async (req, res, next) => {
    try {
        const user = await userRepository_1.userRepository.findById(req.user.userId);
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
    }
    catch (error) {
        return next(error);
    }
});
exports.authRoutes.patch('/me', authMiddleware_1.authenticate, async (req, res, next) => {
    try {
        const payload = updateProfileSchema.parse(req.body);
        const existingUser = await userRepository_1.userRepository.findById(req.user.userId);
        if (!existingUser) {
            return res.status(404).json({ error: { code: 'NOT_FOUND' } });
        }
        if (payload.email) {
            const existing = await userRepository_1.userRepository.findByEmail(payload.email);
            if (existing && existing.id !== req.user.userId) {
                return res.status(400).json({ error: { code: 'EMAIL_EXISTS' } });
            }
        }
        let phone = payload.phone;
        let phoneVerifiedAt = existingUser.phoneVerifiedAt;
        if (payload.phone) {
            phone = (0, phone_1.normalizePhone)(payload.phone);
            const existingPhone = await userRepository_1.userRepository.findByPhone(phone);
            if (existingPhone && existingPhone.id !== req.user.userId) {
                return res.status(400).json({ error: { code: 'PHONE_EXISTS' } });
            }
            if (existingUser.phone !== phone) {
                phoneVerifiedAt = null;
            }
        }
        const phoneToUpdate = payload.phone ? phone ?? null : existingUser.phone;
        const phoneVerifiedAtToUpdate = payload.phone ? phoneVerifiedAt : existingUser.phoneVerifiedAt;
        const updated = await userRepository_1.userRepository.updateProfile(req.user.userId, {
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
    }
    catch (error) {
        return next(error);
    }
});
