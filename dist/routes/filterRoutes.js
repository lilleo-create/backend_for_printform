"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterRoutes = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const router = (0, express_1.Router)();
exports.filterRoutes = router;
const prisma = new client_1.PrismaClient();
// GET /filters/reference-categories
router.get('/reference-categories', async (_req, res) => {
    const categories = await prisma.referenceCategory.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, slug: true, title: true },
    });
    res.json(categories);
});
// GET /filters/cities
router.get('/cities', async (_req, res) => {
    const cities = await prisma.city.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
    });
    res.json(cities);
});
