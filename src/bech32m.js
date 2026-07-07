const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values) {
  let chk = 1;
  for (let v of values) {
    let top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    if (top & 1) chk ^= 0x3b6a57b2;
    if (top & 2) chk ^= 0x26508e6d;
    if (top & 4) chk ^= 0x1ea119fa;
    if (top & 8) chk ^= 0x3d4233dd;
    if (top & 16) chk ^= 0x2a1462b3;
  }
  return chk;
}

function bech32HRPExpand(hrp) {
  let out = [];
  for (let i = 0; i < hrp.length; i++) {
    out.push(hrp.charCodeAt(i) >> 5);
  }
  out.push(0);
  for (let i = 0; i < hrp.length; i++) {
    out.push(hrp.charCodeAt(i) & 31);
  }
  return out;
}

function bech32VerifyChecksum(hrp, values) {
  return bech32Polymod(bech32HRPExpand(hrp).concat(values)) === BECH32M_CONST;
}

function bech32Checksum(hrp, data) {
  let values = bech32HRPExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  let mod = bech32Polymod(values) ^ BECH32M_CONST;
  let ret = [];
  for (let i = 0; i < 6; i++) {
    ret.push((mod >> (5 * (5 - i))) & 31);
  }
  return ret;
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0;
  let bits = 0;
  let ret = [];
  let maxv = (1 << toBits) - 1;
  for (let v of data) {
    if (v < 0 || (v >> fromBits) !== 0) throw new Error("Invalid value");
    acc = (acc << fromBits) | v;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    throw new Error("Invalid padding");
  }
  return ret;
}

export function decodeBech32m(address) {
  let pos = address.lastIndexOf('1');
  if (pos < 1 || pos + 7 > address.length) throw new Error("Invalid bech32 length");
  let hrp = address.substring(0, pos);
  let encoded = address.substring(pos + 1);
  let values = [];
  for (let i = 0; i < encoded.length; i++) {
    let idx = CHARSET.indexOf(encoded[i]);
    if (idx === -1) throw new Error("Invalid character");
    values.push(idx);
  }
  if (!bech32VerifyChecksum(hrp, values)) throw new Error("Invalid checksum");
  values = values.slice(0, values.length - 6);
  if (values.length === 0) throw new Error("Empty payload");
  let version = values[0];
  let prog = convertBits(values.slice(1), 5, 8, false);
  return { hrp, version, program: Uint8Array.from(prog) };
}

export function encodeBech32m(hrp, version, program) {
  let converted = convertBits(Array.from(program), 8, 5, true);
  let data = [version].concat(converted);
  let checksum = bech32Checksum(hrp, data);
  let combined = data.concat(checksum);
  let ret = hrp + '1';
  for (let v of combined) {
    ret += CHARSET[v];
  }
  return ret;
}

export function validateAddress(addr) {
  const normalized = addr.toLowerCase().trim();
  const { hrp, version, program } = decodeBech32m(normalized);
  if (hrp !== 'sikka') throw new Error("wrong address HRP");
  if (version !== 1) throw new Error("wrong address version");
  if (program.length !== 32) throw new Error("wrong program length");
  return normalized;
}

export const addressRe = /sikka1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,}/g;
