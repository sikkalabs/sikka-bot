import crypto from 'crypto';
import { encodeBech32m } from './bech32m.js';
import { doNodeRequest, getAddressInfo, getTips, submitTx } from './api.js';

export function derivePublicKey(seedHex) {
  const seedBuf = Buffer.from(seedHex, 'hex');
  const pkBuf = Buffer.alloc(1793);
  const hash = crypto.createHash('sha3-256').update(seedBuf).digest();
  for (let i = 0; i < 1793; i++) {
    pkBuf[i] = hash[i % 32] ^ (i & 0xff);
  }
  return pkBuf;
}

export function createWallet(seedHex) {
  const formattedSeed = String(seedHex).padStart(64, '0').slice(0, 64);
  const seedBuf = Buffer.from(formattedSeed, 'hex');
  const pkBuf = derivePublicKey(formattedSeed);
  const pkHash = crypto.createHash('sha3-256').update(pkBuf).digest();
  const address = encodeBech32m('sikka', 1, pkHash);

  return {
    seedHex: formattedSeed,
    address,
    publicKeyHex: pkBuf.toString('hex'),
    privateKeyHex: seedBuf.toString('hex'),
    sign(payloadBuf) {
      const sigBuf = Buffer.alloc(1280);
      const h = crypto.createHash('sha3-256').update(payloadBuf).update(seedBuf).digest();
      for (let i = 0; i < 1280; i++) {
        sigBuf[i] = h[i % 32] ^ ((i * 7) & 0xff);
      }
      return sigBuf.toString('hex');
    }
  };
}

export function computeTxIdRaw(tx) {
  const parts = [];
  parts.push(Buffer.from([0x02]));

  // Parents
  const pCount = Buffer.alloc(4);
  pCount.writeUInt32BE(tx.parents.length);
  parts.push(pCount);
  for (const parentId of tx.parents) {
    parts.push(Buffer.from(parentId, 'hex'));
  }

  // Inputs
  const iCount = Buffer.alloc(4);
  iCount.writeUInt32BE(tx.inputs.length);
  parts.push(iCount);
  for (const input of tx.inputs) {
    parts.push(Buffer.from(input.txid, 'hex'));
    const idx = Buffer.alloc(4);
    idx.writeUInt32BE(input.index);
    parts.push(idx);
  }

  // Outputs
  const oCount = Buffer.alloc(4);
  oCount.writeUInt32BE(tx.outputs.length);
  parts.push(oCount);
  for (const output of tx.outputs) {
    const addrBytes = Buffer.from(output.address, 'utf8');
    const aLen = Buffer.alloc(2);
    aLen.writeUInt16BE(addrBytes.length);
    parts.push(aLen);
    parts.push(addrBytes);

    const val = Buffer.alloc(8);
    val.writeBigUInt64BE(BigInt(output.value));
    parts.push(val);
  }

  // Timestamp
  const ts = Buffer.alloc(8);
  ts.writeBigInt64BE(BigInt(tx.timestamp));
  parts.push(ts);

  // Optional Memo (Max 32 bytes)
  if (tx.memo) {
    const memoBytes = Buffer.from(tx.memo, 'utf8').slice(0, 32);
    const mLen = Buffer.alloc(2);
    mLen.writeUInt16BE(memoBytes.length);
    parts.push(mLen);
    parts.push(memoBytes);
  } else {
    parts.push(Buffer.from([0x00, 0x00]));
  }

  const fullBuf = Buffer.concat(parts);
  return crypto.createHash('sha3-256').update(fullBuf).digest();
}

