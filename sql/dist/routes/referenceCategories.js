"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const router = (0, express_1.Router)();
const prisma = new client_1.PrismaClient();
/**
 * Public: список категорий для онбординга продавца
 */
router.get('/reference-categories', async (req, res) => {
    const categories = await prisma.referenceCategory.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { slug: true, title: true },
    });
    res.json({ categories });
});
exports.default = router;
