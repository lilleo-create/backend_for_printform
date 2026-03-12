import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../config/env';

const isPublicProductRead = (req: Request) => req.method === 'GET' && req.path.startsWith('/products');

const createLimiter = (options: { windowMs: number; max: number; skip?: (req: Request) => boolean }) =>
  rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED' } },
    skip: (req) =>
      req.method === 'OPTIONS' ||
      req.path === '/health' ||
      (options.skip ? options.skip(req) : false)
  });

const isDev = process.env.NODE_ENV !== 'production';
const globalMax = env.isProduction ? 200 : 1000;
export const globalLimiter = createLimiter({
  windowMs: 5 * 60 * 1000,
  max: globalMax,
  skip: isPublicProductRead
});
export const authLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
export const otpRequestLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
});
export const otpVerifyLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
});
export const writeLimiter = createLimiter({ windowMs: 5 * 60 * 1000, max: 60 });
export const publicReadLimiter = createLimiter({ windowMs: 60 * 1000, max: 120 });
