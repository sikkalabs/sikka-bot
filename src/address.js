/** SIKKA addresses: `0x` + 64 hex chars (SHA3-256 of an ML-DSA-87 public key). */

export const addressRe = /0x[0-9a-fA-F]{64}\b/g;

/**
 * Normalize and validate a hex address.
 * @returns {string} lowercase `0x` + 64 hex
 */
export function validateAddress(raw) {
  const text = String(raw).trim();
  const match = text.match(/^0x([0-9a-fA-F]{64})$/);
  if (!match) {
    throw new Error('invalid address: expected 0x + 64 hex characters');
  }
  return `0x${match[1].toLowerCase()}`;
}

export function isAddress(raw) {
  try {
    validateAddress(raw);
    return true;
  } catch {
    return false;
  }
}
