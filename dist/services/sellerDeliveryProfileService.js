"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sellerDeliveryProfileService = void 0;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const toDto = (profile) => ({
    id: profile.id,
    sellerId: profile.sellerId,
    dropoffPvzId: profile.dropoffPvzId,
    dropoffOperatorStationId: profile.dropoffOperatorStationId,
    dropoffPlatformStationId: profile.dropoffPlatformStationId,
    dropoffStationMeta: profile.dropoffStationMeta && typeof profile.dropoffStationMeta === 'object' && !Array.isArray(profile.dropoffStationMeta)
        ? profile.dropoffStationMeta
        : null,
    dropoffSchedule: profile.dropoffSchedule,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
});
const toJsonInput = (value) => {
    if (value === undefined)
        return undefined;
    if (value === null)
        return client_1.Prisma.DbNull;
    return value;
};
exports.sellerDeliveryProfileService = {
    getBySellerId: async (sellerId) => {
        const profile = await prisma_1.prisma.sellerDeliveryProfile.findUnique({ where: { sellerId } });
        return profile ? toDto(profile) : null;
    },
    upsert: async (sellerId, payload) => {
        const profile = await prisma_1.prisma.sellerDeliveryProfile.upsert({
            where: { sellerId },
            create: {
                sellerId,
                dropoffPvzId: payload.dropoffPvzId ?? null,
                dropoffOperatorStationId: payload.dropoffOperatorStationId ?? null,
                dropoffPlatformStationId: payload.dropoffPlatformStationId ?? null,
                dropoffStationMeta: toJsonInput(payload.dropoffStationMeta),
                dropoffSchedule: payload.dropoffSchedule ?? 'DAILY'
            },
            update: {
                ...(payload.dropoffPvzId !== undefined ? { dropoffPvzId: payload.dropoffPvzId } : {}),
                ...(payload.dropoffOperatorStationId !== undefined
                    ? { dropoffOperatorStationId: payload.dropoffOperatorStationId }
                    : {}),
                ...(payload.dropoffPlatformStationId !== undefined
                    ? { dropoffPlatformStationId: payload.dropoffPlatformStationId }
                    : {}),
                ...(payload.dropoffStationMeta !== undefined ? { dropoffStationMeta: toJsonInput(payload.dropoffStationMeta) } : {}),
                ...(payload.dropoffSchedule ? { dropoffSchedule: payload.dropoffSchedule } : {})
            }
        });
        return toDto(profile);
    }
};
