"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createReturnSchema = exports.photoUrlSchema = void 0;
const zod_1 = require("zod");
exports.photoUrlSchema = zod_1.z.string().superRefine((value, ctx) => {
    if (value.startsWith('/uploads/returns/')) {
        return;
    }
    try {
        new URL(value);
    }
    catch {
        ctx.addIssue({ code: zod_1.z.ZodIssueCode.custom, message: 'Invalid url' });
    }
});
exports.createReturnSchema = zod_1.z.object({
    orderItemId: zod_1.z.string().min(1),
    reason: zod_1.z.enum(['NOT_FIT', 'DAMAGED', 'WRONG_ITEM']),
    comment: zod_1.z.string().trim().min(5).max(2000),
    photosUrls: zod_1.z.array(exports.photoUrlSchema).max(10).optional().default([])
});
