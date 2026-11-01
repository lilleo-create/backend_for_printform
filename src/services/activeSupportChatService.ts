import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

export const ORDINARY_SUPPORT_WHERE = {
  kind: 'SUPPORT' as const,
  status: 'ACTIVE' as const,
  returnRequestId: null,
  deletedAt: null
};

const ACKNOWLEDGEMENT = 'Сейчас позову оператора.';

export const getOrCreateActiveSupportThread = async (
  tx: Prisma.TransactionClient,
  userId: string,
  initialTopic: string
) => {
  const existing = await tx.chatThread.findFirst({
    where: { ...ORDINARY_SUPPORT_WHERE, userId },
    orderBy: { createdAt: 'desc' }
  });
  if (existing) return { thread: existing, created: false };
  const thread = await tx.chatThread.create({
    data: { kind: 'SUPPORT', status: 'ACTIVE', userId, supportTopic: initialTopic }
  });
  return { thread, created: true };
};

export type ChatImageAttachment = {
  type: 'IMAGE';
  url: string;
  fileName: string;
  mime: string;
  size: number;
};

export const writeSupportMessage = async (input: {
  userId: string;
  topic: string;
  text: string;
  attachments: ChatImageAttachment[];
}) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const { thread, created } = await getOrCreateActiveSupportThread(tx, input.userId, input.topic);
        const userMessage = await tx.chatMessage.create({
          data: {
            threadId: thread.id,
            authorRole: 'USER',
            authorId: input.userId,
            text: input.text,
            attachments: { create: input.attachments }
          },
          include: { attachments: true }
        });
        const acknowledgementMessage = created
          ? await tx.chatMessage.create({
              data: {
                threadId: thread.id,
                authorRole: 'ADMIN',
                authorId: 'SYSTEM_SUPPORT',
                text: ACKNOWLEDGEMENT
              },
              include: { attachments: true }
            })
          : null;
        const updatedThread = await tx.chatThread.update({
          where: { id: thread.id },
          data: { lastMessageAt: acknowledgementMessage?.createdAt ?? userMessage.createdAt }
        });
        return { thread: updatedThread, userMessage, acknowledgementMessage, created };
      });
    } catch (error) {
      if (attempt === 0 && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
      throw error;
    }
  }
  throw new Error('SUPPORT_THREAD_CREATE_RETRY_EXHAUSTED');
};
