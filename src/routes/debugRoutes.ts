import { Router } from 'express';

export const debugRoutes = Router();

debugRoutes.post('/ndd/offers', (_req, res) => {
  return res.status(410).json({
    error: {
      code: 'DEBUG_ROUTE_DISABLED',
      message: 'Debug route отключен: поддерживается только CDEK.'
    }
  });
});
