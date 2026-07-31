/**
 * Offline smoke: keygen, address shape, signing payload length.
 * With SMOKE_NODE set, also hits chain.info + account.get.
 */
import { createWallet, SikkaClient, parseSikka, CHILLAR_PER_SIKKA } from '../src/sikka_client.js';
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

const client = new SikkaClient({ nodeURL: 'http://example.invalid', wallet });
const tx = client.signTransfer(wallet.address, 1n, 0n);
if (tx.signature.length !== 4627 * 2) throw new Error('bad sig hex length');
if (tx.public_key.length !== 2592 * 2) throw new Error('bad pk hex length');
console.log('signed self-transfer ok, id fields present');

const node = process.env.SMOKE_NODE || process.env.SIKKANODE;
if (node) {
  const urls = node.split(',').map((s) => s.trim()).filter(Boolean);
  const best = await selectBestNodeURL(urls);
  const health = await getHealth(best);
  console.log('node', best, 'height', String(health.height));
  const live = new SikkaClient({ nodeURL: best, wallet });
  const account = await live.account();
  console.log('account.exists', account.exists, 'balance', String(account.balance));
}

console.log('smoke ok');
