/**
 * SIKKA wallet + transfer client — same rules as public/wallet.html / docs/wallets.md.
 */
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { rpc } from './api.js';
import { validateAddress } from './address.js';

export const SEED_LEN = 32;
export const SK_LEN = 4896;
export const PK_LEN = 2592;
export const SIG_LEN = 4627;
export const CHILLAR_PER_SIKKA = 1_000_000_000n;

const TX_SIGNING_TAG = new TextEncoder().encode('SIKKA/tx/v3');
const SIGNING_CONTEXT = new TextEncoder().encode('SIKKA-v1');

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function unhex(text) {
  const clean = String(text).trim().replace(/^0x/i, '').replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) {
    throw new Error('expected even-length hex');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u64le(n) {
  const v = BigInt(n);
  if (v < 0n || v > 0xffffffffffffffffn) throw new Error('u64 out of range');
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function u32le(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
    throw new Error('u32 out of range');
  }
  return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

/** Writer::str: u32 little-endian length + utf8 bytes. */
function encodeStr(text) {
  const bytes = new TextEncoder().encode(text);
  return concat(u32le(bytes.length), bytes);
}

export function asBig(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string') return BigInt(v);
  return 0n;
}

export function formatSikka(chillar) {
  const c = asBig(chillar);
  const sign = c < 0n ? '-' : '';
  const abs = c < 0n ? -c : c;
  const whole = abs / CHILLAR_PER_SIKKA;
  const frac = abs % CHILLAR_PER_SIKKA;
  if (frac === 0n) return `${sign}${whole}`;
  return `${sign}${whole}.${frac.toString().padStart(9, '0').replace(/0+$/, '')}`;
}

export function getBatteryPercent(account, maxBattery = 100) {
  const batteryNow = account?.battery_now ?? account?.battery ?? account?.credits_now ?? account?.credits ?? 0;
  const batteryMax = account?.battery_max ?? account?.max_battery ?? account?.credits_max ?? account?.max_credits ?? maxBattery;
  const current = Number(batteryNow);
  const max = Number(batteryMax);
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((current / max) * 100)));
}

/** Parse a decimal SIKKA amount into CHILLAR (max 9 fractional digits). */
export function parseSikka(input) {
  const text = String(input).trim();
  if (!text) throw new Error('empty amount');
  if (/^all$/i.test(text)) throw new Error('use amount "all" only where supported');
  const [wholeRaw, fracRaw = ''] = text.split('.');
  if (fracRaw.length > 9) throw new Error('at most 9 decimal places');
  if (!/^\d*$/.test(wholeRaw) || !/^\d*$/.test(fracRaw)) {
    throw new Error('not a decimal amount');
  }
  if (!wholeRaw && !fracRaw) throw new Error('empty amount');
  const whole = BigInt(wholeRaw || '0');
  const frac = BigInt(fracRaw.padEnd(9, '0') || '0');
  return whole * CHILLAR_PER_SIKKA + frac;
}

// Matches Transaction::signing_bytes (v3):
// tag || str(chain_id) || kind || from || to || amount || nonce || timestamp || public_key
export function signingBytes({
  chainId,
  kind,
  from,
  to,
  amount,
  nonce,
  timestamp,
  publicKey,
}) {
  if (typeof chainId !== 'string' || !chainId) {
    throw new Error('chain_id required for signing');
  }
  if (from.length !== 32 || to.length !== 32) {
    throw new Error('from/to must be 32 raw address bytes');
  }
  if (publicKey.length !== PK_LEN) {
    throw new Error(`public key must be ${PK_LEN} bytes`);
  }
  return concat(
    TX_SIGNING_TAG,
    encodeStr(chainId),
    Uint8Array.of(kind),
    from,
    to,
    u64le(amount),
    u64le(nonce),
    u64le(timestamp),
    publicKey
  );
}

function walletFromKeys(secretKey, publicKey, seed) {
  if (secretKey.length !== SK_LEN) {
    throw new Error(`private key must be ${SK_LEN} bytes`);
  }
  if (publicKey.length !== PK_LEN) {
    throw new Error(`public key must be ${PK_LEN} bytes`);
  }
  const wallet = {
    address: `0x${hex(sha3_256(publicKey))}`,
    publicKey,
    secretKey,
    publicKeyHex: hex(publicKey),
    privateKeyHex: hex(secretKey),
    scheme: 'ML-DSA-87',
  };
  if (seed && seed.length === SEED_LEN) {
    wallet.seedHex = hex(seed);
  }
  return wallet;
}

/**
 * Build a wallet from a 32-byte seed hex or a full 4896-byte ML-DSA-87 private key hex.
 */
