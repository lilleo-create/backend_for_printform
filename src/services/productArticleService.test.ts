import test from 'node:test';
import assert from 'node:assert/strict';
import { allocatePrintFormArticle, isPrintFormArticle } from './productArticleService';
import { resolveCdekWareKey } from './cdekWareKey';

test('PF articles are allocated from one atomic counter and variants remain unique', async () => {
  let number = 0;
  const db = { printFormArticleCounter: { update: async () => ({ lastValue: ++number }) } } as any;
  const article = await allocatePrintFormArticle(db);
  assert.equal(article, 'PF-000001');
  assert.equal(await allocatePrintFormArticle(db, article), 'PF-000001-V2');
  assert.equal(await allocatePrintFormArticle(db, article), 'PF-000001-V3');
});

test('CDEK ware key accepts only a PF article, preferring a real variant article', () => {
  assert.equal(resolveCdekWareKey({ sku: 'PF-000001' }), 'PF-000001');
  assert.equal(resolveCdekWareKey({ sku: 'PF-000001' }, { sku: 'PF-000001-V2' }), 'PF-000001-V2');
  assert.equal(isPrintFormArticle('SKU-123'), false);
  assert.throws(() => resolveCdekWareKey({ sku: 'SKU-123' }), /CDEK_ARTICLE_INVALID/);
  assert.throws(() => resolveCdekWareKey({ sku: 'PF-000001' }, { sku: null }), /CDEK_ARTICLE_INVALID/);
});
