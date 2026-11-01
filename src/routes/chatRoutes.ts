import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/authMiddleware';
import { prisma } from '../lib/prisma';
import { writeLimiter } from '../middleware/rateLimiters';
import { getChatThreadStatusLabelRu } from '../utils/statusLabels';
import { chatImageUpload, persistChatImages, discardChatImages } from '../services/chatImages';
import { ORDINARY_SUPPORT_WHERE, writeSupportMessage } from '../services/activeSupportChatService';

export const chatRoutes = Router();

const DEFAULT_SUPPORT_TOPIC = 'GENERAL';

const paginationSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  before: z.string().datetime().optional()
});

const messageSchema = z.object({ text: z.string().trim().max(2000).optional() }).strict();
const supportMessageSchema = messageSchema.extend({ topic: z.string().trim().min(1).max(120).optional() });

const supportTopicSchema = z.string().trim().min(1).max(120).optional();

const sellerCreateThreadSchema = z.object({
  kind: z.literal('SELLER'),
  sellerId: z.string().trim().min(1).optional(),
  shopId: z.string().trim().min(1)
});

const supportCreateThreadSchema = z.object({
  kind: z.literal('SUPPORT'),
  topic: supportTopicSchema,
  isGeneralQuestion: z.boolean().optional()
});

const createThreadSchema = z.union([sellerCreateThreadSchema, supportCreateThreadSchema]);

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
} satisfies Prisma.ChatThreadInclude;

const normalizeSupportTopic = (payload: { topic?: string; isGeneralQuestion?: boolean }) => {
  if (payload.isGeneralQuestion) {
    return DEFAULT_SUPPORT_TOPIC;
  }
  const topic = payload.topic?.trim();
  return topic && topic.length > 0 ? topic : DEFAULT_SUPPORT_TOPIC;
};

const dedupeCreateSellerThread = async (params: { userId: string; sellerId: string; shopId: string }) => {
  const where = {
    kind: 'SELLER' as const,
    userId: params.userId,
    sellerId: params.sellerId,
    shopId: params.shopId,
    returnRequestId: null
  };

  const existing = await prisma.chatThread.findFirst({ where, include: includeThreadRelations });
  if (existing) {
    return { thread: existing, created: false as const };
  }

  try {
    const created = await prisma.chatThread.create({
      data: {
        kind: 'SELLER',
        status: 'ACTIVE',
        userId: params.userId,
        sellerId: params.sellerId,
        shopId: params.shopId
      },
      include: includeThreadRelations
    });
    return { thread: created, created: true as const };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const thread = await prisma.chatThread.findFirst({ where, include: includeThreadRelations });
      if (thread) {
        return { thread, created: false as const };
      }
    }
    throw error;
  }
};

const mapThreadStatus = <T extends { status: string }>(thread: T) => ({
  ...thread,
  statusLabelRu: getChatThreadStatusLabelRu(thread.status as any)
});

chatRoutes.post('/threads', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = createThreadSchema.parse(req.body ?? {});

    if (payload.kind === 'SELLER') {
      const sellerId = payload.sellerId ?? payload.shopId;
      if (payload.sellerId && payload.sellerId !== payload.shopId) {
        return res.status(400).json({ error: { code: 'SELLER_THREAD_SCOPE_MISMATCH' } });
      }
      const seller = await prisma.user.findFirst({
        where: { id: sellerId, sellerProfile: { isNot: null } },
        select: { id: true }
      });

      if (!seller) {
        return res.status(404).json({ error: { code: 'SELLER_NOT_FOUND' } });
      }

      const result = await dedupeCreateSellerThread({
        userId: req.user!.userId,
        sellerId,
        shopId: payload.shopId
      });

      return res.status(result.created ? 201 : 200).json({ data: { thread: mapThreadStatus(result.thread), created: result.created } });
    }

    const topic = normalizeSupportTopic(payload);
    const thread = await prisma.chatThread.findFirst({ where: { ...ORDINARY_SUPPORT_WHERE, userId: req.user!.userId } });
    if (!thread) return res.status(409).json({ error: { code: 'SUPPORT_MESSAGE_REQUIRED' } });
    return res.status(200).json({
      data: {
        thread: mapThreadStatus(thread),
        created: false,
        topic: thread.supportTopic ?? topic
      }
    });
  } catch (error) {
    next(error);
  }
});

