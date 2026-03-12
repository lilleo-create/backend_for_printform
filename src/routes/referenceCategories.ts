import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

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

export default router;
