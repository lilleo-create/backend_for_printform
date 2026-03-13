"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicReadLimiter = exports.writeLimiter = exports.otpVerifyLimiter = exports.otpRequestLimiter = exports.authLimiter = exports.globalLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const env_1 = require("../config/env");
const isPublicProductRead = (req) => req.method === 'GET' && req.path.startsWith('/products');
const createLimiter = (options) => (0, express_rate_limit_1.default)({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED' } },
    skip: (req) => req.method === 'OPTIONS' ||
        req.path === '/health' ||
        (options.skip ? options.skip(req) : false)
});
const isDev = process.env.NODE_ENV !== 'production';
const globalMax = env_1.env.isProduction ? 200 : 1000;
exports.globalLimiter = createLimiter({
    windowMs: 5 * 60 * 1000,
    max: globalMax,
    skip: isPublicProductRead
});
exports.authLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
exports.otpRequestLimiter = createLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
});
exports.otpVerifyLimiter = createLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
});
exports.writeLimiter = createLimiter({ windowMs: 5 * 60 * 1000, max: 60 });
exports.publicReadLimiter = createLimiter({ windowMs: 60 * 1000, max: 120 });
