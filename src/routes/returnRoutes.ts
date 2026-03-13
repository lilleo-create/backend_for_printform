import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireAuth, AuthRequest } from '../middleware/authMiddleware';
import { prisma } from '../lib/prisma';
import { writeLimiter } from '../middleware/rateLimiters';
import { createReturnSchema } from './returns/schemas';

export const returnRoutes = Router();

const uploadDir = path.join(process.cwd(), 'uploads', 'returns');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `${unique}-${file.originalname}`);
  }
});

const allowedImageTypes = ['image/jpeg', 'image/png', 'image/webp'];
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024
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

returnRoutes.post('/uploads', requireAuth, writeLimiter, upload.array('files', 10), async (req, res) => {
  const files = (req.files as UploadedFile[] | undefined) ?? [];
  const urls = files
    .filter((file) => file.filename)
    .map((file) => `/uploads/returns/${file.filename}`);

  return res.json({ data: { urls } });
});

returnRoutes.post('/', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = createReturnSchema.parse(req.body);
    const orderItem = await prisma.orderItem.findFirst({
      where: {
        id: payload.orderItemId,
        order: {
          buyerId: req.user!.userId,
          status: {
            in: ['READY_FOR_SHIPMENT', 'HANDED_TO_DELIVERY', 'IN_TRANSIT', 'DELIVERED']
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

    res.status(201).json({ data: created });
  } catch (error) {
    next(error);
  }
});