export function createWallet(seedOrKeyHex) {
  const bytes = unhex(seedOrKeyHex);
  if (bytes.length === SEED_LEN) {
    const { secretKey, publicKey } = ml_dsa87.keygen(bytes);
    return walletFromKeys(secretKey, publicKey, bytes);
  }
  if (bytes.length === SK_LEN) {
    const publicKey = ml_dsa87.getPublicKey(bytes);
    return walletFromKeys(bytes, publicKey);
  }
  throw new Error(
    `unrecognized key length ${bytes.length}: use 32-byte seed or ${SK_LEN}-byte ML-DSA-87 key`
  );
}

export class SikkaClient {
  constructor(opts) {
    if (typeof opts === 'string') {
      this.nodeURL = opts.replace(/\/$/, '');
    } else {
      this.nodeURL = (opts.nodeURL || 'http://127.0.0.1:64552').replace(/\/$/, '');
      this.wallet = opts.wallet;
      if (opts.chainId) this.chainId = opts.chainId;
    }
  }

  async account(address = this.wallet?.address) {
    if (!address) throw new Error('address required');
    return rpc(this.nodeURL, 'account.get', { address });
  }

  async balance() {
    const info = await this.account();
    return asBig(info.balance);
  }

  /** Fetch and cache `chain.info.chain_id` (exact string used in signatures). */
  async ensureChainId() {
    if (typeof this.chainId === 'string' && this.chainId) return this.chainId;
    const info = await rpc(this.nodeURL, 'chain.info');
    if (typeof info.chain_id !== 'string' || !info.chain_id) {
      throw new Error('node did not return chain_id');
    }
    this.chainId = info.chain_id;
    return this.chainId;
  }

  /**
   * Sign a transfer for `chainId` (must match the target node's `chain.info`).
   * @param {string} toHex
   * @param {bigint|number|string} amountChillar
   * @param {bigint|number|string} nonce
   * @param {string} chainId
   */
  signTransfer(toHex, amountChillar, nonce, chainId) {
    if (!this.wallet) throw new Error('wallet required');
    if (typeof chainId !== 'string' || !chainId) {
      throw new Error('chain_id required for signing');
    }
    const toNorm = validateAddress(toHex);
    const from = unhex(this.wallet.address);
    const to = unhex(toNorm);
    if (from.length !== 32) throw new Error('wallet address corrupt');
    if (hex(from) === hex(to)) throw new Error('cannot send to yourself');
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const amount = asBig(amountChillar);
    if (amount <= 0n) throw new Error('amount must be positive');
    const msg = signingBytes({
      chainId,
      kind: 0,
      from,
      to,
      amount,
      nonce: asBig(nonce),
      timestamp,
      publicKey: this.wallet.publicKey,
    });
    const signature = ml_dsa87.sign(msg, this.wallet.secretKey, {
      context: SIGNING_CONTEXT,
    });
    if (signature.length !== SIG_LEN) {
      throw new Error(`signature length ${signature.length}, expected ${SIG_LEN}`);
    }
    return {
      kind: 'transfer',
      from: this.wallet.address,
      to: toNorm,
      amount,
      nonce: asBig(nonce),
      timestamp,
      chain_id: chainId,
      public_key: this.wallet.publicKeyHex,
      signature: hex(signature),
    };
  }

  /**
   * Sign and submit a transfer. Amount is CHILLAR.
   * @returns {{ txID: string, sentAmount: bigint, accepted: boolean }}
   */
  async send(amount, recipientAddress) {
    if (!this.wallet) throw new Error('SikkaClient wallet is required');
    const amountBI = asBig(amount);
    if (amountBI <= 0n) throw new Error('amount must be positive');

    const account = await this.account();
    const bal = asBig(account.balance);
    if (bal < amountBI) {
      throw new Error(`insufficient balance: have ${bal} chillar, need ${amountBI} chillar`);
    }
    const batteryNow = account.battery_now ?? account.battery ?? account.credits_now ?? account.credits ?? 0;
    const battery = Number(batteryNow);
    if (battery < 1) {
      throw new Error(
        `insufficient battery for ${this.wallet.address}: has ${battery}, needs 1`
      );
    }

    const chainId = await this.ensureChainId();
    const nonce = asBig(account.next_nonce);
    const tx = this.signTransfer(recipientAddress, amountBI, nonce, chainId);
    const receipt = await rpc(this.nodeURL, 'tx.submit', { transaction: tx });
    return {
      txID: receipt.id,
      sentAmount: amountBI,
      accepted: !!receipt.accepted,
    };
  }
}
