import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/authMiddleware';
import { prisma } from '../lib/prisma';
import { writeLimiter } from '../middleware/rateLimiters';

export const adminChatRoutes = Router();

const listSchema = z.object({
  status: z.enum(['ACTIVE', 'CLOSED']).optional(),
  q: z.string().trim().min(1).optional()
});

const messageSchema = z.object({
  text: z.string().trim().min(1).max(2000)
});

const statusSchema = z.object({
  status: z.enum(['ACTIVE', 'CLOSED'])
});

adminChatRoutes.use(requireAuth, requireAdmin);

adminChatRoutes.get('/', async (req, res, next) => {
  try {
    const query = listSchema.parse(req.query);
    const where: Prisma.ChatThreadWhereInput = {};
    if (query.status) {
      where.status = query.status;
    }
    if (query.q) {
      where.OR = [
        { userId: query.q },
        { user: { email: { contains: query.q, mode: 'insensitive' } } }
      ];
    }
    const threads = await prisma.chatThread.findMany({
      where,
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
  } catch (error) {
    next(error);
  }
});

adminChatRoutes.get('/:id', async (req, res, next) => {
  try {
    const thread = await prisma.chatThread.findUnique({
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
    if (!thread) {
      return res.status(404).json({ error: { code: 'CHAT_NOT_FOUND' } });
    }
    const messages = await prisma.chatMessage.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: 'asc' }
    });
    res.json({ data: { thread, messages } });
  } catch (error) {
    next(error);
  }
});

adminChatRoutes.post('/:id/messages', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = messageSchema.parse(req.body);
    const thread = await prisma.chatThread.findUnique({ where: { id: req.params.id } });
    if (!thread) {
      return res.status(404).json({ error: { code: 'CHAT_NOT_FOUND' } });
    }
    if (thread.status === 'CLOSED') {
      return res.status(403).json({ error: { code: 'CHAT_CLOSED' } });
    }
    const message = await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        authorRole: 'ADMIN',
        authorId: req.user!.userId,
        text: payload.text
      }
    });
    await prisma.chatThread.update({
      where: { id: thread.id },
      data: { lastMessageAt: message.createdAt }
    });
    res.status(201).json({ data: message });
  } catch (error) {
    next(error);
  }
});

adminChatRoutes.patch('/:id', writeLimiter, async (req, res, next) => {
  try {
    const payload = statusSchema.parse(req.body);
    const updated = await prisma.chatThread.update({
      where: { id: req.params.id },
      data: { status: payload.status }
    });
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});
