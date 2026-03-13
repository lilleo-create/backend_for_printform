"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorize = exports.authenticate = exports.requireSeller = exports.requireAdmin = exports.authenticateOtp = exports.requireAuth = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
const prisma_1 = require("../lib/prisma");
const httpErrors_1 = require("../utils/httpErrors");
const loadUserRole = async (userId) => {
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true }
    });
    return user?.role ?? null;
};
const requireAuth = async (req, res, next) => {
    const header = req.headers.authorization;
    const cookieToken = typeof req.cookies?.accessToken === 'string' ? req.cookies.accessToken : null;
    const token = header?.replace('Bearer ', '') || cookieToken;
    if (!token) {
        return (0, httpErrors_1.unauthorized)(res);
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, env_1.env.jwtSecret);
        if (decoded.scope && decoded.scope !== 'access') {
            return (0, httpErrors_1.unauthorized)(res);
        }
        const role = await loadUserRole(decoded.userId);
        if (!role) {
            return (0, httpErrors_1.unauthorized)(res);
        }
        req.user = { userId: decoded.userId, role };
        return next();
    }
    catch {
        return (0, httpErrors_1.unauthorized)(res);
    }
};
exports.requireAuth = requireAuth;
const authenticateOtp = (req, res, next) => {
    const header = req.headers.authorization;
    if (!header) {
        return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } });
    }
    const token = header.replace('Bearer ', '');
    try {
        const decoded = jsonwebtoken_1.default.verify(token, env_1.env.jwtSecret);
        if (decoded.scope !== 'otp') {
            return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } });
        }
        req.otp = { userId: decoded.userId };
        return next();
    }
    catch {
        return res.status(401).json({ error: { code: 'OTP_TOKEN_REQUIRED' } });
    }
};
exports.authenticateOtp = authenticateOtp;
const requireAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'ADMIN') {
        return (0, httpErrors_1.forbidden)(res, 'Admin only');
    }
    return next();
};
exports.requireAdmin = requireAdmin;
const requireSeller = async (req, res, next) => {
    if (!req.user) {
        return (0, httpErrors_1.unauthorized)(res);
    }
    if (req.user.role === 'ADMIN') {
        return next();
    }
    const profile = await prisma_1.prisma.sellerProfile.findUnique({
        where: { userId: req.user.userId },
        select: { id: true }
    });
    if (!profile) {
        return (0, httpErrors_1.forbidden)(res, 'Seller only');
    }
    return next();
};
exports.requireSeller = requireSeller;
exports.authenticate = exports.requireAuth;
const authorize = (roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return (0, httpErrors_1.forbidden)(res);
        }
        return next();
    };
};
exports.authorize = authorize;
