import type { CdekOrderSnapshot } from './cdekService';
import { safeCdekError } from './safeCdekError';

const delaysMs = [0, 500, 1500, 3000] as const;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type CdekReadbackResult = {
  status: 'VERIFIED' | 'PENDING' | 'AUTH_FAILED';
  checkedAt: string;
  attempts: number;
  reasonCode?: 'CDEK_ORDER_READBACK_PENDING' | 'CDEK_ORDER_READBACK_FAILED' | 'CDEK_READBACK_AUTH_FAILED';
  snapshot?: CdekOrderSnapshot;
};

const isRetryable = (error: ReturnType<typeof safeCdekError>) =>
  error.httpStatus === 404 || (error.httpStatus !== null && error.httpStatus >= 500) ||
  error.providerErrors.some((entry) => entry.code === 'v2_entity_not_found') ||
  (error.httpStatus === null && (!error.code ||
    ['ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH',
      'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_NETWORK'].includes(error.code)));

export const verifyCreatedCdekOrderReadback = async (params: {
  orderId: string;
  cdekOrderUuid: string;
  requestId: string;
  getOrder: (uuid: string) => Promise<CdekOrderSnapshot>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<CdekReadbackResult> => {
  const sleep = params.sleep ?? wait;
  for (let index = 0; index < delaysMs.length; index++) {
    if (delaysMs[index]) await sleep(delaysMs[index]);
    const attempt = index + 1;
    try {
      const snapshot = await params.getOrder(params.cdekOrderUuid);
      if (snapshot.cdekOrderId !== params.cdekOrderUuid) {
        console.error('[CDEK][readback]', { requestId: params.requestId, orderId: params.orderId,
          cdekOrderUuid: params.cdekOrderUuid, attempt, result: 'PENDING', reasonCode: 'CDEK_ORDER_READBACK_MISMATCH' });
        return { status: 'PENDING', checkedAt: new Date().toISOString(), attempts: attempt,
          reasonCode: 'CDEK_ORDER_READBACK_FAILED' };
      }
      console.info('[CDEK][readback]', { requestId: params.requestId, orderId: params.orderId,
        cdekOrderUuid: params.cdekOrderUuid, attempt, httpStatus: 200, result: 'VERIFIED' });
      return { status: 'VERIFIED', checkedAt: new Date().toISOString(), attempts: attempt, snapshot };
    } catch (error) {
      const safeError = safeCdekError(error, 'getOrderByUuid');
      const authFailure = safeError.httpStatus === 401 || safeError.httpStatus === 403;
      const retry = !authFailure && isRetryable(safeError) && attempt < delaysMs.length;
      const result = authFailure ? 'AUTH_FAILED' : 'PENDING';
      console[authFailure ? 'error' : 'warn']('[CDEK][readback]', {
        requestId: params.requestId, orderId: params.orderId, cdekOrderUuid: params.cdekOrderUuid,
        attempt, httpStatus: safeError.httpStatus, result,
        reasonCode: authFailure ? 'CDEK_READBACK_AUTH_FAILED' :
          retry ? 'CDEK_ORDER_READBACK_RETRY' : 'CDEK_ORDER_READBACK_PENDING',
        error: safeError
      });
      if (!retry) return { status: result, checkedAt: new Date().toISOString(), attempts: attempt,
        reasonCode: authFailure ? 'CDEK_READBACK_AUTH_FAILED' :
          isRetryable(safeError) ? 'CDEK_ORDER_READBACK_PENDING' : 'CDEK_ORDER_READBACK_FAILED' };
    }
  }
  return { status: 'PENDING', checkedAt: new Date().toISOString(), attempts: delaysMs.length,
    reasonCode: 'CDEK_ORDER_READBACK_PENDING' };
};
