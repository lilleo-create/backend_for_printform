"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.debugRoutes = void 0;
const express_1 = require("express");
exports.debugRoutes = (0, express_1.Router)();
exports.debugRoutes.post('/ndd/offers', (_req, res) => {
    return res.status(410).json({
        error: {
            code: 'DEBUG_ROUTE_DISABLED',
            message: 'Debug route отключен: поддерживается только CDEK.'
        }
    });
});
