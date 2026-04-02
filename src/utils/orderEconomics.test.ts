import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOrderEconomics } from './orderEconomics';

test('calculateOrderEconomics computes service fee as platform + provider and net after full service fee', () => {
  process.env.PLATFORM_FEE_BPS = '900';
  process.env.ACQUIRING_FEE_BPS = '400';

  const economics = calculateOrderEconomics(100_000);

  assert.equal(economics.platformFeeKopecks, 9_000);
  assert.equal(economics.acquiringFeeKopecks, 4_000);
  assert.equal(economics.serviceFeeKopecks, 13_000);
  assert.equal(economics.sellerNetAmountKopecks, 87_000);
});
