import { prisma } from '../lib/prisma';

export const userRepository = {
  findByEmail: (email: string) => prisma.user.findUnique({ where: { email } }),
  findByPhone: (phone: string) => prisma.user.findUnique({ where: { phone } }),
  findById: (id: string) => prisma.user.findUnique({ where: { id } }),
  create: (data: {
    name: string;
    email: string;
    fullName?: string | null;
    passwordHash: string;
    role?: 'BUYER' | 'SELLER';
    phone?: string | null;
    address?: string | null;
  }) =>
    prisma.user.create({
      data: {
        ...data,
        role: data.role ?? 'BUYER'
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
