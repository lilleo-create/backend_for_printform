"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userRepository = void 0;
const prisma_1 = require("../lib/prisma");
exports.userRepository = {
    findByEmail: (email) => prisma_1.prisma.user.findUnique({ where: { email } }),
    findByPhone: (phone) => prisma_1.prisma.user.findUnique({ where: { phone } }),
    findById: (id) => prisma_1.prisma.user.findUnique({ where: { id } }),
    create: (data) => prisma_1.prisma.user.create({
        data: {
            ...data,
            role: data.role ?? 'BUYER'
        }
    }),
    updateProfile: (id, payload) => prisma_1.prisma.user.update({
        where: { id },
        data: payload
    }),
    updatePassword: (id, passwordHash) => prisma_1.prisma.user.update({
        where: { id },
        data: { passwordHash }
    })
};
