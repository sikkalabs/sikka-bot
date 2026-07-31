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

const TX_SIGNING_TAG = new TextEncoder().encode('SIKKA/tx/v1');
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

function signingBytes({ kind, from, to, amount, nonce, timestamp }) {
  return concat(
    TX_SIGNING_TAG,
    Uint8Array.of(kind),
    from,
    to,
    u64le(amount),
    u64le(nonce),
    u64le(timestamp)
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

  signTransfer(toHex, amountChillar, nonce) {
    if (!this.wallet) throw new Error('wallet required');
    const toNorm = validateAddress(toHex);
    const from = unhex(this.wallet.address);
    const to = unhex(toNorm);
    if (to.length !== 32) throw new Error('recipient must be a 32-byte address');
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const amount = asBig(amountChillar);
    const msg = signingBytes({
      kind: 0,
      from,
      to,
      amount,
      nonce: asBig(nonce),
      timestamp,
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
    const credits = Number(account.credits_now ?? account.credits ?? 0);
    if (credits < 1) {
      throw new Error(
        `insufficient credits for ${this.wallet.address}: has ${credits}, needs 1`
      );
    }

    const nonce = asBig(account.next_nonce);
    const tx = this.signTransfer(recipientAddress, amountBI, nonce);
    const receipt = await rpc(this.nodeURL, 'tx.submit', { transaction: tx });
    return {
      txID: receipt.id,
      sentAmount: amountBI,
      accepted: !!receipt.accepted,
    };
  }
}
