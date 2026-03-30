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
const YOOKASSA_REFUNDS_API_URL = 'https://api.yookassa.ru/v3/refunds';
const YOOKASSA_DEALS_API_URL = 'https://api.yookassa.ru/v3/deals';
const YOOKASSA_PAYOUTS_API_URL = 'https://api.yookassa.ru/v3/payouts';
const authHeader = () => {
    const authToken = Buffer.from(`${env_1.env.yookassaShopId}:${env_1.env.yookassaSecretKey}`).toString('base64');
    return `Basic ${authToken}`;
};
const requestHeaders = (idempotenceKey) => ({
    Authorization: authHeader(),
    'Content-Type': 'application/json',
    'Idempotence-Key': idempotenceKey
});
exports.yookassaService = {
    async createDeal(input) {
        if (!env_1.env.yookassaShopId || !env_1.env.yookassaSecretKey) {
            throw new Error('YOOKASSA_CONFIG_MISSING');
        }
        const idempotenceKey = node_crypto_1.default.randomUUID();
        const body = {
            type: 'safe_deal',
            fee_moment: 'deal_closed',
            ...(typeof input.platformFeeAmountKopecks === 'number'
                ? {
                    commission: {
                        value: money_1.money.toRublesString(input.platformFeeAmountKopecks),
                        currency: input.currency
                    }
                }
                : {}),
            metadata: {
                orderId: input.orderId
            }
        };
        const response = await axios_1.default.post(YOOKASSA_DEALS_API_URL, body, {
            headers: requestHeaders(idempotenceKey),
            timeout: 15000
        });
        console.info('[YOOKASSA][DEAL_CREATE]', {
            orderId: input.orderId,
            dealId: response.data.id,
            status: response.data.status,
            platformFeeAmountKopecks: input.platformFeeAmountKopecks ?? null,
            idempotenceKey
        });
        return response.data;
    },
    async createPayment(input) {
        if (!env_1.env.yookassaShopId || !env_1.env.yookassaSecretKey || !env_1.env.yookassaReturnUrl) {
            throw new Error('YOOKASSA_CONFIG_MISSING');
        }
        const idempotenceKey = node_crypto_1.default.randomUUID();
        const returnUrl = new URL(env_1.env.yookassaReturnUrl);
        returnUrl.searchParams.set('orderId', input.orderId);
        const body = {
            amount: {
                value: money_1.money.toRublesString(input.amount),
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
                headers: requestHeaders(idempotenceKey),
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
    async createPaymentInDeal(input) {
        const idempotenceKey = node_crypto_1.default.randomUUID();
        const body = {
            amount: {
                value: money_1.money.toRublesString(input.amountKopecks),
                currency: input.currency
            },
            confirmation: {
                type: 'redirect',
                return_url: input.returnUrl
            },
            capture: true,
            description: input.description,
            deal: {
                id: input.dealId
            },
            metadata: {
                orderId: input.orderId,
                dealId: input.dealId
            }
        };
        const response = await axios_1.default.post(YOOKASSA_API_URL, body, {
            headers: requestHeaders(idempotenceKey),
            timeout: 15000
        });
        const confirmationUrl = response.data.confirmation?.confirmation_url;
        if (!confirmationUrl)
            throw new Error('YOOKASSA_CONFIRMATION_URL_MISSING');
        console.info('[YOOKASSA][PAYMENT_IN_DEAL]', {
            orderId: input.orderId,
            dealId: input.dealId,
            paymentId: response.data.id,
            status: response.data.status,
            amountKopecks: input.amountKopecks,
            idempotenceKey
        });
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
    async createPayoutInDeal(input) {
        if (!input.payoutDestinationData) {
            throw new Error('YOOKASSA_PAYOUT_DESTINATION_NOT_CONFIGURED');
        }
        const idempotenceKey = node_crypto_1.default.randomUUID();
        const body = {
            amount: {
                value: money_1.money.toRublesString(input.sellerAmountKopecks),
                currency: input.currency
            },
            payout_destination_data: input.payoutDestinationData,
            deal: {
                id: input.dealId
            },
            metadata: {
                orderId: input.orderId,
                dealId: input.dealId
            }
        };
        const response = await axios_1.default.post(YOOKASSA_PAYOUTS_API_URL, body, {
            headers: requestHeaders(idempotenceKey),
            timeout: 15000
        });
        console.info('[YOOKASSA][PAYOUT_CREATE]', {
            orderId: input.orderId,
            dealId: input.dealId,
            payoutId: response.data.id,
            status: response.data.status,
            amountKopecks: input.sellerAmountKopecks,
            idempotenceKey
        });
        return response.data;
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
    },
    async createRefund(input) {
        if (!env_1.env.yookassaShopId || !env_1.env.yookassaSecretKey) {
            throw new Error('YOOKASSA_CONFIG_MISSING');
        }
        const idempotenceKey = node_crypto_1.default.randomUUID();
        const body = {
            amount: {
                value: money_1.money.toRublesString(input.amount),
                currency: input.currency
            },
            payment_id: input.paymentId,
            metadata: {
                orderId: input.orderId
            }
        };
        try {
            const response = await axios_1.default.post(YOOKASSA_REFUNDS_API_URL, body, {
                headers: requestHeaders(idempotenceKey),
                timeout: 15000
            });
            console.info('[YOOKASSA][REFUND_CREATE]', {
                orderId: input.orderId,
                paymentId: input.paymentId,
                refundId: response.data.id,
                amount: input.amount,
                status: response.data.status,
                idempotenceKey
            });
            return {
                id: response.data.id,
                status: response.data.status,
                payload: response.data
            };
        }
        catch (error) {
            console.error('[YOOKASSA][REFUND_CREATE][ERROR]', {
                orderId: input.orderId,
                paymentId: input.paymentId,
                amount: input.amount,
                idempotenceKey,
                error,
                stack: error instanceof Error ? error.stack : undefined
            });
            const mappedError = new Error('YOOKASSA_REFUND_CREATE_FAILED');
            mappedError.cause = error;
            throw mappedError;
        }
    },
    async createRefundInDeal(input) {
        const idempotenceKey = node_crypto_1.default.randomUUID();
        const body = {
            amount: {
                value: money_1.money.toRublesString(input.amountKopecks),
                currency: input.currency
            },
            payment_id: input.paymentId,
            deal: {
                id: input.dealId
            },
            description: input.reason,
            metadata: {
                orderId: input.orderId,
                dealId: input.dealId
            }
        };
        const response = await axios_1.default.post(YOOKASSA_REFUNDS_API_URL, body, {
            headers: requestHeaders(idempotenceKey),
            timeout: 15000
        });
        console.info('[YOOKASSA][REFUND_IN_DEAL]', {
            orderId: input.orderId,
            dealId: input.dealId,
            paymentId: input.paymentId,
            refundId: response.data.id,
            amountKopecks: input.amountKopecks,
            status: response.data.status,
            idempotenceKey
        });
        return {
            id: response.data.id,
            status: response.data.status,
            payload: response.data
        };
    }
};
