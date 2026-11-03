import { Router } from 'express';

export const createReadinessRouter = (probe: () => Promise<unknown>) => {
  const router = Router();
  router.get('/', async (_req, res) => {
    try {
      await probe();
      res.status(200).json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  return router;
};
