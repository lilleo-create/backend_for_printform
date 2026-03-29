import axios from 'axios';
import crypto from 'node:crypto';
import { env } from '../config/env';

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
  [key: string]: unknown;
};

const YOOKASSA_API_URL = 'https://api.yookassa.ru/v3/payments';

const toRubles = (amount: number) => (amount / 100).toFixed(2);

const authHeader = () => {
  const authToken = Buffer.from(`${env.yookassaShopId}:${env.yookassaSecretKey}`).toString('base64');
  return `Basic ${authToken}`;
};

export const yookassaService = {
  // TODO: migrate to YooKassa Safe Deal (escrow)
  // TODO: add seller payouts via YooKassa
  // TODO: integrate OAuth seller accounts
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
    const idempotenceKey = crypto.randomUUID();
    const body = {
      amount: {
        value: toRubles(input.amount),
        currency: input.currency
      },
      confirmation: {
        type: 'redirect',
        return_url: env.yookassaReturnUrl
      },
      capture: true,
      description: input.description,
      metadata: {
        orderId: input.orderId
      }
    };

    const response = await axios.post<YooKassaPaymentResponse>(YOOKASSA_API_URL, body, {
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json',
        'Idempotence-Key': idempotenceKey
      },
      timeout: 15000
    });

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

  async getPayment(paymentId: string) {
    const response = await axios.get<YooKassaPaymentResponse>(`${YOOKASSA_API_URL}/${paymentId}`, {
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    return response.data;
  }
};
