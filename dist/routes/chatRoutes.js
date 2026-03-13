"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const authMiddleware_1 = require("../middleware/authMiddleware");
const prisma_1 = require("../lib/prisma");
const rateLimiters_1 = require("../middleware/rateLimiters");
exports.chatRoutes = (0, express_1.Router)();
const paginationSchema = zod_1.z.object({
    limit: zod_1.z.coerce.number().int().positive().max(100).default(50),
    before: zod_1.z.string().datetime().optional()
});
const messageSchema = zod_1.z.object({
    text: zod_1.z.string().trim().min(1).max(2000)
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
            ...thread,
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
            include: {
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
                thread,
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