const sendSupportMessage = async (req: AuthRequest, res: import('express').Response, next: import('express').NextFunction) => {
  let savedPaths: string[] = [];
  try {
    const payload = supportMessageSchema.parse(req.body ?? {});
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const text = payload.text ?? '';
    if (!text && !files.length) return res.status(400).json({ error: { code: 'CHAT_MESSAGE_EMPTY' } });
    const saved = await persistChatImages(files);
    savedPaths = saved.paths;
    const result = await writeSupportMessage({
      userId: req.user!.userId,
      topic: normalizeSupportTopic(payload),
      text,
      attachments: saved.attachments
    });
    return res.status(result.created ? 201 : 200).json({
      data: { ...result, thread: mapThreadStatus(result.thread) }
    });
  } catch (error) {
    await discardChatImages(savedPaths);
    if (error instanceof Error && ['CHAT_IMAGE_TYPE_INVALID', 'CHAT_IMAGE_TOO_LARGE'].includes(error.message)) {
      return res.status(400).json({ error: { code: error.message } });
    }
    next(error);
  }
};

chatRoutes.post('/support/messages', requireAuth, writeLimiter, chatImageUpload, sendSupportMessage);
chatRoutes.post('/support/quick-message', requireAuth, writeLimiter, chatImageUpload, sendSupportMessage);

chatRoutes.get('/my', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const threads = await prisma.chatThread.findMany({
      where: { userId: req.user!.userId, deletedAt: null },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { attachments: true }
        },
        ...includeThreadRelations
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
  } catch (error) {
    next(error);
  }
});

chatRoutes.get('/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const params = paginationSchema.parse(req.query);
    const thread = await prisma.chatThread.findFirst({
      where: { id: req.params.id, userId: req.user!.userId, deletedAt: null },
      include: includeThreadRelations
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
      take: params.limit,
      include: { attachments: true }
    });

    res.json({
      data: {
        thread: {
          ...mapThreadStatus(thread),
          supportTopic: thread.supportTopic ?? (thread.kind === 'SUPPORT' ? DEFAULT_SUPPORT_TOPIC : null)
        },
        messages: [...messages].reverse()
      }
    });
  } catch (error) {
    next(error);
  }
});

chatRoutes.post('/:id/messages', requireAuth, writeLimiter, chatImageUpload, async (req: AuthRequest, res, next) => {
  let savedPaths: string[] = [];
  try {
    const payload = messageSchema.parse(req.body ?? {});
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const text = payload.text ?? '';
    if (!text && !files.length) return res.status(400).json({ error: { code: 'CHAT_MESSAGE_EMPTY' } });
    const thread = await prisma.chatThread.findFirst({
      where: { id: req.params.id, userId: req.user!.userId, deletedAt: null }
    });
    if (!thread) {
      return res.status(404).json({ error: { code: 'CHAT_NOT_FOUND' } });
    }
    if (thread.status === 'CLOSED') {
      return res.status(403).json({ error: { code: 'CHAT_CLOSED' } });
    }
    const saved = await persistChatImages(files);
    savedPaths = saved.paths;
    const message = await prisma.$transaction(async tx => {
      const createdMessage = await tx.chatMessage.create({
        data: {
          threadId: thread.id,
          authorRole: 'USER',
          authorId: req.user!.userId,
          text,
          attachments: { create: saved.attachments }
        },
        include: { attachments: true }
      });
      const firstMessage = thread.kind === 'SUPPORT' && !thread.returnRequestId
        && (await tx.chatMessage.count({ where: { threadId: thread.id } })) === 1;
      const acknowledgement = firstMessage ? await tx.chatMessage.create({
        data: { threadId: thread.id, authorRole: 'ADMIN', authorId: 'SYSTEM_SUPPORT', text: 'Сейчас позову оператора.' }
      }) : null;
      await tx.chatThread.update({
        where: { id: thread.id },
        data: { lastMessageAt: acknowledgement?.createdAt ?? createdMessage.createdAt }
      });
      return createdMessage;
    });
    res.status(201).json({ data: message });
  } catch (error) {
    await discardChatImages(savedPaths);
    if (error instanceof Error && ['CHAT_IMAGE_TYPE_INVALID', 'CHAT_IMAGE_TOO_LARGE'].includes(error.message)) {
      return res.status(400).json({ error: { code: error.message } });
    }
    next(error);
  }
});
