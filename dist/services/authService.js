"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authService = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
const prisma_1 = require("../lib/prisma");
const userRepository_1 = require("../repositories/userRepository");
const createAccessToken = (payload) => {
    return jsonwebtoken_1.default.sign({ ...payload, scope: 'access' }, env_1.env.jwtSecret, { expiresIn: '15m' });
};
const createRefreshToken = (payload) => {
    return jsonwebtoken_1.default.sign(payload, env_1.env.jwtRefreshSecret, { expiresIn: '7d' });
};
const createOtpToken = (payload) => {
    return jsonwebtoken_1.default.sign(payload, env_1.env.jwtSecret, { expiresIn: '10m' });
};
exports.authService = {
    async issueTokens(user) {
        const accessToken = createAccessToken({ userId: user.id, role: user.role });
        const refreshToken = createRefreshToken({ userId: user.id, role: user.role });
        await prisma_1.prisma.refreshToken.create({
            data: {
                token: refreshToken,
                userId: user.id,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            }
        });
        return { accessToken, refreshToken };
    },
    issueOtpToken(user) {
        return createOtpToken({ userId: user.id, scope: 'otp' });
    },
    issueRegistrationOtpToken(registrationSessionId) {
        return createOtpToken({ registrationSessionId, scope: 'otp_register' });
    },
    async startRegistration(nickname, fullName, email, password, role, phone, address) {
        const existingEmail = await userRepository_1.userRepository.findByEmail(email);
        if (existingEmail?.phoneVerifiedAt) {
            throw new Error('USER_EXISTS');
        }
        if (phone) {
            const existingPhone = await userRepository_1.userRepository.findByPhone(phone);
            if (existingPhone?.phoneVerifiedAt) {
                throw new Error('PHONE_EXISTS');
            }
        }
        const hashed = await bcryptjs_1.default.hash(password, 10);
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        const pending = await prisma_1.prisma.pendingRegistration.upsert({
            where: { phone: phone ?? '' },
            create: {
                name: nickname,
                fullName,
                email,
                passwordHash: hashed,
                role: role ?? 'BUYER',
                phone: phone ?? '',
                address: address ?? null,
                expiresAt
            },
            update: {
                name: nickname,
                fullName,
                email,
                passwordHash: hashed,
                role: role ?? 'BUYER',
                address: address ?? null,
                usedAt: null,
                expiresAt
            }
        });
        return { pending };
    },
    async completeRegistration(registrationSessionId, verifiedPhone) {
        const pending = await prisma_1.prisma.pendingRegistration.findUnique({ where: { id: registrationSessionId } });
        if (!pending || pending.usedAt || pending.expiresAt < new Date()) {
            throw new Error('REGISTRATION_SESSION_INVALID');
        }
        if (pending.phone !== verifiedPhone) {
            throw new Error('PHONE_MISMATCH');
        }
        const existingByEmail = await userRepository_1.userRepository.findByEmail(pending.email);
        const existingByPhone = await userRepository_1.userRepository.findByPhone(pending.phone);
        const existingVerified = [existingByEmail, existingByPhone].find((u) => u?.phoneVerifiedAt);
        if (existingVerified) {
            throw new Error(existingVerified.email === pending.email ? 'USER_EXISTS' : 'PHONE_EXISTS');
        }
        const legacyCandidate = existingByEmail ?? existingByPhone;
        const user = await prisma_1.prisma.$transaction(async (tx) => {
            const now = new Date();
            const nextUser = legacyCandidate
                ? await tx.user.update({
                    where: { id: legacyCandidate.id },
                    data: {
                        name: pending.name,
                        fullName: pending.fullName,
                        email: pending.email,
                        passwordHash: pending.passwordHash,
                        role: pending.role,
                        phone: pending.phone,
                        address: pending.address,
                        phoneVerifiedAt: now
                    }
                })
                : await tx.user.create({
                    data: {
                        name: pending.name,
                        fullName: pending.fullName,
                        email: pending.email,
                        passwordHash: pending.passwordHash,
                        role: pending.role,
                        phone: pending.phone,
                        address: pending.address,
                        phoneVerifiedAt: now
                    }
                });
            await tx.pendingRegistration.update({
                where: { id: pending.id },
                data: { usedAt: now }
            });
            return nextUser;
        });
        return { user };
    },
    async login(login, password) {
        const user = login.phone
            ? await userRepository_1.userRepository.findByPhone(login.phone)
            : login.email
                ? await userRepository_1.userRepository.findByEmail(login.email)
                : null;
        if (!user) {
            throw new Error('INVALID_CREDENTIALS');
        }
        const valid = await bcryptjs_1.default.compare(password, user.passwordHash);
        if (!valid) {
            throw new Error('INVALID_CREDENTIALS');
        }
        return { user };
    },
    async refresh(token) {
        const stored = await prisma_1.prisma.refreshToken.findUnique({ where: { token } });
        if (!stored) {
            throw new Error('INVALID_REFRESH');
        }
        const decoded = jsonwebtoken_1.default.verify(token, env_1.env.jwtRefreshSecret);
        const accessToken = createAccessToken({ userId: decoded.userId, role: decoded.role });
        return { accessToken };
    },
    async logout(token) {
        await prisma_1.prisma.refreshToken.deleteMany({ where: { token } });
    }
};
