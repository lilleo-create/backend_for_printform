import axios from 'axios';
import crypto from 'node:crypto';
import { env } from '../config/env';
import { money } from '../utils/money';

type YooKassaAmount = {
  value: string;
  currency: string;
};

type YooKassaPaymentResponse = {
  id: string;
  status: string;
  amount?: YooKassaAmount;
  confirmation?: {
    type?: string;
    confirmation_url?: string;
  };
  paid?: boolean;
  metadata?: Record<string, string>;
  [key: string]: unknown;
};

type YooKassaDealResponse = {
  id: string;
  status: string;
  type?: string;
  fee_moment?: string;
  metadata?: Record<string, string>;
  [key: string]: unknown;
};

type YooKassaPayoutResponse = {
  id: string;
  status: string;
  amount?: YooKassaAmount;
  deal?: { id?: string };
  [key: string]: unknown;
};

const YOOKASSA_API_URL = 'https://api.yookassa.ru/v3/payments';
const YOOKASSA_REFUNDS_API_URL = 'https://api.yookassa.ru/v3/refunds';
const YOOKASSA_DEALS_API_URL = 'https://api.yookassa.ru/v3/deals';
const YOOKASSA_PAYOUTS_API_URL = 'https://api.yookassa.ru/v3/payouts';

type YooKassaRefundResponse = {
  id: string;
  status: string;
  amount?: YooKassaAmount;
  payment_id?: string;
  [key: string]: unknown;
};

const authHeader = () => {
  const authToken = Buffer.from(`${env.yookassaShopId}:${env.yookassaSecretKey}`).toString('base64');
  return `Basic ${authToken}`;
};

const requestHeaders = (idempotenceKey: string) => ({
  Authorization: authHeader(),
  'Content-Type': 'application/json',
  'Idempotence-Key': idempotenceKey
});

