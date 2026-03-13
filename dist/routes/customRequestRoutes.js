"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.customRequestRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const customRequestUseCases_1 = require("../usecases/customRequestUseCases");
const rateLimiters_1 = require("../middleware/rateLimiters");
exports.customRequestRoutes = (0, express_1.Router)();
const customRequestSchema = zod_1.z.object({
    name: zod_1.z.string().min(2),
    contact: zod_1.z.string().min(3),
    comment: zod_1.z.string().min(5)
});
exports.customRequestRoutes.post('/', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = customRequestSchema.parse(req.body);
        const request = await customRequestUseCases_1.customRequestUseCases.create(payload);
        res.status(201).json({ data: request });
    }
    catch (error) {
        next(error);
    }
});
