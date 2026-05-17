import { prisma } from '../lib/prisma';

export const userRepository = {
  findByEmail: (email: string) => prisma.user.findUnique({ where: { email } }),
  findByPhone: (phone: string) => prisma.user.findUnique({ where: { phone } }),
  findById: (id: string) => prisma.user.findUnique({ where: { id } }),
  findByGoogleId: (googleId: string) => prisma.user.findUnique({ where: { googleId } }),
  findByYandexId: (yandexId: string) => prisma.user.findUnique({ where: { yandexId } }),
  create: (data: {
    name: string;
    email: string;
    fullName?: string | null;
    passwordHash: string;
    role?: 'BUYER' | 'SELLER' | 'ADMIN';
    phone?: string | null;
    address?: string | null;
  }) =>
    prisma.user.create({
      data: {
        ...data,
        role: data.role ?? 'BUYER'
      }
    }),
  createOAuthUser: (data: {
    email: string;
    name: string;
    googleId?: string;
    yandexId?: string;
    avatarUrl?: string | null;
    phone?: string | null;
    phoneVerifiedAt?: Date | null;
  }) =>
    prisma.user.create({
      data: {
        email: data.email,
        name: data.name,
        googleId: data.googleId ?? null,
        yandexId: data.yandexId ?? null,
        avatarUrl: data.avatarUrl ?? null,
        phone: data.phone ?? null,
        phoneVerifiedAt: data.phoneVerifiedAt ?? null,
        role: 'BUYER'
      }
    }),
  linkGoogleAccount: (id: string, googleId: string, avatarUrl?: string | null) =>
    prisma.user.update({
      where: { id },
      data: { googleId, ...(avatarUrl !== undefined ? { avatarUrl } : {}) }
    }),
  linkYandexAccount: (id: string, yandexId: string, avatarUrl?: string | null, phone?: string | null, phoneVerifiedAt?: Date | null) =>
    prisma.user.update({
      where: { id },
      data: {
        yandexId,
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
        ...(phone ? { phone, phoneVerifiedAt: phoneVerifiedAt ?? null } : {})
      }
    }),
  updateProfile: (
    id: string,
    payload: {
      name?: string;
      email?: string;
      phone?: string | null;
      phoneVerifiedAt?: Date | null;
      address?: string | null;
      fullName?: string | null;
    }
  ) =>
    prisma.user.update({
      where: { id },
      data: payload
    }),
  updatePassword: (id: string, passwordHash: string) =>
    prisma.user.update({
      where: { id },
      data: { passwordHash }
    }),
  updatePasswordAndInvalidateSessions: (id: string, passwordHash: string) =>
    prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id },
        data: { passwordHash }
      });
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      return user;
    })
};
