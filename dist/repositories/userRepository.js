"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userRepository = void 0;
const prisma_1 = require("../lib/prisma");
exports.userRepository = {
    findByEmail: (email) => prisma_1.prisma.user.findUnique({ where: { email } }),
    findByPhone: (phone) => prisma_1.prisma.user.findUnique({ where: { phone } }),
    findById: (id) => prisma_1.prisma.user.findUnique({ where: { id } }),
    findByGoogleId: (googleId) => prisma_1.prisma.user.findUnique({ where: { googleId } }),
    create: (data) => prisma_1.prisma.user.create({
        data: {
            ...data,
            role: data.role ?? 'BUYER'
        }
    }),
    createOAuthUser: (data) => prisma_1.prisma.user.create({
        data: {
            email: data.email,
            name: data.name,
            googleId: data.googleId ?? null,
            avatarUrl: data.avatarUrl ?? null,
            phone: data.phone ?? null,
            phoneVerifiedAt: data.phoneVerifiedAt ?? null,
            role: 'BUYER'
        }
    }),
    linkGoogleAccount: (id, googleId, avatarUrl) => prisma_1.prisma.user.update({
        where: { id },
        data: { googleId, ...(avatarUrl !== undefined ? { avatarUrl } : {}) }
    }),
    updateProfile: (id, payload) => prisma_1.prisma.user.update({
        where: { id },
        data: payload
    }),
    updatePassword: (id, passwordHash) => prisma_1.prisma.user.update({
        where: { id },
        data: { passwordHash }
    }),
    updatePasswordAndInvalidateSessions: (id, passwordHash) => prisma_1.prisma.$transaction(async (tx) => {
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
