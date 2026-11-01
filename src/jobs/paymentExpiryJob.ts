import { expirePendingPayments } from '../utils/orderPayment';

const INTERVAL_MS = 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let running = false;

export const runPaymentExpiryJob = async () => {
  await expirePendingPayments();
};

export const startPaymentExpiryJob = () => {
  if (process.env.NODE_ENV === 'test' || timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void runPaymentExpiryJob()
      .catch(error => console.error('[PAYMENT_EXPIRY_JOB]', { message: error instanceof Error ? error.message : 'UNKNOWN' }))
      .finally(() => { running = false; });
  }, INTERVAL_MS);
  console.info('[PAYMENT_EXPIRY_JOB][START]', { intervalMs: INTERVAL_MS });
};
