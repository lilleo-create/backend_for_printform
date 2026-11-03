import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordJobRun } from './operationalState';

test('job state persists success, failure and next success without an error body', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'printform-job-state-'));
  try {
    await recordJobRun('payment-expiry', { ok: true, counts: { expired: 2 } }, dir, new Date('2026-11-03T10:00:00Z'));
    await recordJobRun('payment-expiry', { ok: false }, dir, new Date('2026-11-03T10:01:00Z'));
    const failed = JSON.parse(await readFile(path.join(dir, 'payment-expiry.json'), 'utf8'));
    assert.equal(failed.lastSuccessAt, '2026-11-03T10:00:00.000Z');
    assert.equal(failed.consecutiveFailures, 1);
    assert.deepEqual(failed.counts, { expired: 2 });
    assert.equal(JSON.stringify(failed).includes('secret'), false);
    await recordJobRun('payment-expiry', { ok: true, counts: { expired: 0 } }, dir, new Date('2026-11-03T10:02:00Z'));
    const recovered = JSON.parse(await readFile(path.join(dir, 'payment-expiry.json'), 'utf8'));
    assert.equal(recovered.consecutiveFailures, 0);
    assert.equal(recovered.lastSuccessAt, '2026-11-03T10:02:00.000Z');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
