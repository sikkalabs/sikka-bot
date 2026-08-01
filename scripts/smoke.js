/**
 * Offline smoke: keygen, address shape, v3 signing payload layout.
 * With SMOKE_NODE set, also hits chain.info + account.get.
 */
import { createHash } from 'crypto';
import {
  createWallet,
  SikkaClient,
  parseSikka,
  CHILLAR_PER_SIKKA,
  signingBytes,
  hex,
  unhex,
  PK_LEN,
} from '../src/sikka_client.js';
import { validateAddress } from '../src/address.js';
import { selectBestNodeURL, getHealth } from '../src/api.js';

const seed = '01'.repeat(32);
const wallet = createWallet(seed);
console.log('address', wallet.address);
validateAddress(wallet.address);
if (!wallet.address.startsWith('0x') || wallet.address.length !== 66) {
  throw new Error('bad address length');
}
if (wallet.publicKey.length !== 2592 || wallet.secretKey.length !== 4896) {
  throw new Error('bad key sizes');
}
if (parseSikka('1.5') !== (CHILLAR_PER_SIKKA * 3n) / 2n) {
  throw new Error('parseSikka failed');
}

// Golden layout vs Rust Transaction::signing_bytes (0xAB pubkey fixture).
{
  const publicKey = new Uint8Array(PK_LEN).fill(0xab);
  const fromHex =
    '0x' + createHash('sha3-256').update(Buffer.from(publicKey)).digest('hex');
  const from = unhex(fromHex);
  const to = new Uint8Array(32).fill(0x11);
  const msg = signingBytes({
    chainId: 'sikka-test',
    kind: 0,
    from,
    to,
    amount: 1_500_000_000n,
    nonce: 7n,
    timestamp: 1_720_000_000n,
    publicKey,
  });
  if (msg.length !== 2706) throw new Error(`bad preimage length ${msg.length}`);
  const prefix = hex(msg.slice(0, 26));
  const expected = '53494b4b412f74782f76330a00000073696b6b612d7465737400';
  if (prefix !== expected) {
    throw new Error(`bad v3 prefix: ${prefix}`);
  }
  console.log('v3 preimage layout ok');
}

const other = createWallet('02'.repeat(32));
const client = new SikkaClient({ nodeURL: 'http://example.invalid', wallet });
const tx = client.signTransfer(other.address, 1n, 0n, 'sikka-test');
if (tx.signature.length !== 4627 * 2) throw new Error('bad sig hex length');
if (tx.public_key.length !== 2592 * 2) throw new Error('bad pk hex length');
if (tx.chain_id !== 'sikka-test') throw new Error('missing chain_id on tx');
console.log('signed transfer ok');

const node = process.env.SMOKE_NODE || process.env.SIKKANODE;
if (node) {
  const urls = node.split(',').map((s) => s.trim()).filter(Boolean);
  const best = await selectBestNodeURL(urls);
  const health = await getHealth(best);
  console.log('node', best, 'height', String(health.height), 'chain_id', health.chain_id);
  const live = new SikkaClient({ nodeURL: best, wallet });
  const chainId = await live.ensureChainId();
  console.log('rpc chain_id', chainId);
  const account = await live.account();
  console.log('account.exists', account.exists, 'balance', String(account.balance));
}

console.log('smoke ok');
