import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/authMiddleware';
import { userRepository } from '../repositories/userRepository';
import { orderUseCases } from '../usecases/orderUseCases';
import { reviewService } from '../services/reviewService';
import { writeLimiter } from '../middleware/rateLimiters';
import { prisma } from '../lib/prisma';
import { orderDeliveryService } from '../services/orderDeliveryService';
import { shipmentService } from '../services/shipmentService';

export const meRoutes = Router();

const addressSchema = z.object({
  addressText: z.string().min(3),
  apartment: z.string().optional(),
  floor: z.string().optional(),
  label: z.string().optional(),
  isFavorite: z.boolean().optional(),
  courierComment: z.string().optional(),
  coords: z
    .object({
      lat: z.number(),
      lon: z.number()
    })
    .nullable()
    .optional()
});

const contactSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(5),
  email: z.string().email().optional()
});

meRoutes.get('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const user = await userRepository.findById(req.user!.userId);
    if (!user) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }
    res.json({
      data: {
        id: user.id,
        name: user.name,
        fullName: user.fullName,
        role: user.role,
        roles: {
          isAdmin: req.user!.isAdmin,
          isSeller: req.user!.isSeller,
          isBuyer: true
        },
        capabilities: {
          canAccessAdmin: req.user!.isAdmin,
          canAccessSeller: req.user!.isSeller
        },
        email: user.email
      }
    });
  } catch (error) {
    next(error);
  }
});

meRoutes.get('/addresses', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const addresses = await prisma.address.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ data: addresses });
  } catch (error) {
    next(error);
  }
});

meRoutes.get('/addresses/default', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const address = await prisma.address.findFirst({
      where: { userId: req.user!.userId, isDefault: true }
    });
    res.json({ data: address ?? null });
  } catch (error) {
    next(error);
  }
});

meRoutes.post('/addresses', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = addressSchema.parse(req.body);
    const existingDefault = await prisma.address.findFirst({
      where: { userId: req.user!.userId, isDefault: true }
    });
    const created = await prisma.address.create({
      data: {
        userId: req.user!.userId,
        addressText: payload.addressText,
        apartment: payload.apartment,
        floor: payload.floor,
        label: payload.label,
        isFavorite: payload.isFavorite ?? false,
        courierComment: payload.courierComment,
        coords: payload.coords ?? undefined,
        isDefault: existingDefault ? false : true
      }
    });
    res.status(201).json({ data: created });
  } catch (error) {
    next(error);
  }
});

meRoutes.patch('/addresses/:id', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = addressSchema.partial().parse(req.body);
    const existing = await prisma.address.findFirst({
      where: { id: req.params.id, userId: req.user!.userId }
    });
    if (!existing) {
      return res.status(404).json({ error: { code: 'ADDRESS_NOT_FOUND' } });
    }
    const updated = await prisma.address.update({
      where: { id: req.params.id },
      data: {
        addressText: payload.addressText ?? existing.addressText,
        apartment: payload.apartment ?? existing.apartment,
        floor: payload.floor ?? existing.floor,
        label: payload.label ?? existing.label,
        isFavorite: payload.isFavorite ?? existing.isFavorite,
        courierComment: payload.courierComment ?? existing.courierComment,
        coords: payload.coords ?? existing.coords ?? undefined
      }
    });
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

meRoutes.delete('/addresses/:id', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const existing = await prisma.address.findFirst({
      where: { id: req.params.id, userId: req.user!.userId }
    });
    if (!existing) {
      return res.status(404).json({ error: { code: 'ADDRESS_NOT_FOUND' } });
    }
    await prisma.address.delete({ where: { id: req.params.id } });
    if (existing.isDefault) {
      const next = await prisma.address.findFirst({
        where: { userId: req.user!.userId },
        orderBy: { createdAt: 'desc' }
      });
      if (next) {
        await prisma.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

meRoutes.post('/addresses/:id/default', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const address = await prisma.address.findFirst({
      where: { id: req.params.id, userId: req.user!.userId }
    });
    if (!address) {
      return res.status(404).json({ error: { code: 'ADDRESS_NOT_FOUND' } });
    }
    await prisma.address.updateMany({
      where: { userId: req.user!.userId, isDefault: true },
      data: { isDefault: false }
    });
    const updated = await prisma.address.update({
      where: { id: req.params.id },
      data: { isDefault: true }
    });
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

meRoutes.get('/contacts', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const contacts = await prisma.contact.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ data: contacts });
  } catch (error) {
    next(error);
  }
});

meRoutes.post('/contacts', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = contactSchema.parse(req.body);
    const created = await prisma.contact.create({
      data: {
        userId: req.user!.userId,
        name: payload.name,
        phone: payload.phone,
        email: payload.email
      }
    });
    res.status(201).json({ data: created });
  } catch (error) {
    next(error);
  }
});

meRoutes.patch('/contacts/:id', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = contactSchema.partial().parse(req.body);
    const existing = await prisma.contact.findFirst({
      where: { id: req.params.id, userId: req.user!.userId }
    });
    if (!existing) {
      return res.status(404).json({ error: { code: 'CONTACT_NOT_FOUND' } });
    }
    const updated = await prisma.contact.update({
      where: { id: req.params.id },
      data: {
        name: payload.name ?? existing.name,
        phone: payload.phone ?? existing.phone,
        email: payload.email ?? existing.email
      }
    });
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});


const toShipmentView = (shipment: any) => {
  if (!shipment) return null;
  return {
    id: shipment.id,
    provider: shipment.provider,
    status: shipment.status,
    sourceStationId: shipment.sourceStationId,
    destinationStationId: shipment.destinationStationId,
    lastSyncAt: shipment.lastSyncAt,
    updatedAt: shipment.updatedAt
  };
};

meRoutes.get('/orders', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const orders = await orderUseCases.listByBuyer(req.user!.userId);
    const deliveries = await orderDeliveryService.getByOrderIds(orders.map((order) => order.id));
    const shipments = await shipmentService.getByOrderIds(orders.map((order) => order.id));
    res.json({
      data: orders.map((order) => ({
        ...order,
        delivery: deliveries.get(order.id) ?? null,
        shipment: toShipmentView(shipments.get(order.id) ?? null)
      }))
    });
  } catch (error) {
    next(error);
  }
});


meRoutes.patch('/orders/:id/cancel', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, buyerId: req.user!.userId },
      include: { shipment: true }
    });

    if (!order) {
      return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });
    }

    const shipmentStatus = String(order.shipment?.status ?? '').toUpperCase();
    const isSentToDelivery = ['HANDED_TO_DELIVERY', 'IN_TRANSIT', 'DELIVERED'].includes(order.status) || ['IN_TRANSIT', 'DELIVERED'].includes(shipmentStatus);

    if (isSentToDelivery) {
      return res.status(409).json({ error: { code: 'ORDER_ALREADY_SHIPPED', message: 'Заказ уже отправлен в доставку. Доступен только возврат.' } });
    }

    const cancelled = await prisma.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED', statusUpdatedAt: new Date() }
    });

    return res.json({ data: cancelled });
  } catch (error) {
    next(error);
  }
});

const reviewVisibilitySchema = z.object({
  isPublic: z.boolean()
});

meRoutes.get('/reviews', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const reviews = await reviewService.listByUser(req.user!.userId);
    res.json({ data: reviews });
  } catch (error) {
    next(error);
  }
});

meRoutes.patch('/reviews/:id/visibility', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = reviewVisibilitySchema.parse(req.body);
    const updated = await reviewService.updateVisibility(req.params.id, req.user!.userId, payload.isPublic);
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});
