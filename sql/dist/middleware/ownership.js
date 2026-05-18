"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkOwnership = void 0;
const prisma_1 = require("../lib/prisma");
const checkOwnership = (resource, userIdSelector = (req) => req.user?.userId) => {
    return async (req, res, next) => {
        try {
            const userId = userIdSelector(req);
            if (!userId) {
                return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'UNAUTHORIZED' } });
            }
            if (req.user?.role === 'ADMIN') {
                return next();
            }
            if (resource === 'review') {
                const reviewId = req.params.reviewId ?? req.params.id;
                const review = await prisma_1.prisma.review.findUnique({
                    where: { id: reviewId },
                    select: { id: true, userId: true }
                });
                if (!review) {
                    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'NOT_FOUND' } });
                }
                if (review.userId !== userId) {
                    console.warn('[security] review ownership violation', {
                        actorUserId: userId,
                        reviewId,
                        ownerUserId: review.userId,
                        method: req.method,
                        path: req.originalUrl,
                        ip: req.ip
                    });
                    return res.status(403).json({
                        error: {
                            code: 'FORBIDDEN',
                            message: 'Недостаточно прав для изменения этого объекта.'
                        }
                    });
                }
            }
            if (resource === 'reply') {
                const replyId = req.params.replyId ?? req.params.id;
                const reply = await prisma_1.prisma.reviewReply.findUnique({
                    where: { id: replyId },
                    select: { id: true, authorId: true }
                });
                if (!reply) {
                    return res.status(404).json({ error: { code: 'REVIEW_REPLY_NOT_FOUND', message: 'REVIEW_REPLY_NOT_FOUND' } });
                }
                if (reply.authorId !== userId) {
                    console.warn('[security] reply ownership violation', {
                        actorUserId: userId,
                        replyId,
                        ownerUserId: reply.authorId,
                        method: req.method,
                        path: req.originalUrl,
                        ip: req.ip
                    });
                    return res.status(403).json({
                        error: {
                            code: 'FORBIDDEN',
                            message: 'Недостаточно прав для изменения этого объекта.'
                        }
                    });
                }
            }
            return next();
        }
        catch (error) {
            return next(error);
        }
    };
};
exports.checkOwnership = checkOwnership;
