"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authService = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const crypto_1 = __importDefault(require("crypto"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
const prisma_1 = require("../lib/prisma");
const userRepository_1 = require("../repositories/userRepository");
const createAccessToken = (payload) => {
    return jsonwebtoken_1.default.sign({ ...payload, scope: 'access' }, env_1.env.jwtSecret, { expiresIn: `${env_1.env.authAccessTokenTtlMinutes}m` });
};
const createRefreshToken = (payload) => {
    return jsonwebtoken_1.default.sign({ ...payload, jti: crypto_1.default.randomUUID() }, env_1.env.jwtRefreshSecret, { expiresIn: `${env_1.env.authRefreshTokenTtlDays}d` });
};
const createOtpToken = (payload) => {
    return jsonwebtoken_1.default.sign(payload, env_1.env.jwtSecret, { expiresIn: '10m' });
};
exports.authService = {
    getRefreshCookieOptions() {
        return {
            httpOnly: true,
            sameSite: env_1.env.authCookieSameSite,
            secure: env_1.env.authCookieSecure,
            path: env_1.env.authCookiePath,
            maxAge: env_1.env.authRefreshTokenTtlDays * 24 * 60 * 60 * 1000,
            ...(env_1.env.authCookieDomain ? { domain: env_1.env.authCookieDomain } : {})
        };
    },
    async issueTokens(user, trustedDeviceId) {
        const accessToken = createAccessToken({ userId: user.id, role: user.role });
        const refreshToken = createRefreshToken({ userId: user.id, role: user.role });
        const expiresAt = new Date(Date.now() + env_1.env.authRefreshTokenTtlDays * 24 * 60 * 60 * 1000);
        await prisma_1.prisma.refreshToken.create({
            data: {
                token: refreshToken,
                userId: user.id,
                trustedDeviceId: trustedDeviceId ?? null,
                expiresAt,
                lastUsedAt: new Date()
            }
        });
        return { accessToken, refreshToken, refreshExpiresAt: expiresAt };
    },
    issueOtpToken(user) {
        return createOtpToken({ userId: user.id, scope: 'otp' });
    },
    issueRegistrationOtpToken(registrationSessionId) {
        return createOtpToken({ registrationSessionId, scope: 'otp_register' });
    },
    issueLoginDeviceOtpToken(user) {
        return createOtpToken({ userId: user.id, scope: 'otp_login_device' });
    },
    issuePasswordResetOtpToken(user) {
        return createOtpToken({ userId: user.id, scope: 'otp_password_reset' });
    },
    async startRegistration(nickname, fullName, email, password, role, phone, address) {
        const existingEmail = await userRepository_1.userRepository.findByEmail(email);
        if (existingEmail?.phoneVerifiedAt)
            throw new Error('USER_EXISTS');
        if (phone) {
            const existingPhone = await userRepository_1.userRepository.findByPhone(phone);
            if (existingPhone?.phoneVerifiedAt)
                throw new Error('PHONE_EXISTS');
        }
        const hashed = await bcryptjs_1.default.hash(password, 10);
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        const pending = await prisma_1.prisma.pendingRegistration.upsert({
            where: { phone: phone ?? '' },
            create: { name: nickname, fullName, email, passwordHash: hashed, role: role ?? 'BUYER', phone: phone ?? '', address: address ?? null, expiresAt },
            update: { name: nickname, fullName, email, passwordHash: hashed, role: role ?? 'BUYER', address: address ?? null, usedAt: null, expiresAt }
        });
        return { pending };
    },
    async completeRegistration(registrationSessionId, verifiedPhone) {
        const pending = await prisma_1.prisma.pendingRegistration.findUnique({ where: { id: registrationSessionId } });
        if (!pending || pending.usedAt || pending.expiresAt < new Date())
            throw new Error('REGISTRATION_SESSION_INVALID');
        if (pending.phone !== verifiedPhone)
            throw new Error('PHONE_MISMATCH');
        const existingByEmail = await userRepository_1.userRepository.findByEmail(pending.email);
        const existingByPhone = await userRepository_1.userRepository.findByPhone(pending.phone);
        const existingVerified = [existingByEmail, existingByPhone].find((u) => u?.phoneVerifiedAt);
        if (existingVerified)
            throw new Error(existingVerified.email === pending.email ? 'USER_EXISTS' : 'PHONE_EXISTS');
        const legacyCandidate = existingByEmail ?? existingByPhone;
        const user = await prisma_1.prisma.$transaction(async (tx) => {
            const now = new Date();
            const nextUser = legacyCandidate
                ? await tx.user.update({ where: { id: legacyCandidate.id }, data: { name: pending.name, fullName: pending.fullName, email: pending.email, passwordHash: pending.passwordHash, role: pending.role, phone: pending.phone, address: pending.address, phoneVerifiedAt: now } })
                : await tx.user.create({ data: { name: pending.name, fullName: pending.fullName, email: pending.email, passwordHash: pending.passwordHash, role: pending.role, phone: pending.phone, address: pending.address, phoneVerifiedAt: now } });
            await tx.pendingRegistration.update({ where: { id: pending.id }, data: { usedAt: now } });
            return nextUser;
        });
        return { user };
    },
    async login(login, password) {
        const user = await userRepository_1.userRepository.findByPhone(login.phone);
        if (!user)
            throw new Error('INVALID_CREDENTIALS');
        const valid = await bcryptjs_1.default.compare(password, user.passwordHash);
        if (!valid)
            throw new Error('INVALID_CREDENTIALS');
        return { user };
    },
    async refresh(token) {
        const now = new Date();
        const stored = await prisma_1.prisma.refreshToken.findUnique({ where: { token } });
        if (!stored || stored.revokedAt || stored.expiresAt <= now)
            throw new Error('INVALID_REFRESH');
        let decoded;
        try {
            decoded = jsonwebtoken_1.default.verify(token, env_1.env.jwtRefreshSecret);
        }
        catch {
            await prisma_1.prisma.refreshToken.updateMany({ where: { token, revokedAt: null }, data: { revokedAt: new Date() } });
            throw new Error('INVALID_REFRESH');
        }
        const user = await userRepository_1.userRepository.findById(decoded.userId);
        if (!user)
            throw new Error('INVALID_REFRESH');
        const revoked = await prisma_1.prisma.refreshToken.updateMany({
            where: { token, revokedAt: null, expiresAt: { gt: now } },
            data: { revokedAt: now, lastUsedAt: now }
        });
        if (revoked.count !== 1)
            throw new Error('INVALID_REFRESH');
        const next = await this.issueTokens(user, stored.trustedDeviceId);
        return next;
    },
    async logout(token) {
        await prisma_1.prisma.refreshToken.updateMany({ where: { token, revokedAt: null }, data: { revokedAt: new Date() } });
    },
    getPublicUser(user) {
        return { id: user.id, name: user.name, fullName: user.fullName, role: user.role, email: user.email, phone: user.phone, address: user.address };
    }
};
