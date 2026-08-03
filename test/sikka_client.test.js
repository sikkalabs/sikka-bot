import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWallet, getBatteryPercent } from '../src/sikka_client.js';

describe('createWallet', () => {
  it('creates a wallet from a 32-byte seed', () => {
    const wallet = createWallet('00'.repeat(32));
    assert.equal(wallet.address.startsWith('0x'), true);
    assert.equal(wallet.publicKeyHex.length, 2592 * 2);
  });
});

describe('getBatteryPercent', () => {
  it('reads the new battery_now field', () => {
    assert.equal(getBatteryPercent({ battery_now: 80 }), 80);
  });

  it('falls back to legacy credits fields', () => {
    assert.equal(getBatteryPercent({ credits_now: 50, credits_max: 100 }), 50);
  });
});
