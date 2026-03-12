import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/authMiddleware';
import { prisma } from '../lib/prisma';
import { writeLimiter } from '../middleware/rateLimiters';

export const chatRoutes = Router();

const paginationSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  before: z.string().datetime().optional()
});

const messageSchema = z.object({
  text: z.string().trim().min(1).max(2000)
});

chatRoutes.get('/my', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const threads = await prisma.chatThread.findMany({
      where: { userId: req.user!.userId },
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
  } catch (error) {
    next(error);
  }
});

chatRoutes.get('/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const params = paginationSchema.parse(req.query);
    const thread = await prisma.chatThread.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
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

    const messages = await prisma.chatMessage.findMany({
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
  } catch (error) {
    next(error);
  }
});

chatRoutes.post('/:id/messages', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = messageSchema.parse(req.body);
    const thread = await prisma.chatThread.findFirst({
      where: { id: req.params.id, userId: req.user!.userId }
    });
    if (!thread) {
      return res.status(404).json({ error: { code: 'CHAT_NOT_FOUND' } });
    }
    if (thread.status === 'CLOSED') {
      return res.status(403).json({ error: { code: 'CHAT_CLOSED' } });
    }
    const message = await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        authorRole: 'USER',
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
