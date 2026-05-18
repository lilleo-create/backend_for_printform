"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deviceTrustService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const prisma_1 = require("../lib/prisma");
const env_1 = require("../config/env");
const sha256 = (value) => crypto_1.default.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto_1.default.randomBytes(32).toString('hex');
const normalizeIp = (value) => {
    if (!value)
        return null;
    return value.split(',')[0]?.trim() || null;
};
const buildFingerprint = (req) => {
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
    const acceptLanguage = typeof req.headers['accept-language'] === 'string' ? req.headers['accept-language'] : '';
    const platform = typeof req.headers['sec-ch-ua-platform'] === 'string' ? req.headers['sec-ch-ua-platform'] : '';
    return sha256([userAgent, acceptLanguage, platform].join('|'));
};
const buildLabel = (userAgent) => {
    if (!userAgent)
        return 'Unknown device';
    return userAgent.slice(0, 180);
};
exports.deviceTrustService = {
    hashToken: sha256,
    buildFingerprint,
    getCookieOptions() {
        return {
            httpOnly: true,
            sameSite: env_1.env.authCookieSameSite,
            secure: env_1.env.isProduction,
            maxAge: env_1.env.trustedDeviceTtlDays * 24 * 60 * 60 * 1000,
            ...(env_1.env.authCookieDomain ? { domain: env_1.env.authCookieDomain } : {})
        };
    },
    async findTrustedDeviceForRequest(userId, rawToken, req) {
        if (!rawToken)
            return null;
        const fingerprintHash = buildFingerprint(req);
        const now = new Date();
        const device = await prisma_1.prisma.trustedDevice.findFirst({
            where: {
                userId,
                tokenHash: sha256(rawToken),
                fingerprintHash,
                revokedAt: null,
                expiresAt: { gt: now }
            }
        });
        if (!device)
            return null;
        await prisma_1.prisma.trustedDevice.update({
            where: { id: device.id },
            data: {
                lastSeenAt: now,
                lastIp: normalizeIp(req.ip)
            }
        });
        return device;
    },
    async trustCurrentDevice(userId, req) {
        const token = randomToken();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + env_1.env.trustedDeviceTtlDays * 24 * 60 * 60 * 1000);
        const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
        const device = await prisma_1.prisma.trustedDevice.create({
            data: {
                userId,
                tokenHash: sha256(token),
                fingerprintHash: buildFingerprint(req),
                label: buildLabel(userAgent),
                userAgent,
                lastIp: normalizeIp(req.ip),
                lastSeenAt: now,
                expiresAt
            }
        });
        return { device, token };
    },
    async revokeDevice(deviceId) {
        await prisma_1.prisma.trustedDevice.updateMany({ where: { id: deviceId, revokedAt: null }, data: { revokedAt: new Date() } });
    },
    async cleanupExpired() {
        const now = new Date();
        await prisma_1.prisma.trustedDevice.updateMany({ where: { expiresAt: { lte: now }, revokedAt: null }, data: { revokedAt: now } });
        await prisma_1.prisma.refreshToken.updateMany({ where: { expiresAt: { lte: now }, revokedAt: null }, data: { revokedAt: now } });
    }
};