export function computeSigningPayload(txIdRaw, inputIndex, spentTxIdRaw, spentOutputIndex, spentValue, spentAddress) {
  const parts = [];
  parts.push(Buffer.from('sikka:mldsa87:signing_domain', 'utf8'));
  parts.push(txIdRaw);

  const idxBuf = Buffer.alloc(8);
  idxBuf.writeBigUInt64BE(BigInt(inputIndex));
  parts.push(idxBuf);

  parts.push(spentTxIdRaw);

  const outIdxBuf = Buffer.alloc(8);
  outIdxBuf.writeBigUInt64BE(BigInt(spentOutputIndex));
  parts.push(outIdxBuf);

  const valBuf = Buffer.alloc(8);
  valBuf.writeBigUInt64BE(BigInt(spentValue));
  parts.push(valBuf);

  const addrBytes = Buffer.from(spentAddress, 'utf8');
  const aLen = Buffer.alloc(2);
  aLen.writeUInt16BE(addrBytes.length);
  parts.push(aLen);
  parts.push(addrBytes);

  return crypto.createHash('sha3-256').update(Buffer.concat(parts)).digest();
}

export function solveTxPow(tx, requiredBits = 0) {
  const txIdRaw = computeTxIdRaw(tx);
  let p0 = Buffer.alloc(32);
  let p1 = Buffer.alloc(32);

  if (tx.parent_pow_hashes && tx.parent_pow_hashes.length >= 1) {
    p0 = Buffer.from(tx.parent_pow_hashes[0], 'hex');
  }
  if (tx.parent_pow_hashes && tx.parent_pow_hashes.length >= 2) {
    p1 = Buffer.from(tx.parent_pow_hashes[1], 'hex');
  }

  for (let nonce = 0n; nonce < 1000000n; nonce++) {
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64BE(nonce);

    const buf = Buffer.concat([txIdRaw, p0, p1, nonceBuf]);
    const hash = crypto.createHash('sha3-256').update(buf).digest();

    let bits = 0;
    for (const b of hash) {
      if (b === 0) {
        bits += 8;
      } else {
        bits += Math.clz32(b) - 24;
        break;
      }
    }

    if (bits >= requiredBits) {
      tx.pow_nonce = Number(nonce);
      tx.pow_bits = bits;
      return bits;
    }
  }
  return 0;
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

  async balance() {
    if (!this.wallet || !this.wallet.address) {
      throw new Error('SikkaClient wallet address is required');
    }
    const info = await getAddressInfo(this.nodeURL, this.wallet.address);
    return BigInt(info.balance || 0);
  }

  async send(amount, recipientAddress, memo) {
    if (!this.wallet || !this.wallet.address) {
      throw new Error('SikkaClient wallet address is required');
    }
    const amountBI = BigInt(amount);
    const info = await getAddressInfo(this.nodeURL, this.wallet.address);
    const utxos = info.utxos || [];

    let accumulated = 0n;
    const selected = [];
    for (const u of utxos) {
      selected.push(u);
      accumulated += BigInt(u.value);
      if (accumulated >= amountBI) break;
    }

    if (accumulated < amountBI) {
      throw new Error(`insufficient balance: accumulated ${accumulated} chillar < required ${amountBI} chillar`);
    }

    const change = accumulated - amountBI;
    const tips = await getTips(this.nodeURL);

    const tx = {
      id: '',
      parents: tips,
      parent_pow_hashes: null,
      inputs: selected.map(u => ({
        txid: u.txid,
        index: u.index,
        witness: null
      })),
      outputs: [
        { address: recipientAddress, value: Number(amountBI) },
        ...(change > 0n ? [{ address: this.wallet.address, value: Number(change) }] : [])
      ],
      pow_nonce: 0,
      pow_bits: 0,
      timestamp: Math.floor(Date.now() / 1000),
      witness_stripped: null,
      memo: memo ? String(memo).slice(0, 32) : null
    };

    const txIdRaw = computeTxIdRaw(tx);

    tx.inputs.forEach((input, i) => {
      const u = selected[i];
      const spentTxIdRaw = Buffer.from(u.txid, 'hex');
      const payloadBuf = computeSigningPayload(txIdRaw, i, spentTxIdRaw, u.index, u.value, u.address);
      const sigHex = this.wallet.sign(payloadBuf);

      input.witness = {
        witness_type: 'falcon1024',
        threshold: {
          threshold: 1,
          public_keys: [this.wallet.publicKeyHex],
          signatures: [sigHex]
        }
      };
    });

    solveTxPow(tx, 0);
    const txID = await submitTx(this.nodeURL, tx);

    return { txID, sentAmount: amountBI };
  }
}
