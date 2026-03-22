import crypto from 'crypto';
import { TrustedDevice } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('hex');

const normalizeIp = (value: string | undefined) => {
  if (!value) return null;
  return value.split(',')[0]?.trim() || null;
};

const buildFingerprint = (req: Pick<Request, 'headers' | 'ip'>) => {
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
  const acceptLanguage = typeof req.headers['accept-language'] === 'string' ? req.headers['accept-language'] : '';
  const platform = typeof req.headers['sec-ch-ua-platform'] === 'string' ? req.headers['sec-ch-ua-platform'] : '';
  return sha256([userAgent, acceptLanguage, platform].join('|'));
};

const buildLabel = (userAgent: string | null) => {
  if (!userAgent) return 'Unknown device';
  return userAgent.slice(0, 180);
};

export const deviceTrustService = {
  hashToken: sha256,
  buildFingerprint,
  getCookieOptions() {
    return {
      httpOnly: true,
      sameSite: env.authCookieSameSite,
      secure: env.isProduction,
      maxAge: env.trustedDeviceTtlDays * 24 * 60 * 60 * 1000,
      ...(env.authCookieDomain ? { domain: env.authCookieDomain } : {})
    } as const;
  },
  async findTrustedDeviceForRequest(userId: string, rawToken: string | undefined, req: Pick<Request, 'headers' | 'ip'>) {
    if (!rawToken) return null;
    const fingerprintHash = buildFingerprint(req);
    const now = new Date();
    const device = await prisma.trustedDevice.findFirst({
      where: {
        userId,
        tokenHash: sha256(rawToken),
        fingerprintHash,
        revokedAt: null,
        expiresAt: { gt: now }
      }
    });

    if (!device) return null;

    await prisma.trustedDevice.update({
      where: { id: device.id },
      data: {
        lastSeenAt: now,
        lastIp: normalizeIp(req.ip)
      }
    });

    return device;
  },
  async trustCurrentDevice(userId: string, req: Pick<Request, 'headers' | 'ip'>) {
    const token = randomToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + env.trustedDeviceTtlDays * 24 * 60 * 60 * 1000);
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
    const device = await prisma.trustedDevice.create({
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
  async revokeDevice(deviceId: string) {
    await prisma.trustedDevice.updateMany({ where: { id: deviceId, revokedAt: null }, data: { revokedAt: new Date() } });
  },
  async cleanupExpired() {
    const now = new Date();
    await prisma.trustedDevice.updateMany({ where: { expiresAt: { lte: now }, revokedAt: null }, data: { revokedAt: now } });
    await prisma.refreshToken.updateMany({ where: { expiresAt: { lte: now }, revokedAt: null }, data: { revokedAt: now } });
  }
};
