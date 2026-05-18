"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminChatRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const authMiddleware_1 = require("../middleware/authMiddleware");
const prisma_1 = require("../lib/prisma");
const rateLimiters_1 = require("../middleware/rateLimiters");
const statusLabels_1 = require("../utils/statusLabels");
exports.adminChatRoutes = (0, express_1.Router)();
const DEFAULT_SUPPORT_TOPIC = 'GENERAL';
const listSchema = zod_1.z.object({
    status: zod_1.z.enum(['ACTIVE', 'CLOSED']).optional(),
    q: zod_1.z.string().trim().min(1).optional()
});
const messageSchema = zod_1.z.object({
    text: zod_1.z.string().trim().min(1).max(2000)
});
const statusSchema = zod_1.z.object({
    status: zod_1.z.enum(['ACTIVE', 'CLOSED'])
});
const mapThreadStatus = (thread) => ({
    ...thread,
    statusLabelRu: (0, statusLabels_1.getChatThreadStatusLabelRu)(thread.status)
});
exports.adminChatRoutes.use(authMiddleware_1.requireAuth, authMiddleware_1.requireAdmin);
exports.adminChatRoutes.get('/', async (req, res, next) => {
    try {
        const query = listSchema.parse(req.query);
        const where = {};
        if (query.status) {
            where.status = query.status;
        }
        if (query.q) {
            where.OR = [
                { userId: query.q },
                { user: { email: { contains: query.q, mode: 'insensitive' } } }
            ];
        }
        const threads = await prisma_1.prisma.chatThread.findMany({
            where: { ...where, deletedAt: null },
            include: {
                user: { select: { id: true, name: true, email: true } },
                messages: { orderBy: { createdAt: 'desc' }, take: 1 },
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
            },
            orderBy: [
                { lastMessageAt: { sort: 'desc', nulls: 'last' } },
                { createdAt: 'desc' }
            ]
        });
        const shaped = threads.map((thread) => ({
            ...mapThreadStatus(thread),
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
exports.adminChatRoutes.delete('/:chatId', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const existing = await prisma_1.prisma.chatThread.findUnique({ where: { id: req.params.chatId }, select: { id: true } });
        if (!existing) {
            return res.status(404).json({ error: { code: 'CHAT_NOT_FOUND', message: 'Чат не найден.' } });
        }
        await prisma_1.prisma.chatThread.update({
            where: { id: req.params.chatId },
            data: { deletedAt: new Date(), status: 'CLOSED' }
        });
        return res.json({ ok: true, data: { id: req.params.chatId, deleted: true } });
    }
    catch (error) {
        next(error);
    }
});
exports.adminChatRoutes.get('/:id', async (req, res, next) => {
    try {
        const thread = await prisma_1.prisma.chatThread.findUnique({
            where: { id: req.params.id },
            include: {
                user: { select: { id: true, name: true, email: true } },
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
            }
        });
        if (!thread || thread.deletedAt) {
            return res.status(404).json({ error: { code: 'CHAT_NOT_FOUND' } });
        }
        const messages = await prisma_1.prisma.chatMessage.findMany({
            where: { threadId: thread.id },
            orderBy: { createdAt: 'asc' }
        });
        res.json({
            data: {
                thread: {
                    ...mapThreadStatus(thread),
                    supportTopic: thread.supportTopic ?? (thread.kind === 'SUPPORT' ? DEFAULT_SUPPORT_TOPIC : null)
                },
                messages
            }
        });
    }
    catch (error) {
        next(error);
    }
});
exports.adminChatRoutes.post('/:id/messages', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = messageSchema.parse(req.body);
        const thread = await prisma_1.prisma.chatThread.findUnique({ where: { id: req.params.id } });
        if (!thread) {
            return res.status(404).json({ error: { code: 'CHAT_NOT_FOUND' } });
        }
        if (thread.status === 'CLOSED') {
            return res.status(403).json({ error: { code: 'CHAT_CLOSED' } });
        }
        const message = await prisma_1.prisma.chatMessage.create({
            data: {
                threadId: thread.id,
                authorRole: 'ADMIN',
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
exports.adminChatRoutes.patch('/:id', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = statusSchema.parse(req.body);
        const updated = await prisma_1.prisma.chatThread.update({
            where: { id: req.params.id },
            data: { status: payload.status }
        });
        res.json({ data: mapThreadStatus(updated) });
    }
    catch (error) {
        next(error);
    }
});
