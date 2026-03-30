"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.yookassaService = void 0;
const axios_1 = __importDefault(require("axios"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const env_1 = require("../config/env");
const money_1 = require("../utils/money");
const YOOKASSA_API_URL = 'https://api.yookassa.ru/v3/payments';
const authHeader = () => {
    const authToken = Buffer.from(`${env_1.env.yookassaShopId}:${env_1.env.yookassaSecretKey}`).toString('base64');
    return `Basic ${authToken}`;
};
exports.yookassaService = {
    // TODO: migrate to YooKassa Safe Deal (escrow)
    // TODO: add seller payouts via YooKassa
    // TODO: integrate OAuth seller accounts
    async createPayment(input) {
        if (!env_1.env.yookassaShopId || !env_1.env.yookassaSecretKey || !env_1.env.yookassaReturnUrl) {
            throw new Error('YOOKASSA_CONFIG_MISSING');
        }
        const idempotenceKey = node_crypto_1.default.randomUUID();
        const returnUrl = new URL(env_1.env.yookassaReturnUrl);
        returnUrl.searchParams.set('orderId', input.orderId);
        const body = {
            amount: {
                value: (0, money_1.kopecksToRubles)(input.amount),
                currency: input.currency
            },
            confirmation: {
                type: 'redirect',
                return_url: returnUrl.toString()
            },
            capture: true,
            description: input.description,
            metadata: {
                orderId: input.orderId
            }
        };
        let response;
        try {
            response = await axios_1.default.post(YOOKASSA_API_URL, body, {
                headers: {
                    Authorization: authHeader(),
                    'Content-Type': 'application/json',
                    'Idempotence-Key': idempotenceKey
                },
                timeout: 15000
            });
        }
        catch (error) {
            console.error('[YOOKASSA][createPayment][ERROR]', {
                orderId: input.orderId,
                idempotenceKey,
                error,
                stack: error instanceof Error ? error.stack : undefined
            });
            const mappedError = new Error('YOOKASSA_CREATE_FAILED');
            mappedError.cause = error;
            throw mappedError;
        }
        console.info('[YOOKASSA][createPayment]', {
            orderId: input.orderId,
            paymentId: response.data.id,
            status: response.data.status,
            idempotenceKey
        });
        const confirmationUrl = response.data.confirmation?.confirmation_url;
        if (!confirmationUrl) {
            throw new Error('YOOKASSA_CONFIRMATION_URL_MISSING');
        }
        return {
            id: response.data.id,
            confirmationUrl,
            status: response.data.status,
            payload: {
                ...response.data,
                paymentUrl: confirmationUrl
            }
        };
    },
    async getPayment(paymentId) {
        const response = await axios_1.default.get(`${YOOKASSA_API_URL}/${paymentId}`, {
            headers: {
                Authorization: authHeader(),
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });
        return response.data;
    }
};
