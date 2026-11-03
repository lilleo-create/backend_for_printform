import { prisma } from '../lib/prisma';

export const findAuthorizedTracking = (trackingNumber: string, user: { userId: string; isAdmin: boolean }) =>
  prisma.orderShipment.findFirst({
    where: {
      order: user.isAdmin
        ? { trackingNumber }
        : {
            trackingNumber,
            OR: [
              { buyerId: user.userId },
              { items: { some: { product: { sellerId: user.userId } } } }
            ]
          }
    },
    select: { status: true, updatedAt: true, order: { select: { trackingNumber: true, carrier: true } } }
  });
