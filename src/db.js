import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

export async function initDB(dbPath) {
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`);

  await db.exec(`
    -- One row per user; upsert on write — never grows unboundedly
    CREATE TABLE IF NOT EXISTS claims (
      telegram_user_id TEXT    PRIMARY KEY,
      claimed_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS raffles (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_fee    TEXT    NOT NULL,
      end_time     INTEGER NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'active',
      winner_id    TEXT,
      prize_amount TEXT
    );
    -- getActiveRaffle runs every 5 s — index keeps it O(log n)
    CREATE INDEX IF NOT EXISTS idx_raffles_status ON raffles(status);

    -- Composite PK handles uniqueness; no separate index needed
    CREATE TABLE IF NOT EXISTS raffle_entries (
      raffle_id        INTEGER NOT NULL,
      telegram_user_id TEXT    NOT NULL,
      PRIMARY KEY (raffle_id, telegram_user_id)
    );

    -- One row per user; upsert on write
    CREATE TABLE IF NOT EXISTS raffle_creations (
      telegram_user_id TEXT    PRIMARY KEY,
      created_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS migrated_users (
      telegram_user_id TEXT PRIMARY KEY,
      migrated_at      INTEGER NOT NULL
    );
  `);

  return db;
}

// ─── Claim cooldown ───────────────────────────────────────────────────────────

const CLAIM_COOLDOWN_MS = (parseInt(process.env.COOLDOWN_HOURS) || 3) * 60 * 60 * 1000;

export async function canClaim(db, userId) {
  const row = await db.get(
    `SELECT claimed_at FROM claims WHERE telegram_user_id = ?`,
    [String(userId)]
  );
  if (!row) return { ok: true, remaining: 0 };
  const remaining = (row.claimed_at * 1000 + CLAIM_COOLDOWN_MS) - Date.now();
  if (remaining <= 0) return { ok: true, remaining: 0 };
  return { ok: false, remaining };
}

export async function recordClaim(db, userId) {
  await db.run(
    `INSERT OR REPLACE INTO claims (telegram_user_id, claimed_at) VALUES (?, ?)`,
    [String(userId), Math.floor(Date.now() / 1000)]
  );
}

// ─── Raffle-creation cooldown ─────────────────────────────────────────────────

const RAFFLE_CREATE_COOLDOWN_MS = 3 * 60 * 60 * 1000;

export async function canCreateRaffle(db, userId) {
  const row = await db.get(
    `SELECT created_at FROM raffle_creations WHERE telegram_user_id = ?`,
    [String(userId)]
  );
  if (!row) return { ok: true, remaining: 0 };
  const remaining = (row.created_at * 1000 + RAFFLE_CREATE_COOLDOWN_MS) - Date.now();
  if (remaining <= 0) return { ok: true, remaining: 0 };
  return { ok: false, remaining };
}

export async function recordRaffleCreate(db, userId) {
  await db.run(
    `INSERT OR REPLACE INTO raffle_creations (telegram_user_id, created_at) VALUES (?, ?)`,
    [String(userId), Math.floor(Date.now() / 1000)]
  );
}

// ─── Raffle CRUD ──────────────────────────────────────────────────────────────

export async function createRaffle(db, entryFeeChillarStr, endTimeSec) {
  const result = await db.run(
    `INSERT INTO raffles (entry_fee, end_time, status) VALUES (?, ?, 'active')`,
    [entryFeeChillarStr, endTimeSec]
  );
  return result.lastID;
}

export async function getActiveRaffle(db) {
  return await db.get(`SELECT * FROM raffles WHERE status = 'active' LIMIT 1`);
}

export async function addRaffleEntry(db, raffleId, userId) {
  await db.run(
    `INSERT OR IGNORE INTO raffle_entries (raffle_id, telegram_user_id) VALUES (?, ?)`,
    [raffleId, String(userId)]
  );
}

export async function removeRaffleEntry(db, raffleId, userId) {
  await db.run(
    `DELETE FROM raffle_entries WHERE raffle_id = ? AND telegram_user_id = ?`,
    [raffleId, String(userId)]
  );
}

export async function extendRaffleTime(db, raffleId, additionalSecs) {
  await db.run(
    `UPDATE raffles SET end_time = end_time + ? WHERE id = ?`,
    [additionalSecs, raffleId]
  );
}

export async function getRaffleEntries(db, raffleId) {
  const rows = await db.all(
    `SELECT telegram_user_id FROM raffle_entries WHERE raffle_id = ?`,
    [raffleId]
  );
  return rows.map(r => r.telegram_user_id);
}

export async function hasUserJoinedRaffle(db, raffleId, userId) {
  const row = await db.get(
    `SELECT 1 FROM raffle_entries WHERE raffle_id = ? AND telegram_user_id = ? LIMIT 1`,
    [raffleId, String(userId)]
  );
  return !!row;
}

export async function closeRaffle(db, raffleId, winnerId, prizeAmountStr) {
  await db.run(
    `UPDATE raffles SET status = 'closed', winner_id = ?, prize_amount = ? WHERE id = ?`,
    [winnerId, prizeAmountStr, raffleId]
  );
}

export async function cancelRaffle(db, raffleId) {
  await db.run(
    `UPDATE raffles SET status = 'cancelled', winner_id = NULL, prize_amount = NULL WHERE id = ?`,
    [raffleId]
  );
}

export async function getRecentRaffles(db, limit = 5) {
  return await db.all(
    `SELECT * FROM raffles WHERE status = 'closed' ORDER BY id DESC LIMIT ?`,
    [limit]
  );
}

export async function getRaffleById(db, raffleId) {
  return await db.get(`SELECT * FROM raffles WHERE id = ?`, [raffleId]);
}

export async function setRaffleTime(db, raffleId, endTimeSec) {
  await db.run(
    `UPDATE raffles SET end_time = ? WHERE id = ?`,
    [endTimeSec, raffleId]
  );
}

// ─── Wallet migration helpers ─────────────────────────────────────────────────

export async function hasUserMigrated(db, userId) {
  const row = await db.get(
    `SELECT 1 FROM migrated_users WHERE telegram_user_id = ?`,
    [String(userId)]
  );
  return !!row;
}

export async function markUserMigrated(db, userId) {
  await db.run(
    `INSERT OR IGNORE INTO migrated_users (telegram_user_id, migrated_at) VALUES (?, ?)`,
    [String(userId), Math.floor(Date.now() / 1000)]
  );
}
