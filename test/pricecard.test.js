import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPriceCard, formatUsd3 } from '../src/pricecard.js';

test('formatUsd3 shows exactly 3 decimals', () => {
  assert.equal(formatUsd3(0.01274220573), '0.013');
  assert.equal(formatUsd3(1.2), '1.200');
  assert.equal(formatUsd3(1234.5), '1,234.500');
  assert.equal(formatUsd3(NaN), '—');
});

test('renderPriceCard returns a PNG buffer', async () => {
  const buf = await renderPriceCard(0.01274220573);
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 10_000);
  // PNG magic bytes
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});