export const yookassaService = {
  async createDeal(input: {
    orderId: string;
    platformFeeAmountKopecks?: number;
    currency: string;
  }): Promise<YooKassaDealResponse> {
    if (!env.yookassaShopId || !env.yookassaSecretKey) {
      throw new Error('YOOKASSA_CONFIG_MISSING');
    }

    const idempotenceKey = crypto.randomUUID();
    const body = {
      type: 'safe_deal',
      fee_moment: 'deal_closed',
      ...(typeof input.platformFeeAmountKopecks === 'number'
        ? {
            commission: {
              value: money.toRublesString(input.platformFeeAmountKopecks),
              currency: input.currency
            }
          }
        : {}),
      metadata: {
        orderId: input.orderId
      }
    };

    const response = await axios.post<YooKassaDealResponse>(YOOKASSA_DEALS_API_URL, body, {
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

  async createPayment(input: {
    amount: number;
    currency: string;
    orderId: string;
    description: string;
  }): Promise<{
    id: string;
    confirmationUrl: string;
    status: string;
    payload: YooKassaPaymentResponse;
  }> {
    if (!env.yookassaShopId || !env.yookassaSecretKey || !env.yookassaReturnUrl) {
      throw new Error('YOOKASSA_CONFIG_MISSING');
    }

    const idempotenceKey = crypto.randomUUID();

    const returnUrl = new URL(env.yookassaReturnUrl);
    returnUrl.searchParams.set('orderId', input.orderId);

    const body = {
      amount: {
        value: money.toRublesString(input.amount),
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
      response = await axios.post<YooKassaPaymentResponse>(YOOKASSA_API_URL, body, {
        headers: requestHeaders(idempotenceKey),
        timeout: 15000
      });
    } catch (error) {
      console.error('[YOOKASSA][createPayment][ERROR]', {
        orderId: input.orderId,
        idempotenceKey,
        error,
        stack: error instanceof Error ? error.stack : undefined
      });
      const mappedError = new Error('YOOKASSA_CREATE_FAILED') as Error & { cause?: unknown };
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

  async createPaymentInDeal(input: {
    orderId: string;
    dealId: string;
    amountKopecks: number;
    currency: string;
    returnUrl: string;
    description: string;
  }): Promise<{
    id: string;
    confirmationUrl: string;
    status: string;
    payload: YooKassaPaymentResponse;
  }> {
    const idempotenceKey = crypto.randomUUID();
    const body = {
      amount: {
        value: money.toRublesString(input.amountKopecks),
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

    const response = await axios.post<YooKassaPaymentResponse>(YOOKASSA_API_URL, body, {
      headers: requestHeaders(idempotenceKey),
      timeout: 15000
    });

    const confirmationUrl = response.data.confirmation?.confirmation_url;
    if (!confirmationUrl) throw new Error('YOOKASSA_CONFIRMATION_URL_MISSING');

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

  async createPayoutInDeal(input: {
    orderId: string;
    dealId: string;
    sellerAmountKopecks: number;
    currency: string;
    payoutToken?: string;
    payoutDestinationData?: Record<string, unknown>;
    idempotenceKey?: string;
  }) {
    if (!input.payoutDestinationData && !input.payoutToken) {
      throw new Error('YOOKASSA_PAYOUT_DESTINATION_OR_TOKEN_NOT_CONFIGURED');
    }

    const idempotenceKey = input.idempotenceKey ?? crypto.randomUUID();
    const body = {
      amount: {
        value: money.toRublesString(input.sellerAmountKopecks),
        currency: input.currency
      },
      ...(input.payoutDestinationData ? { payout_destination_data: input.payoutDestinationData } : {}),
      ...(input.payoutToken ? { payout_token: input.payoutToken } : {}),
      deal: {
        id: input.dealId
      },
      metadata: {
        orderId: input.orderId,
        dealId: input.dealId
      }
    };

    const response = await axios.post<YooKassaPayoutResponse>(YOOKASSA_PAYOUTS_API_URL, body, {
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

  async getPayout(payoutId: string) {
    const response = await axios.get<YooKassaPayoutResponse>(`${YOOKASSA_PAYOUTS_API_URL}/${payoutId}`, {
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    return response.data;
  },

  async getPayment(paymentId: string) {
    const response = await axios.get<YooKassaPaymentResponse>(`${YOOKASSA_API_URL}/${paymentId}`, {
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    return response.data;
  },

  async createRefund(input: {
    paymentId: string;
    amount: number;
    currency: string;
    orderId: string;
    reason?: string;
  }): Promise<{
    id: string;
    status: string;
    payload: YooKassaRefundResponse;
  }> {
    if (!env.yookassaShopId || !env.yookassaSecretKey) {
      throw new Error('YOOKASSA_CONFIG_MISSING');
    }

    const idempotenceKey = crypto.randomUUID();
    const body = {
      amount: {
        value: money.toRublesString(input.amount),
        currency: input.currency
      },
      payment_id: input.paymentId,
      metadata: {
        orderId: input.orderId
      }
    };

    try {
      const response = await axios.post<YooKassaRefundResponse>(YOOKASSA_REFUNDS_API_URL, body, {
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
    } catch (error) {
      console.error('[YOOKASSA][REFUND_CREATE][ERROR]', {
        orderId: input.orderId,
        paymentId: input.paymentId,
        amount: input.amount,
        idempotenceKey,
        error,
        stack: error instanceof Error ? error.stack : undefined
      });
      const mappedError = new Error('YOOKASSA_REFUND_CREATE_FAILED') as Error & { cause?: unknown };
      mappedError.cause = error;
      throw mappedError;
    }
  },

  async createRefundInDeal(input: {
    orderId: string;
    dealId: string;
    paymentId: string;
    amountKopecks: number;
    currency: string;
    reason?: string;
  }): Promise<{
    id: string;
    status: string;
    payload: YooKassaRefundResponse;
  }> {
    const idempotenceKey = crypto.randomUUID();
    const body = {
      amount: {
        value: money.toRublesString(input.amountKopecks),
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

    const response = await axios.post<YooKassaRefundResponse>(YOOKASSA_REFUNDS_API_URL, body, {
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
