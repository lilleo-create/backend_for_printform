import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { cdekService } from './cdekService';

const params = {
  fromCityCode: 44, toCityCode: 137,
  weightGrams: 250, lengthCm: 15, widthCm: 15, heightCm: 15,
  shipmentPoint: 'MSK424', deliveryPoint: 'SPB541'
};
const trace = { requestId: 'quote-123', orderId: 'order-17' };

test('packing quote records only correlated request and actual provider response fields', async () => {
  const originalToken = cdekService.getToken;
  const originalRequest = axios.request;
  const originalLog = console.info;
  const logs: Array<[string, Record<string, unknown>]> = [];
  let sent: any;
  try {
    (cdekService.getToken as any) = async () => 'sensitive-oauth-token';
    (axios.request as any) = async (config: unknown) => {
      sent = config;
      return { status: 200, data: {
        total_sum: 204.75, delivery_sum: 199.2,
        period_min: 2, period_max: 4, calendar_min: null, calendar_max: null
      } };
    };
    (console.info as any) = (label: string, fields: Record<string, unknown>) => { logs.push([label, fields]); };
    const quote = await cdekService.calculateDelivery(params, trace);
    assert.equal(quote.totalSum, 204.75);
    assert.equal(sent.data.tariff_code, 136);
    assert.deepEqual(sent.data.packages[0], { weight: 250, length: 15, width: 15, height: 15 });
    const requestLog = logs.find(([label]) => label === '[CDEK][packingQuote][request]')?.[1];
    const responseLog = logs.find(([label]) => label === '[CDEK][packingQuote][response]')?.[1];
    assert.deepEqual(requestLog, { ...trace, ...params, tariffCode: 136 });
    assert.equal(responseLog?.requestId, trace.requestId);
    assert.equal(responseLog?.orderId, trace.orderId);
    assert.equal(responseLog?.status, 200);
    assert.equal(responseLog?.total_sum, 204.75);
    assert.equal(responseLog?.delivery_sum, 199.2);
    assert.equal(responseLog?.period_min, 2);
    assert.equal(responseLog?.period_max, 4);
    assert.equal(responseLog?.deliveryAmountKopecks, 20475);
    assert.equal(typeof responseLog?.durationMs, 'number');
    assert.doesNotMatch(JSON.stringify(logs), /sensitive-oauth-token|Authorization|email|phone/);
  } finally {
    (cdekService.getToken as any) = originalToken;
    (axios.request as any) = originalRequest;
    (console.info as any) = originalLog;
  }
});

test('failed packing quote logs status and correlation without raw provider payload', async () => {
  const originalToken = cdekService.getToken;
  const originalRequest = axios.request;
  const originalLog = console.info;
  const logs: Array<[string, Record<string, unknown>]> = [];
  try {
    (cdekService.getToken as any) = async () => 'sensitive-oauth-token';
    (axios.request as any) = async () => {
      throw { response: { status: 400, data: { email: 'buyer@example.org' } } };
    };
    (console.info as any) = (label: string, fields: Record<string, unknown>) => { logs.push([label, fields]); };
    await assert.rejects(cdekService.calculateDelivery(params, trace));
    const responseLog = logs.find(([label]) => label === '[CDEK][packingQuote][response]')?.[1];
    assert.equal(responseLog?.status, 400);
    assert.equal(responseLog?.requestId, trace.requestId);
    assert.doesNotMatch(JSON.stringify(logs), /buyer@example.org|sensitive-oauth-token|Authorization/);
  } finally {
    (cdekService.getToken as any) = originalToken;
    (axios.request as any) = originalRequest;
    (console.info as any) = originalLog;
  }
});
