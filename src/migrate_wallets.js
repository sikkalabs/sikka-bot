/**
 * migrate_wallets.js
 *
 * One-time (but safe to re-run) migration that sweeps funds from old user
 * wallet derivation schemes to the correct WALLETSEED-based wallets.
 *
 * Background
 * ----------
 * Before WALLETSEED was enforced, getUserWallet() fell back to PRIVATEKEY
 * as the base seed, producing user wallets that were either:
 *
 *   Scheme A (original bug):
 *     derivedHex = sha256(PRIVATEKEY + userId)
 *
 *   Scheme B (intermediate salted fallback, short-lived):
 *     salt      = sha256(PRIVATEKEY + "userwallet-salt")
 *     derivedHex = sha256(salt + userId)
 *
 * The correct derivation (Scheme C) is:
 *     derivedHex = sha256(WALLETSEED + userId)
 *
 * This script:
 *   1. Collects every known user ID from the claims + raffle_entries tables.
 *   2. For each user, derives their Scheme A and Scheme B addresses.
 *   3. Checks the on-chain balance of each old address.
 *   4. If a balance is found, sweeps it to the user's current Scheme C wallet.
 *   5. Logs the result to stdout and to migration_log.json in the DB directory.
 *
 * Usage
 * -----
 *   node src/migrate_wallets.js
 *
 * Required env vars (same as the bot):
 *   PRIVATEKEY, WALLETSEED, SIKKANODE, DBPATH (optional, defaults to ./claims.db)
 *
 * Safe to run multiple times — already-empty old wallets are silently skipped.
 */

import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { SikkaClient, createWallet } from 'sikka-sdk';
import { selectBestNodeURL } from './api.js';

dotenv.config();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deriveHex(seed, userId) {
  return crypto.createHash('sha256').update(seed + String(userId)).digest('hex');
}

async function oldWalletA(privKey, userId) {
  // Scheme A: sha256(PRIVATEKEY + userId)
  return createWallet(deriveHex(privKey, userId));
}

async function oldWalletB(privKey, userId) {
  // Scheme B: sha256(sha256(PRIVATEKEY + "userwallet-salt") + userId)
  const salt = crypto.createHash('sha256').update(privKey + 'userwallet-salt').digest('hex');
  return createWallet(deriveHex(salt, userId));
}

async function newWallet(walletSeed, userId) {
  // Scheme C (correct): sha256(WALLETSEED + userId)
  return createWallet(deriveHex(walletSeed, userId));
}

async function getBalance(client) {
  try {
    return BigInt(await client.balance());
  } catch {
    return 0n;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Validate env ────────────────────────────────────────────────────────────
  const privKey    = process.env.PRIVATEKEY || process.env.privatekey;
  const walletSeed = process.env.WALLETSEED;
  const nodeURLsRaw = process.env.SIKKANODE || process.env.sikkanode;

  if (!privKey)    throw new Error("env var 'PRIVATEKEY' is required");
  if (!walletSeed) throw new Error("env var 'WALLETSEED' is required");
  if (!nodeURLsRaw) throw new Error("env var 'SIKKANODE' is required");

  const nodeURLs = nodeURLsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const nodeURL  = await selectBestNodeURL(nodeURLs);
  console.log(`\n🔗  Using node: ${nodeURL}`);

  // ── Open DB ─────────────────────────────────────────────────────────────────
  const dbPath = process.env.DBPATH || path.join(process.cwd(), 'claims.db');
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  console.log(`💾  Opened DB:  ${dbPath}\n`);

  // ── Collect all known user IDs ───────────────────────────────────────────────
  const claimRows  = await db.all(`SELECT DISTINCT telegram_user_id FROM claims`);
  const raffleRows = await db.all(`SELECT DISTINCT telegram_user_id FROM raffle_entries`).catch(() => []);
  const userIdSet  = new Set([
    ...claimRows.map(r => r.telegram_user_id),
    ...raffleRows.map(r => r.telegram_user_id),
  ]);

  console.log(`👥  Found ${userIdSet.size} unique user(s) to check.\n`);

  // ── Migration log ────────────────────────────────────────────────────────────
  const logPath    = path.join(path.dirname(dbPath), 'migration_log.json');
  const existingLog = fs.existsSync(logPath)
    ? JSON.parse(fs.readFileSync(logPath, 'utf8'))
    : [];
  const logEntries = [];

  let swept = 0;
  let skipped = 0;
  let errors = 0;

  // ── Faucet wallet (fee sink, excluded from migration targets) ────────────────
  const faucetWallet  = await createWallet(privKey);
  const faucetAddress = faucetWallet.address;

  for (const userId of userIdSet) {
    const target = await newWallet(walletSeed, userId);

    for (const [schemeName, getOldWallet] of [
      ['A (PRIVATEKEY + userId)',              () => oldWalletA(privKey, userId)],
      ['B (salted PRIVATEKEY + userId)',        () => oldWalletB(privKey, userId)],
    ]) {
      let oldW;
      try {
        oldW = await getOldWallet();
      } catch (e) {
        console.error(`  ⚠️  userId=${userId} scheme=${schemeName}: failed to derive wallet: ${e.message}`);
        errors++;
        continue;
      }

      // Skip if old address === new address (nothing to do)
      if (oldW.address === target.address) continue;

      // Skip if old address === faucet address (safety guard)
      if (oldW.address === faucetAddress) continue;

      const oldClient = new SikkaClient({ nodeURL, wallet: oldW });
      const balance   = await getBalance(oldClient);

      if (balance === 0n) {
        console.log(`  ⬜  userId=${userId}  scheme=${schemeName}  ${oldW.address}  → empty, skip`);
        skipped++;
        continue;
      }

      console.log(`  💰  userId=${userId}  scheme=${schemeName}`);
      console.log(`      from: ${oldW.address}  (${balance} chillar)`);
      console.log(`      to:   ${target.address}`);

      try {
        const { txID, sentAmount } = await oldClient.send(balance, target.address);
        console.log(`      ✅  tx: ${txID}  sent: ${sentAmount} chillar\n`);
        logEntries.push({
          timestamp:   new Date().toISOString(),
          userId,
          scheme:      schemeName,
          fromAddress: oldW.address,
          toAddress:   target.address,
          amount:      balance.toString(),
          txID,
          status:      'success',
        });
        swept++;
      } catch (e) {
        console.error(`      ❌  send failed: ${e.message}\n`);
        logEntries.push({
          timestamp:   new Date().toISOString(),
          userId,
          scheme:      schemeName,
          fromAddress: oldW.address,
          toAddress:   target.address,
          amount:      balance.toString(),
          error:       e.message,
          status:      'failed',
        });
        errors++;
      }
    }
  }

  // ── Write log ────────────────────────────────────────────────────────────────
  fs.writeFileSync(logPath, JSON.stringify([...existingLog, ...logEntries], null, 2));

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('─'.repeat(60));
  console.log(`✅  Swept:   ${swept} wallet(s)`);
  console.log(`⬜  Skipped: ${skipped} wallet(s) (no balance)`);
  console.log(`❌  Errors:  ${errors}`);
  console.log(`📄  Log:     ${logPath}`);
  console.log('─'.repeat(60));

  await db.close();
}

main().catch(err => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
