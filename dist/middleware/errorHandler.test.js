"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const errorHandler_1 = require("./errorHandler");
const makeRes = () => {
    let statusCode = 0;
    let payload = null;
    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(body) {
            payload = body;
            return this;
        }
    };
    return { res, get: () => ({ statusCode, payload }) };
};
(0, node_test_1.default)('ORDER_NOT_PAID maps to 409', () => {
    const ctx = makeRes();
    (0, errorHandler_1.errorHandler)(new Error('ORDER_NOT_PAID'), {}, ctx.res, (() => { }));
    strict_1.default.equal(ctx.get().statusCode, 409);
    strict_1.default.deepEqual(ctx.get().payload, { error: { code: 'ORDER_NOT_PAID' } });
});
(0, node_test_1.default)('extended NDD error code maps from error fields', () => {
    const ctx = makeRes();
    const error = Object.assign(new Error('NDD failed'), {
        code: 'NDD_REQUEST_FAILED',
        status: 502,
        details: { reason: 'disabled' }
    });
    (0, errorHandler_1.errorHandler)(error, {}, ctx.res, (() => { }));
    strict_1.default.equal(ctx.get().statusCode, 502);
    strict_1.default.deepEqual(ctx.get().payload, {
        error: { code: 'NDD_REQUEST_FAILED', details: { reason: 'disabled' } }
    });
});
