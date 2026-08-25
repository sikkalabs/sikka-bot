import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SIKKA_ETH_TOKEN,
  formatFiat,
  priceFromGeckoPool,
} from '../src/price.js';

const POOL = {
  data: {
    id: 'eth_0x2898fdc38e4a17907ea1a39eb9be67adb8719c779ba22c7928fc37a6c240d75b',
    type: 'pool',
    attributes: {
      base_token_price_usd: '0.01274220573',
      base_token_price_native_currency: '0.00000707340369585336',
      quote_token_price_usd: '1881.25',
      quote_token_price_native_currency: '1.0',
    },
    relationships: {
      base_token: {
        data: { id: `eth_${SIKKA_ETH_TOKEN}`, type: 'token' },
      },
      quote_token: {
        data: { id: 'eth_0x0000000000000000000000000000000000000000', type: 'token' },
      },
    },
  },
};

describe('priceFromGeckoPool', () => {
  it('reads SIKKA as the base token', () => {
    const spot = priceFromGeckoPool(POOL);
    assert.equal(spot.usd, 0.01274220573);
    assert.equal(spot.eth, 0.00000707340369585336);
    assert.equal(spot.ethUsd, 1881.25);
  });

  it('reads SIKKA as the quote token', () => {
    const swapped = structuredClone(POOL);
    swapped.data.relationships.base_token.data.id =
      'eth_0x0000000000000000000000000000000000000000';
    swapped.data.relationships.quote_token.data.id = `eth_${SIKKA_ETH_TOKEN}`;
    swapped.data.attributes.quote_token_price_usd = '0.01274220573';
    swapped.data.attributes.quote_token_price_native_currency = '0.00000707340369585336';
    swapped.data.attributes.base_token_price_usd = '1881.25';

    const spot = priceFromGeckoPool(swapped);
    assert.equal(spot.usd, 0.01274220573);
    assert.equal(spot.eth, 0.00000707340369585336);
    assert.equal(spot.ethUsd, 1881.25);
  });

  it('rejects a pool that does not contain the token', () => {
    assert.throws(
      () => priceFromGeckoPool(POOL, '0x1111111111111111111111111111111111111111'),
      /does not contain token/,
    );
  });

  it('rejects a missing USD price', () => {
    const bad = structuredClone(POOL);
    bad.data.attributes.base_token_price_usd = '0';
    assert.throws(() => priceFromGeckoPool(bad), /USD price missing/);
  });
});

describe('formatFiat', () => {
  it('formats sub-cent SIKKA prices with extra digits', () => {
    assert.equal(formatFiat(0.01274220573), '0.012742');
  });

  it('returns an em dash for non-finite values', () => {
    assert.equal(formatFiat(NaN), '—');
  });
});
