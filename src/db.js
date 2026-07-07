import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

export async function initDB(dbPath) {
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  
  await db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      telegram_user_id TEXT NOT NULL,
      claimed_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_claims_user ON claims(telegram_user_id);
  `);
  
  return db;
}

const CLAIM_COOLDOWN = (parseInt(process.env.COOLDOWN_HOURS) || 3) * 60 * 60 * 1000;

// Returns { ok: boolean, remaining: number (ms) }
export async function canClaim(db, userId) {
  const cutoff = Math.floor((Date.now() - CLAIM_COOLDOWN) / 1000);
  const row = await db.get(
    `SELECT claimed_at FROM claims WHERE telegram_user_id = ? AND claimed_at > ? ORDER BY claimed_at DESC LIMIT 1`,
    [String(userId), cutoff]
  );
  
  if (!row) {
    return { ok: true, remaining: 0 };
  }
  
  const lastClaim = row.claimed_at * 1000;
  const remaining = (lastClaim + CLAIM_COOLDOWN) - Date.now();
  if (remaining <= 0) {
    return { ok: true, remaining: 0 };
  }
  return { ok: false, remaining };
}

export async function recordClaim(db, userId) {
  const now = Math.floor(Date.now() / 1000);
  await db.run(
    `INSERT INTO claims (telegram_user_id, claimed_at) VALUES (?, ?)`,
    [String(userId), now]
  );
}
