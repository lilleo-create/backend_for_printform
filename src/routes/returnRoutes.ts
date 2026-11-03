import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'node:crypto';
import { requireAuth, AuthRequest } from '../middleware/authMiddleware';
import { prisma } from '../lib/prisma';
import { RETURN_ELIGIBLE_STATUSES } from '../utils/returnEligibility';
import { writeLimiter } from '../middleware/rateLimiters';
import { createReturnSchema } from './returns/schemas';
import { containedFile, privateReturnsDir } from '../services/privateFileStorage';

export const returnRoutes = Router();

const allowedImageTypes = ['image/jpeg', 'image/png', 'image/webp'];
const imageExtensions: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const validImage = (file: UploadedFile) => {
  const bytes = file.buffer ?? Buffer.alloc(0);
  if (file.mimetype === 'image/jpeg') return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (file.mimetype === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (file.mimetype === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 10
  },
  fileFilter: (_req, file, cb) => {
    if (allowedImageTypes.includes(file.mimetype)) {
      return cb(null, true);
    }
    return cb(new Error('RETURN_UPLOAD_FILE_TYPE_INVALID'));
  }
});

const reasonLabels: Record<'NOT_FIT' | 'DAMAGED' | 'WRONG_ITEM', string> = {
  NOT_FIT: 'Не подошло',
  DAMAGED: 'Брак или повреждение',
  WRONG_ITEM: 'Привезли не то'
};

returnRoutes.get('/my', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const returns = await prisma.returnRequest.findMany({
      where: { userId: req.user!.userId },
      include: {
        items: {
          include: {
            orderItem: {
              include: {
                product: true,
                order: true
              }
            }
          }
        },
        photos: true,
        chatThread: { select: { id: true, status: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ data: returns });
  } catch (error) {
    next(error);
  }
});

type UploadedFile = {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  destination?: string;
  filename?: string;
  path?: string;
  buffer?: Buffer;
};

returnRoutes.post('/uploads', requireAuth, writeLimiter, upload.array('files', 10), async (req: AuthRequest, res, next) => {
  const files = (req.files as UploadedFile[] | undefined) ?? [];
  if (files.some(file => !validImage(file))) return res.status(400).json({ error: { code: 'RETURN_UPLOAD_FILE_TYPE_INVALID' } });
  const directory = path.join(privateReturnsDir, req.user!.userId);
  const created: string[] = [];
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    for (const file of files) {
      const filename = `${randomUUID()}${imageExtensions[file.mimetype]}`;
      const target = containedFile(directory, filename)!;
      await fs.promises.writeFile(target, file.buffer!, { flag: 'wx' });
      created.push(target);
    }
    return res.json({ data: { urls: created.map(file => `/private-files/returns/${req.user!.userId}/${path.basename(file)}`) } });
  } catch (error) {
    await Promise.all(created.map(file => fs.promises.unlink(file).catch(() => undefined)));
    next(error);
  }
});

returnRoutes.post('/', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = createReturnSchema.parse(req.body);
    for (const url of payload.photosUrls) {
      const prefix = `/private-files/returns/${req.user!.userId}/`;
      const file = url.startsWith(prefix) ? containedFile(path.join(privateReturnsDir, req.user!.userId), url.slice(prefix.length)) : null;
      if (!file || !fs.existsSync(file)) return res.status(400).json({ error: { code: 'RETURN_PHOTO_INVALID' } });
    }
    const orderItem = await prisma.orderItem.findFirst({
      where: {
        id: payload.orderItemId,
        order: {
          buyerId: req.user!.userId,
          status: {
            in: [...RETURN_ELIGIBLE_STATUSES]
          }
        }
      },
      include: {
        order: true,
        product: true
      }
    });
    if (!orderItem) {
      return res.status(404).json({ error: { code: 'ORDER_ITEM_NOT_FOUND' } });
    }
    const existingReturn = await prisma.returnItem.findFirst({
      where: {
        orderItemId: payload.orderItemId,
        returnRequest: {
          userId: req.user!.userId
        }
      }
    });
    if (existingReturn) {
      return res.status(409).json({ error: { code: 'RETURN_ALREADY_EXISTS' } });
    }

    const created = await prisma.$transaction(async (tx) => {
      const request = await tx.returnRequest.create({
        data: {
          userId: req.user!.userId,
          reason: payload.reason,
          comment: payload.comment
        }
      });
      await tx.returnItem.create({
        data: {
          returnRequestId: request.id,
          orderItemId: payload.orderItemId,
          quantity: orderItem.quantity
        }
      });
      const photos = payload.photosUrls;
      if (photos.length > 0) {
        await tx.returnPhoto.createMany({
          data: photos.map((url) => ({ returnRequestId: request.id, url }))
        });
      }
      const thread = await tx.chatThread.create({
        data: {
          kind: 'SUPPORT',
          status: 'ACTIVE',
          userId: req.user!.userId,
          returnRequestId: request.id
        }
      });
      const message = await tx.chatMessage.create({
        data: {
          threadId: thread.id,
          authorRole: 'USER',
          authorId: req.user!.userId,
          text: `Создана заявка на возврат: ${reasonLabels[payload.reason]}`
        }
      });
      await tx.chatThread.update({
        where: { id: thread.id },
        data: { lastMessageAt: message.createdAt }
      });

      return tx.returnRequest.findUnique({
        where: { id: request.id },
        include: {
          items: {
            include: {
              orderItem: {
                include: { product: true, order: true }
              }
            }
          },
          photos: true,
          chatThread: { select: { id: true, status: true } }
        }
      });
    });

    console.info('[RETURN][CREATE]', {
      orderId: orderItem.orderId,
      amount: orderItem.priceAtPurchase * orderItem.quantity,
      status: created?.status ?? 'CREATED'
    });

    res.status(201).json({ data: created });
  } catch (error) {
    next(error);
  }
});
