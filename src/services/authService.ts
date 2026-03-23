import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { TrustedDevice, User } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { userRepository } from '../repositories/userRepository';

const createAccessToken = (payload: { userId: string; role: string }) => {
  return jwt.sign({ ...payload, scope: 'access' }, env.jwtSecret, { expiresIn: `${env.authAccessTokenTtlMinutes}m` });
};

const createRefreshToken = (payload: { userId: string; role: string }) => {
  return jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: `${env.authRefreshTokenTtlDays}d` });
};

const createOtpToken = (payload: { userId?: string; registrationSessionId?: string; scope: 'otp' | 'otp_register' | 'otp_login_device' | 'otp_password_reset' }) => {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: '10m' });
};

export const authService = {
  getRefreshCookieOptions() {
    return {
      httpOnly: true,
      sameSite: env.authCookieSameSite,
      secure: env.isProduction,
      maxAge: env.authRefreshTokenTtlDays * 24 * 60 * 60 * 1000,
      ...(env.authCookieDomain ? { domain: env.authCookieDomain } : {})
    } as const;
  },
  async issueTokens(user: { id: string; role: string }, trustedDeviceId?: string | null) {
    const accessToken = createAccessToken({ userId: user.id, role: user.role });
    const refreshToken = createRefreshToken({ userId: user.id, role: user.role });
    const expiresAt = new Date(Date.now() + env.authRefreshTokenTtlDays * 24 * 60 * 60 * 1000);
    await prisma.refreshToken.create({
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
  issueOtpToken(user: { id: string }) {
    return createOtpToken({ userId: user.id, scope: 'otp' });
  },
  issueRegistrationOtpToken(registrationSessionId: string) {
    return createOtpToken({ registrationSessionId, scope: 'otp_register' });
  },
  issueLoginDeviceOtpToken(user: { id: string }) {
    return createOtpToken({ userId: user.id, scope: 'otp_login_device' });
  },
  issuePasswordResetOtpToken(user: { id: string }) {
    return createOtpToken({ userId: user.id, scope: 'otp_password_reset' });
  },
  async startRegistration(
    nickname: string,
    fullName: string,
    email: string,
    password: string,
    role?: 'BUYER' | 'SELLER' | 'ADMIN',
    phone?: string,
    address?: string
  ) {
    const existingEmail = await userRepository.findByEmail(email);
    if (existingEmail?.phoneVerifiedAt) throw new Error('USER_EXISTS');
    if (phone) {
      const existingPhone = await userRepository.findByPhone(phone);
      if (existingPhone?.phoneVerifiedAt) throw new Error('PHONE_EXISTS');
    }

    const hashed = await bcrypt.hash(password, 10);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const pending = await prisma.pendingRegistration.upsert({
      where: { phone: phone ?? '' },
      create: { name: nickname, fullName, email, passwordHash: hashed, role: role ?? 'BUYER', phone: phone ?? '', address: address ?? null, expiresAt },
      update: { name: nickname, fullName, email, passwordHash: hashed, role: role ?? 'BUYER', address: address ?? null, usedAt: null, expiresAt }
    });

    return { pending };
  },
  async completeRegistration(registrationSessionId: string, verifiedPhone: string) {
    const pending = await prisma.pendingRegistration.findUnique({ where: { id: registrationSessionId } });
    if (!pending || pending.usedAt || pending.expiresAt < new Date()) throw new Error('REGISTRATION_SESSION_INVALID');
    if (pending.phone !== verifiedPhone) throw new Error('PHONE_MISMATCH');

    const existingByEmail = await userRepository.findByEmail(pending.email);
    const existingByPhone = await userRepository.findByPhone(pending.phone);
    const existingVerified = [existingByEmail, existingByPhone].find((u) => u?.phoneVerifiedAt);
    if (existingVerified) throw new Error(existingVerified.email === pending.email ? 'USER_EXISTS' : 'PHONE_EXISTS');

    const legacyCandidate = existingByEmail ?? existingByPhone;

    const user = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const nextUser = legacyCandidate
        ? await tx.user.update({ where: { id: legacyCandidate.id }, data: { name: pending.name, fullName: pending.fullName, email: pending.email, passwordHash: pending.passwordHash, role: pending.role, phone: pending.phone, address: pending.address, phoneVerifiedAt: now } })
        : await tx.user.create({ data: { name: pending.name, fullName: pending.fullName, email: pending.email, passwordHash: pending.passwordHash, role: pending.role, phone: pending.phone, address: pending.address, phoneVerifiedAt: now } });

      await tx.pendingRegistration.update({ where: { id: pending.id }, data: { usedAt: now } });
      return nextUser;
    });

    return { user };
  },
  async login(login: { phone: string }, password: string) {
    const user = await userRepository.findByPhone(login.phone);
    if (!user) throw new Error('INVALID_CREDENTIALS');
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new Error('INVALID_CREDENTIALS');
    return { user };
  },
  async refresh(token: string) {
    const stored = await prisma.refreshToken.findUnique({ where: { token } });
    if (!stored || stored.revokedAt || stored.expiresAt <= new Date()) throw new Error('INVALID_REFRESH');

    let decoded: { userId: string; role: string };
    try {
      decoded = jwt.verify(token, env.jwtRefreshSecret) as { userId: string; role: string };
    } catch {
      await prisma.refreshToken.updateMany({ where: { token, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new Error('INVALID_REFRESH');
    }

    const user = await userRepository.findById(decoded.userId);
    if (!user) throw new Error('INVALID_REFRESH');

    await prisma.refreshToken.update({ where: { token }, data: { revokedAt: new Date(), lastUsedAt: new Date() } });
    const next = await this.issueTokens(user, stored.trustedDeviceId);
    return next;
  },
  async logout(token: string) {
    await prisma.refreshToken.updateMany({ where: { token, revokedAt: null }, data: { revokedAt: new Date() } });
  },
  getPublicUser(user: Pick<User, 'id' | 'name' | 'fullName' | 'role' | 'email' | 'phone' | 'address'>) {
    return { id: user.id, name: user.name, fullName: user.fullName, role: user.role, email: user.email, phone: user.phone, address: user.address };
  }
};
