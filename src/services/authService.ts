import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { userRepository } from '../repositories/userRepository';

const createAccessToken = (payload: { userId: string; role: string }) => {
  return jwt.sign({ ...payload, scope: 'access' }, env.jwtSecret, { expiresIn: '15m' });
};

const createRefreshToken = (payload: { userId: string; role: string }) => {
  return jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: '7d' });
};

const createOtpToken = (payload: { userId?: string; registrationSessionId?: string; scope: 'otp' | 'otp_register' }) => {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: '10m' });
};

export const authService = {
  async issueTokens(user: { id: string; role: string }) {
    const accessToken = createAccessToken({ userId: user.id, role: user.role });
    const refreshToken = createRefreshToken({ userId: user.id, role: user.role });
    await prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      }
    });
    return { accessToken, refreshToken };
  },
  issueOtpToken(user: { id: string }) {
    return createOtpToken({ userId: user.id, scope: 'otp' });
  },
  issueRegistrationOtpToken(registrationSessionId: string) {
    return createOtpToken({ registrationSessionId, scope: 'otp_register' });
  },
  async startRegistration(
    nickname: string,
    fullName: string,
    email: string,
    password: string,
    role?: 'BUYER' | 'SELLER',
    phone?: string,
    address?: string
  ) {
    const existingEmail = await userRepository.findByEmail(email);
    if (existingEmail?.phoneVerifiedAt) {
      throw new Error('USER_EXISTS');
    }
    if (phone) {
      const existingPhone = await userRepository.findByPhone(phone);
      if (existingPhone?.phoneVerifiedAt) {
        throw new Error('PHONE_EXISTS');
      }
    }

    const hashed = await bcrypt.hash(password, 10);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const pending = await prisma.pendingRegistration.upsert({
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

  async completeRegistration(registrationSessionId: string, verifiedPhone: string) {
    const pending = await prisma.pendingRegistration.findUnique({ where: { id: registrationSessionId } });
    if (!pending || pending.usedAt || pending.expiresAt < new Date()) {
      throw new Error('REGISTRATION_SESSION_INVALID');
    }
    if (pending.phone !== verifiedPhone) {
      throw new Error('PHONE_MISMATCH');
    }

    const existingByEmail = await userRepository.findByEmail(pending.email);
    const existingByPhone = await userRepository.findByPhone(pending.phone);
    const existingVerified = [existingByEmail, existingByPhone].find((u) => u?.phoneVerifiedAt);
    if (existingVerified) {
      throw new Error(existingVerified.email === pending.email ? 'USER_EXISTS' : 'PHONE_EXISTS');
    }

    const legacyCandidate = existingByEmail ?? existingByPhone;

    const user = await prisma.$transaction(async (tx) => {
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
  async login(login: { email?: string; phone?: string }, password: string) {
    const user = login.phone
      ? await userRepository.findByPhone(login.phone)
      : login.email
      ? await userRepository.findByEmail(login.email)
      : null;

    if (!user) {
      throw new Error('INVALID_CREDENTIALS');
    }
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new Error('INVALID_CREDENTIALS');
    }
    return { user };
  },
  async refresh(token: string) {
    const stored = await prisma.refreshToken.findUnique({ where: { token } });
    if (!stored) {
      throw new Error('INVALID_REFRESH');
    }
    const decoded = jwt.verify(token, env.jwtRefreshSecret) as { userId: string; role: string };
    const accessToken = createAccessToken({ userId: decoded.userId, role: decoded.role });
    return { accessToken };
  },
  async logout(token: string) {
    await prisma.refreshToken.deleteMany({ where: { token } });
  }
};
