"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.returnRoutes = void 0;
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const authMiddleware_1 = require("../middleware/authMiddleware");
const prisma_1 = require("../lib/prisma");
const rateLimiters_1 = require("../middleware/rateLimiters");
const schemas_1 = require("./returns/schemas");
exports.returnRoutes = (0, express_1.Router)();
const uploadDir = path_1.default.join(process.cwd(), 'uploads', 'returns');
if (!fs_1.default.existsSync(uploadDir)) {
    fs_1.default.mkdirSync(uploadDir, { recursive: true });
}
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, uploadDir);
    },
    filename: (_req, file, cb) => {
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
        cb(null, `${unique}-${file.originalname}`);
    }
});
const allowedImageTypes = ['image/jpeg', 'image/png', 'image/webp'];
const upload = (0, multer_1.default)({
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
const reasonLabels = {
    NOT_FIT: 'Не подошло',
    DAMAGED: 'Брак или повреждение',
    WRONG_ITEM: 'Привезли не то'
};
exports.returnRoutes.get('/my', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        const returns = await prisma_1.prisma.returnRequest.findMany({
            where: { userId: req.user.userId },
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
    }
    catch (error) {
        next(error);
    }
});
exports.returnRoutes.post('/uploads', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, upload.array('files', 10), async (req, res) => {
    const files = req.files ?? [];
    const urls = files
        .filter((file) => file.filename)
        .map((file) => `/uploads/returns/${file.filename}`);
    return res.json({ data: { urls } });
});
exports.returnRoutes.post('/', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = schemas_1.createReturnSchema.parse(req.body);
        const orderItem = await prisma_1.prisma.orderItem.findFirst({
            where: {
                id: payload.orderItemId,
                order: {
                    buyerId: req.user.userId,
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
        const existingReturn = await prisma_1.prisma.returnItem.findFirst({
            where: {
                orderItemId: payload.orderItemId,
                returnRequest: {
                    userId: req.user.userId
                }
            }
        });
        if (existingReturn) {
            return res.status(409).json({ error: { code: 'RETURN_ALREADY_EXISTS' } });
        }
        const created = await prisma_1.prisma.$transaction(async (tx) => {
            const request = await tx.returnRequest.create({
                data: {
                    userId: req.user.userId,
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
                    userId: req.user.userId,
                    returnRequestId: request.id
                }
            });
            const message = await tx.chatMessage.create({
                data: {
                    threadId: thread.id,
                    authorRole: 'USER',
                    authorId: req.user.userId,
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
    }
    catch (error) {
        next(error);
    }
});
