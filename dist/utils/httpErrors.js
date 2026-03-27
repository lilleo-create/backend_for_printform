"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notFound = exports.forbidden = exports.unauthorized = void 0;
const respondWithError = (res, code, message) => {
    return res.status(code === 'UNAUTHORIZED' ? 401 : code === 'FORBIDDEN' ? 403 : 404).json({
        error: {
            code,
            message: message ?? code
        }
    });
};
const unauthorized = (res, message) => respondWithError(res, 'UNAUTHORIZED', message);
exports.unauthorized = unauthorized;
const forbidden = (res, message) => respondWithError(res, 'FORBIDDEN', message);
exports.forbidden = forbidden;
const notFound = (res, message) => respondWithError(res, 'NOT_FOUND', message);
exports.notFound = notFound;
