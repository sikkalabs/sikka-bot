/**
 * migrate_wallets.js
 *
 * Per-user wallet migration module.
 *
 * Called automatically the first time a user interacts with any wallet command.
 * Sweeps funds from old broken derivation schemes to the correct WALLETSEED wallet.
 *
 * Old schemes (bugs):
 *   Scheme A: sha256(PRIVATEKEY + userId)          — original fallback bug
 *   Scheme B: sha256(sha256(PRIVATEKEY+"userwallet-salt") + userId) — short-lived intermediate
 *
 * Correct scheme:
 *   Scheme C: sha256(WALLETSEED + userId)
 *
 * Once a user has been migrated, their ID is recorded in migrated_users and
 * this function becomes a no-op (single DB lookup cost only).
 */

import crypto from 'crypto';
import { SikkaClient, createWallet } from './sikka_client.js';
import { hasUserMigrated, markUserMigrated } from './db.js';

function deriveHex(seed, userId) {
  return crypto.createHash('sha256').update(seed + String(userId)).digest('hex');
}

async function getOldWallets(privKey, userId) {
  // Scheme A: sha256(PRIVATEKEY + userId)
  const walletA = await createWallet(deriveHex(privKey, userId));

  // Scheme B: sha256(sha256(PRIVATEKEY + "userwallet-salt") + userId)
  const salt = crypto.createHash('sha256').update(privKey + 'userwallet-salt').digest('hex');
  const walletB = await createWallet(deriveHex(salt, userId));

  return [
    { name: 'A', wallet: walletA },
    { name: 'B', wallet: walletB },
  ];
}

/**
 * ensureUserMigrated
 *
 * Silently sweeps any balance from old scheme wallets → new WALLETSEED wallet.
 * Marks the user as migrated in the DB so subsequent calls are instant no-ops.
 *
 * Never throws — migration errors are logged but never surface to the user.
 *
 * @param {object} db          - sqlite db handle
 * @param {string} nodeURL     - active Sikka node URL
 * @param {string} privKey     - faucet PRIVATEKEY (used to re-derive old wallets)
 * @param {string} walletSeed  - WALLETSEED (used to derive new wallet)
 * @param {string|number} userId - Telegram user ID
 * @param {object} newWallet   - already-derived Scheme C wallet (avoids re-deriving)
 */
export async function ensureUserMigrated(db, nodeURL, privKey, walletSeed, userId, newWallet) {
  try {
    if (await hasUserMigrated(db, userId)) return; // fast path — already done

    const oldWallets = await getOldWallets(privKey, userId);

    for (const { name, wallet: oldWallet } of oldWallets) {
      // Skip if the old address somehow equals the new one (no-op guard)
      if (oldWallet.address === newWallet.address) continue;

      const client = new SikkaClient({ nodeURL, wallet: oldWallet });

      let balance;
      try {
        balance = BigInt(await client.balance());
      } catch {
        continue; // node error — skip, will retry next time
      }

      if (balance === 0n) continue;

      console.log(`[migration] userId=${userId} scheme=${name}: sweeping ${balance} chillar from ${oldWallet.address} → ${newWallet.address}`);

      try {
        const { txID } = await client.send(balance, newWallet.address);
        console.log(`[migration] userId=${userId} scheme=${name}: swept ✅ tx=${txID}`);
      } catch (err) {
        // Don't mark as migrated — retry next interaction
        console.error(`[migration] userId=${userId} scheme=${name}: sweep failed: ${err.message}`);
        return;
      }
    }

    await markUserMigrated(db, userId);
  } catch (err) {
    // Never let migration errors bubble up to the user
    console.error(`[migration] userId=${userId}: unexpected error: ${err.message}`);
  }
}
