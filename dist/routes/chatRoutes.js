"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatRoutes = void 0;
const client_1 = require("@prisma/client");
const express_1 = require("express");
const zod_1 = require("zod");
const authMiddleware_1 = require("../middleware/authMiddleware");
const prisma_1 = require("../lib/prisma");
const rateLimiters_1 = require("../middleware/rateLimiters");
exports.chatRoutes = (0, express_1.Router)();
const DEFAULT_SUPPORT_TOPIC = 'GENERAL';
const paginationSchema = zod_1.z.object({
    limit: zod_1.z.coerce.number().int().positive().max(100).default(50),
    before: zod_1.z.string().datetime().optional()
});
const messageSchema = zod_1.z.object({
    text: zod_1.z.string().trim().min(1).max(2000)
});
const supportTopicSchema = zod_1.z.string().trim().min(1).max(120).optional();
const sellerCreateThreadSchema = zod_1.z.object({
    kind: zod_1.z.literal('SELLER'),
    sellerId: zod_1.z.string().trim().min(1).optional(),
    shopId: zod_1.z.string().trim().min(1)
});
const supportCreateThreadSchema = zod_1.z.object({
    kind: zod_1.z.literal('SUPPORT'),
    topic: supportTopicSchema,
    isGeneralQuestion: zod_1.z.boolean().optional()
});
const createThreadSchema = zod_1.z.union([sellerCreateThreadSchema, supportCreateThreadSchema]);
const includeThreadRelations = {
    returnRequest: {
        include: {
            photos: true,
            items: {
                include: {
                    orderItem: {
                        include: { product: true, order: true }
                    }
                }
            }
        }
    }
};
const normalizeSupportTopic = (payload) => {
    if (payload.isGeneralQuestion) {
        return DEFAULT_SUPPORT_TOPIC;
    }
    const topic = payload.topic?.trim();
    return topic && topic.length > 0 ? topic : DEFAULT_SUPPORT_TOPIC;
};
const dedupeCreateSellerThread = async (params) => {
    const where = {
        kind: 'SELLER',
        userId: params.userId,
        sellerId: params.sellerId,
        shopId: params.shopId,
        returnRequestId: null
    };
    const existing = await prisma_1.prisma.chatThread.findFirst({ where, include: includeThreadRelations });
    if (existing) {
        return { thread: existing, created: false };
    }
    try {
        const created = await prisma_1.prisma.chatThread.create({
            data: {
                kind: 'SELLER',
                status: 'ACTIVE',
                userId: params.userId,
                sellerId: params.sellerId,
                shopId: params.shopId
            },
            include: includeThreadRelations
        });
        return { thread: created, created: true };
    }
    catch (error) {
        if (error instanceof client_1.Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002') {
            const thread = await prisma_1.prisma.chatThread.findFirst({ where, include: includeThreadRelations });
            if (thread) {
                return { thread, created: false };
            }
        }
        throw error;
    }
};
const dedupeCreateSupportThread = async (params) => {
    try {
        const created = await prisma_1.prisma.chatThread.create({
            data: {
                kind: 'SUPPORT',
                status: 'ACTIVE',
                userId: params.userId,
                supportTopic: params.topic
            },
            include: includeThreadRelations
        });
        return { thread: created, created: true };
    }
    catch (error) {
        throw error;
    }
};
exports.chatRoutes.post('/threads', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = createThreadSchema.parse(req.body ?? {});
        if (payload.kind === 'SELLER') {
            const sellerId = payload.sellerId ?? payload.shopId;
            if (payload.sellerId && payload.sellerId !== payload.shopId) {
                return res.status(400).json({ error: { code: 'SELLER_THREAD_SCOPE_MISMATCH' } });
            }
            const seller = await prisma_1.prisma.user.findFirst({
                where: { id: sellerId, sellerProfile: { isNot: null } },
                select: { id: true }
            });
            if (!seller) {
                return res.status(404).json({ error: { code: 'SELLER_NOT_FOUND' } });
            }
            const result = await dedupeCreateSellerThread({
                userId: req.user.userId,
                sellerId,
                shopId: payload.shopId
            });
            return res.status(result.created ? 201 : 200).json({ data: { thread: result.thread, created: result.created } });
        }
        const topic = normalizeSupportTopic(payload);
        const result = await dedupeCreateSupportThread({ userId: req.user.userId, topic });
        return res.status(201).json({
            data: {
                thread: result.thread,
                created: result.created,
                topic: result.thread.supportTopic ?? DEFAULT_SUPPORT_TOPIC
            }
        });
    }
    catch (error) {
        next(error);
    }
});
exports.chatRoutes.get('/my', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        const threads = await prisma_1.prisma.chatThread.findMany({
            where: { userId: req.user.userId },
            include: {
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1
                },
                ...includeThreadRelations
            },
            orderBy: [
                { lastMessageAt: { sort: 'desc', nulls: 'last' } },
                { createdAt: 'desc' }
            ]
        });
        const shaped = threads.map((thread) => ({
            ...thread,
            supportTopic: thread.supportTopic ?? (thread.kind === 'SUPPORT' ? DEFAULT_SUPPORT_TOPIC : null),
            lastMessage: thread.messages[0] ?? null,
            messages: undefined
        }));
        res.json({
            data: {
                active: shaped.filter((thread) => thread.status === 'ACTIVE'),
                closed: shaped.filter((thread) => thread.status === 'CLOSED')
            }
        });
    }
    catch (error) {
        next(error);
    }
});
exports.chatRoutes.get('/:id', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        const params = paginationSchema.parse(req.query);
        const thread = await prisma_1.prisma.chatThread.findFirst({
            where: { id: req.params.id, userId: req.user.userId },
            include: includeThreadRelations
        });
        if (!thread) {
            return res.status(404).json({ error: { code: 'CHAT_NOT_FOUND' } });
        }
        const messages = await prisma_1.prisma.chatMessage.findMany({
            where: {
                threadId: thread.id,
                ...(params.before ? { createdAt: { lt: new Date(params.before) } } : {})
            },
            orderBy: { createdAt: 'desc' },
            take: params.limit
        });
        res.json({
            data: {
                thread: {
                    ...thread,
                    supportTopic: thread.supportTopic ?? (thread.kind === 'SUPPORT' ? DEFAULT_SUPPORT_TOPIC : null)
                },
                messages: [...messages].reverse()
            }
        });
    }
    catch (error) {
        next(error);
    }
});
exports.chatRoutes.post('/:id/messages', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = messageSchema.parse(req.body);
        const thread = await prisma_1.prisma.chatThread.findFirst({
            where: { id: req.params.id, userId: req.user.userId }
        });
        if (!thread) {
            return res.status(404).json({ error: { code: 'CHAT_NOT_FOUND' } });
        }
        if (thread.status === 'CLOSED') {
            return res.status(403).json({ error: { code: 'CHAT_CLOSED' } });
        }
        const message = await prisma_1.prisma.chatMessage.create({
            data: {
                threadId: thread.id,
                authorRole: 'USER',
                authorId: req.user.userId,
                text: payload.text
            }
        });
        await prisma_1.prisma.chatThread.update({
            where: { id: thread.id },
            data: { lastMessageAt: message.createdAt }
        });
        res.status(201).json({ data: message });
    }
    catch (error) {
        next(error);
    }
});
