import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

type SellerDeliveryProfilePayload = {
  dropoffPvzId?: string | null;
  dropoffOperatorStationId?: string | null;
  dropoffPlatformStationId?: string | null;
  dropoffStationMeta?: Record<string, unknown>;
  dropoffSchedule?: 'DAILY' | 'WEEKDAYS';
};

const toDto = (profile: {
  id: string;
  sellerId: string;
  dropoffPvzId: string | null;
  dropoffOperatorStationId: string | null;
  dropoffPlatformStationId: string | null;
  dropoffStationMeta: unknown;
  dropoffSchedule: 'DAILY' | 'WEEKDAYS';
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: profile.id,
  sellerId: profile.sellerId,
  dropoffPvzId: profile.dropoffPvzId,
  dropoffOperatorStationId: profile.dropoffOperatorStationId,
  dropoffPlatformStationId: profile.dropoffPlatformStationId,
  dropoffStationMeta:
    profile.dropoffStationMeta && typeof profile.dropoffStationMeta === 'object' && !Array.isArray(profile.dropoffStationMeta)
      ? (profile.dropoffStationMeta as Record<string, unknown>)
      : null,
  dropoffSchedule: profile.dropoffSchedule,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt
});

const toJsonInput = (
  value?: Record<string, unknown> | null
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonObject;
};

export const sellerDeliveryProfileService = {
  getBySellerId: async (sellerId: string) => {
    const profile = await prisma.sellerDeliveryProfile.findUnique({ where: { sellerId } });
    return profile ? toDto(profile) : null;
  },

  upsert: async (sellerId: string, payload: SellerDeliveryProfilePayload) => {
    const profile = await prisma.sellerDeliveryProfile.upsert({
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
