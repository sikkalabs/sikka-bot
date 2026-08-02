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
      prize_amount TEXT,
      closed_at    INTEGER,
      created_at   INTEGER
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

    -- One row per rain; single active rain enforced in code via getActiveRain
    CREATE TABLE IF NOT EXISTS rains (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      total_amount TEXT    NOT NULL,
      persons      INTEGER NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'active',
      starter_id   TEXT    NOT NULL,
      started_at   INTEGER NOT NULL,
      closed_at    INTEGER
    );
    -- getActiveRain runs every 5 s — index keeps it O(log n)
    CREATE INDEX IF NOT EXISTS idx_rains_status ON rains(status);

    -- One drop per user per rain (PK prevents double-claim)
    CREATE TABLE IF NOT EXISTS rain_claims (
      rain_id          INTEGER NOT NULL,
      telegram_user_id TEXT    NOT NULL,
      share            TEXT    NOT NULL,
      tx_id            TEXT,
      claimed_at       INTEGER NOT NULL,
      PRIMARY KEY (rain_id, telegram_user_id)
    );
  `);

  // Migrate existing DBs that predate the closed_at column — safe no-op on fresh DBs
  try {
    await db.exec(`ALTER TABLE raffles ADD COLUMN closed_at INTEGER;`);
  } catch (_) { /* column already exists — ignore */ }

  // Migrate existing DBs that predate the created_at column — safe no-op on fresh DBs
  try {
    await db.exec(`ALTER TABLE raffles ADD COLUMN created_at INTEGER;`);
  } catch (_) { /* column already exists — ignore */ }

  return db;
}

// ─── Claim cooldown ───────────────────────────────────────────────────────────

const CLAIM_COOLDOWN_MS = 5 * 60 * 60 * 1000;

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

// ─── Raffle-start global cooldown (10 min after last raffle ended) ─────────────

const RAFFLE_GLOBAL_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

export async function canStartRaffle(db) {
  const row = await db.get(
    `SELECT closed_at FROM raffles
     WHERE status IN ('closed', 'cancelled') AND closed_at IS NOT NULL
     ORDER BY closed_at DESC LIMIT 1`
  );
  if (!row) return { ok: true, remaining: 0 };
  const remaining = (row.closed_at * 1000 + RAFFLE_GLOBAL_COOLDOWN_MS) - Date.now();
  if (remaining <= 0) return { ok: true, remaining: 0 };
  return { ok: false, remaining };
}

// ─── Raffle CRUD ──────────────────────────────────────────────────────────────

export async function createRaffle(db, entryFeeChillarStr, endTimeSec) {
  const result = await db.run(
    `INSERT INTO raffles (entry_fee, end_time, status, created_at) VALUES (?, ?, 'active', ?)`,
    [entryFeeChillarStr, endTimeSec, Math.floor(Date.now() / 1000)]
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
    `UPDATE raffles SET status = 'closed', winner_id = ?, prize_amount = ?, closed_at = ? WHERE id = ?`,
    [winnerId, prizeAmountStr, Math.floor(Date.now() / 1000), raffleId]
  );
}

export async function cancelRaffle(db, raffleId) {
  await db.run(
    `UPDATE raffles SET status = 'cancelled', winner_id = NULL, prize_amount = NULL, closed_at = ? WHERE id = ?`,
    [Math.floor(Date.now() / 1000), raffleId]
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

// ─── Rain CRUD ───────────────────────────────────────────────────────────────

export async function createRain(db, totalAmountStr, persons, starterId) {
  const result = await db.run(
    `INSERT INTO rains (total_amount, persons, status, starter_id, started_at) VALUES (?, ?, 'active', ?, ?)`,
    [totalAmountStr, persons, String(starterId), Math.floor(Date.now() / 1000)]
  );
  return result.lastID;
}

export async function getActiveRain(db) {
  return await db.get(`SELECT * FROM rains WHERE status = 'active' LIMIT 1`);
}

export async function hasUserClaimedRain(db, rainId, userId) {
  const row = await db.get(
    `SELECT 1 FROM rain_claims WHERE rain_id = ? AND telegram_user_id = ? LIMIT 1`,
    [rainId, String(userId)]
  );
  return !!row;
}

export async function addRainClaim(db, rainId, userId, shareStr, txId) {
  await db.run(
    `INSERT INTO rain_claims (rain_id, telegram_user_id, share, tx_id, claimed_at) VALUES (?, ?, ?, ?, ?)`,
    [rainId, String(userId), shareStr, txId, Math.floor(Date.now() / 1000)]
  );
}

export async function addRainClaimTx(db, rainId, userId, txId) {
  await db.run(
    `UPDATE rain_claims SET tx_id = ? WHERE rain_id = ? AND telegram_user_id = ?`,
    [txId, rainId, String(userId)]
  );
}

export async function removeRainClaim(db, rainId, userId) {
  await db.run(
    `DELETE FROM rain_claims WHERE rain_id = ? AND telegram_user_id = ?`,
    [rainId, String(userId)]
  );
}

export async function getRainClaims(db, rainId) {
  return await db.all(
    `SELECT * FROM rain_claims WHERE rain_id = ? ORDER BY claimed_at ASC`,
    [rainId]
  );
}

export async function closeRain(db, rainId) {
  await db.run(
    `UPDATE rains SET status = 'closed', closed_at = ? WHERE id = ?`,
    [Math.floor(Date.now() / 1000), rainId]
  );
}

export async function cancelRain(db, rainId) {
  await db.run(
    `UPDATE rains SET status = 'cancelled', closed_at = ? WHERE id = ?`,
    [Math.floor(Date.now() / 1000), rainId]
  );
}

