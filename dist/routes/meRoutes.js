"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.meRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const authMiddleware_1 = require("../middleware/authMiddleware");
const userRepository_1 = require("../repositories/userRepository");
const orderUseCases_1 = require("../usecases/orderUseCases");
const reviewService_1 = require("../services/reviewService");
const rateLimiters_1 = require("../middleware/rateLimiters");
const prisma_1 = require("../lib/prisma");
const orderDeliveryService_1 = require("../services/orderDeliveryService");
const shipmentService_1 = require("../services/shipmentService");
exports.meRoutes = (0, express_1.Router)();
const addressSchema = zod_1.z.object({
    addressText: zod_1.z.string().min(3),
    apartment: zod_1.z.string().optional(),
    floor: zod_1.z.string().optional(),
    label: zod_1.z.string().optional(),
    isFavorite: zod_1.z.boolean().optional(),
    courierComment: zod_1.z.string().optional(),
    coords: zod_1.z
        .object({
        lat: zod_1.z.number(),
        lon: zod_1.z.number()
    })
        .nullable()
        .optional()
});
const contactSchema = zod_1.z.object({
    name: zod_1.z.string().min(2),
    phone: zod_1.z.string().min(5),
    email: zod_1.z.string().email().optional()
});
exports.meRoutes.get('/', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        const user = await userRepository_1.userRepository.findById(req.user.userId);
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
                    isAdmin: req.user.isAdmin,
                    isSeller: req.user.isSeller,
                    isBuyer: true
                },
                capabilities: {
                    canAccessAdmin: req.user.isAdmin,
                    canAccessSeller: req.user.isSeller
                },
                email: user.email
            }
        });
    }
    catch (error) {
        next(error);
    }
});
exports.meRoutes.get('/addresses', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        const addresses = await prisma_1.prisma.address.findMany({
            where: { userId: req.user.userId },
            orderBy: { createdAt: 'desc' }
        });
        res.json({ data: addresses });
    }
    catch (error) {
        next(error);
    }
});
exports.meRoutes.get('/addresses/default', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        const address = await prisma_1.prisma.address.findFirst({
            where: { userId: req.user.userId, isDefault: true }
        });
        res.json({ data: address ?? null });
    }
    catch (error) {
        next(error);
    }
});
exports.meRoutes.post('/addresses', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = addressSchema.parse(req.body);
        const existingDefault = await prisma_1.prisma.address.findFirst({
            where: { userId: req.user.userId, isDefault: true }
        });
        const created = await prisma_1.prisma.address.create({
            data: {
                userId: req.user.userId,
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
    }
    catch (error) {
        next(error);
    }
});
exports.meRoutes.patch('/addresses/:id', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = addressSchema.partial().parse(req.body);
        const existing = await prisma_1.prisma.address.findFirst({
            where: { id: req.params.id, userId: req.user.userId }
        });
        if (!existing) {
            return res.status(404).json({ error: { code: 'ADDRESS_NOT_FOUND' } });
        }
        const updated = await prisma_1.prisma.address.update({
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
    }
    catch (error) {
        next(error);
    }
});
exports.meRoutes.delete('/addresses/:id', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const existing = await prisma_1.prisma.address.findFirst({
            where: { id: req.params.id, userId: req.user.userId }
        });
        if (!existing) {
            return res.status(404).json({ error: { code: 'ADDRESS_NOT_FOUND' } });
        }
        await prisma_1.prisma.address.delete({ where: { id: req.params.id } });
        if (existing.isDefault) {
            const next = await prisma_1.prisma.address.findFirst({
                where: { userId: req.user.userId },
                orderBy: { createdAt: 'desc' }
            });
            if (next) {
                await prisma_1.prisma.address.update({ where: { id: next.id }, data: { isDefault: true } });
            }
        }
        res.json({ success: true });
    }
    catch (error) {
        next(error);
    }
});
exports.meRoutes.post('/addresses/:id/default', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const address = await prisma_1.prisma.address.findFirst({
            where: { id: req.params.id, userId: req.user.userId }
        });
        if (!address) {
            return res.status(404).json({ error: { code: 'ADDRESS_NOT_FOUND' } });
        }
        await prisma_1.prisma.address.updateMany({
            where: { userId: req.user.userId, isDefault: true },
            data: { isDefault: false }
        });
        const updated = await prisma_1.prisma.address.update({
            where: { id: req.params.id },
            data: { isDefault: true }
        });
        res.json({ data: updated });
    }
    catch (error) {
        next(error);
    }
});
exports.meRoutes.get('/contacts', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        const contacts = await prisma_1.prisma.contact.findMany({
            where: { userId: req.user.userId },
            orderBy: { createdAt: 'desc' }
        });
        res.json({ data: contacts });
    }
    catch (error) {
        next(error);
    }
});
exports.meRoutes.post('/contacts', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = contactSchema.parse(req.body);
        const created = await prisma_1.prisma.contact.create({
            data: {
                userId: req.user.userId,
                name: payload.name,
                phone: payload.phone,
                email: payload.email
            }
        });
        res.status(201).json({ data: created });
    }
    catch (error) {
        next(error);
    }
});
exports.meRoutes.patch('/contacts/:id', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = contactSchema.partial().parse(req.body);
        const existing = await prisma_1.prisma.contact.findFirst({
            where: { id: req.params.id, userId: req.user.userId }
        });
        if (!existing) {
            return res.status(404).json({ error: { code: 'CONTACT_NOT_FOUND' } });
        }
        const updated = await prisma_1.prisma.contact.update({
            where: { id: req.params.id },
            data: {
                name: payload.name ?? existing.name,
                phone: payload.phone ?? existing.phone,
                email: payload.email ?? existing.email
            }
        });
        res.json({ data: updated });
    }
    catch (error) {
        next(error);
    }
});
const toShipmentView = (shipment) => {
    if (!shipment)
        return null;
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
exports.meRoutes.get('/orders', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        const orders = await orderUseCases_1.orderUseCases.listByBuyer(req.user.userId);
        const deliveries = await orderDeliveryService_1.orderDeliveryService.getByOrderIds(orders.map((order) => order.id));
        const shipments = await shipmentService_1.shipmentService.getByOrderIds(orders.map((order) => order.id));
        res.json({
            data: orders.map((order) => ({
                ...order,
                delivery: deliveries.get(order.id) ?? null,
                shipment: toShipmentView(shipments.get(order.id) ?? null)
            }))
        });
    }
    catch (error) {
        next(error);
    }
});
exports.meRoutes.patch('/orders/:id/cancel', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const order = await prisma_1.prisma.order.findFirst({
            where: { id: req.params.id, buyerId: req.user.userId },
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
        const cancelled = await prisma_1.prisma.order.update({
            where: { id: order.id },
            data: { status: 'CANCELLED', statusUpdatedAt: new Date() }
        });
        return res.json({ data: cancelled });
    }
    catch (error) {
        next(error);
    }
});
const reviewVisibilitySchema = zod_1.z.object({
    isPublic: zod_1.z.boolean()
});
exports.meRoutes.get('/reviews', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        const reviews = await reviewService_1.reviewService.listByUser(req.user.userId);
        res.json({ data: reviews });
    }
    catch (error) {
        next(error);
    }
});
exports.meRoutes.patch('/reviews/:id/visibility', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = reviewVisibilitySchema.parse(req.body);
        const updated = await reviewService_1.reviewService.updateVisibility(req.params.id, req.user.userId, payload.isPublic);
        res.json({ data: updated });
    }
    catch (error) {
        next(error);
    }
});
