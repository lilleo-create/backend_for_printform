import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { forbidden, unauthorized } from '../utils/httpErrors';

export type AuthUser = Express.User;

export type AuthRequest = Request;

export type OtpAuthRequest = Request & {
  otp?: { userId: string };
};

const loadUserAccess = async (userId: string): Promise<{ role: Role; isAdmin: boolean; isSeller: boolean } | null> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      sellerProfile: {
        select: { id: true }
      }
    }
  });

  if (!user) {
    return null;
  }

  const isAdmin = user.role === 'ADMIN';
  const isSeller = isAdmin || Boolean(user.sellerProfile);

  return {
    role: user.role,
    isAdmin,
    isSeller
  };
};

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void | Response> => {
  const header = req.headers.authorization;
  const cookieToken =
    typeof req.cookies?.accessToken === 'string' ? req.cookies.accessToken : null;
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

    const access = await loadUserAccess(decoded.userId);
    if (!access) {
      return unauthorized(res);
    }

    req.user = { userId: decoded.userId, role: access.role, isAdmin: access.isAdmin, isSeller: access.isSeller };
    return next();
  } catch {
    return unauthorized(res);
  }
};

export const authenticateOtp = (
  req: OtpAuthRequest,
  res: Response,
  next: NextFunction
): Response | void => {
  const header = req.headers.authorization;

  if (!header) {
    return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } });
  }

  const token = header.replace('Bearer ', '');

  try {
    const decoded = jwt.verify(token, env.jwtSecret) as {
      userId: string;
      scope?: string;
    };

    if (decoded.scope !== 'otp') {
      return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } });
    }

    req.otp = { userId: decoded.userId };
    return next();
  } catch {
    return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } });
  }
};

export const requireAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Response | void => {
  if (!req.user || !req.user.isAdmin) {
    return forbidden(res, 'Admin only');
  }

  return next();
};

export const requireSeller = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void | Response> => {
  if (!req.user) {
    return unauthorized(res);
  }

  if (req.user.isSeller) {
    return next();
  }

  if (!req.user.isSeller) {
    return forbidden(res, 'Seller only');
  }

  return next();
};

export const authenticate = requireAuth;

export const authorize = (roles: Role[]) => {
  return (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Response | void => {
    if (!req.user || !roles.includes(req.user.role)) {
      return forbidden(res);
    }

    return next();
  };
};
