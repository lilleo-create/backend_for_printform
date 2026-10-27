import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { listReferenceCategoryCounts } from '../services/categoryCountsService';

const router = Router();
const prisma = new PrismaClient();

// GET /filters/reference-categories
router.get('/reference-categories', async (_req, res) => {
  const categories = await prisma.referenceCategory.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, slug: true, title: true },
  });

  res.json(categories);
});

router.get('/reference-categories/with-counts', async (_req, res, next) => {
  try {
    res.json(await listReferenceCategoryCounts());
  } catch (error) {
    next(error);
  }
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

export { router as filterRoutes };
