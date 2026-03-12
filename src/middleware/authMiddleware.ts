import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { forbidden, unauthorized } from '../utils/httpErrors';

export interface AuthRequest extends Request {
  user?: { userId: string; role: Role };
}

const loadUserRole = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true }
  });
  return user?.role ?? null;
};

export const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const cookieToken = typeof req.cookies?.accessToken === 'string' ? req.cookies.accessToken : null;
  const token = header?.replace('Bearer ', '') || cookieToken;

  if (!token) {
    return unauthorized(res);
  }

  try {
    const decoded = jwt.verify(token, env.jwtSecret) as {
      userId: string;
      role: Role;
      scope?: string;
    };
    if (decoded.scope && decoded.scope !== 'access') {
      return unauthorized(res);
    }
    const role = await loadUserRole(decoded.userId);
    if (!role) {
      return unauthorized(res);
    }
    req.user = { userId: decoded.userId, role };
    return next();
  } catch {
    return unauthorized(res);
  }
};

export interface OtpAuthRequest extends Request {
  otp?: { userId: string };
}

export const authenticateOtp = (req: OtpAuthRequest, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header) {
    return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } });
  }
  const token = header.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, env.jwtSecret) as { userId: string; scope?: string };
    if (decoded.scope !== 'otp') {
      return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } });
    }
    req.otp = { userId: decoded.userId };
    return next();
  } catch {
    return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } });
  }
};

export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'ADMIN') {
    return forbidden(res, 'Admin only');
  }
  return next();
};

export const requireSeller = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return unauthorized(res);
  }
  if (req.user.role === 'ADMIN') {
    return next();
  }
  const profile = await prisma.sellerProfile.findUnique({
    where: { userId: req.user.userId },
    select: { id: true }
  });
  if (!profile) {
    return forbidden(res, 'Seller only');
  }
  return next();
};

export const authenticate = requireAuth;

export const authorize = (roles: Role[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return forbidden(res);
    }
    return next();
  };
};
