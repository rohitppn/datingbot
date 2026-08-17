import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'bot.db'));
db.pragma('journal_mode = WAL');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    phone TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    payment_id TEXT,
    paid_at INTEGER,
    expires_at INTEGER,
    profile_json TEXT DEFAULT '{}',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_conv_phone_time
    ON conversations(phone, created_at DESC);

  CREATE TABLE IF NOT EXISTS daily_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    date TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(phone, date)
  );

  -- Free-trial counter for unpaid users (legacy: per-message free cap).
  CREATE TABLE IF NOT EXISTS free_usage (
    phone TEXT PRIMARY KEY,
    used INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );

  -- Time-based free trial: records when an unpaid user first messaged the bot.
  -- They get free coaching for FREE_TRIAL_DAYS from started_at, then pay.
  CREATE TABLE IF NOT EXISTS free_trials (
    phone TEXT PRIMARY KEY,
    started_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// Normalize phone: strip +, spaces, leading zeros
export function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[^0-9]/g, '');
  // Strip WhatsApp suffix if present
  p = p.split('@')[0];
  // Add country code if 10 digits (assume India)
  if (p.length === 10) p = '91' + p;
  return p;
}

// User queries
export function upsertUser({ phone, name, email, payment_id, amount_days = 30 }) {
  const normalized = normalizePhone(phone);
  const now = Math.floor(Date.now() / 1000);
  const expires = now + amount_days * 24 * 60 * 60;

  const stmt = db.prepare(`
    INSERT INTO users (phone, name, email, payment_id, paid_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      payment_id = excluded.payment_id,
      paid_at = excluded.paid_at,
      expires_at = MAX(users.expires_at, excluded.expires_at),
      name = COALESCE(excluded.name, users.name),
      email = COALESCE(excluded.email, users.email)
  `);
  stmt.run(normalized, name, email, payment_id, now, expires);
  return getUser(normalized);
}

export function getUser(phone) {
  const normalized = normalizePhone(phone);
  return db.prepare('SELECT * FROM users WHERE phone = ?').get(normalized);
}

export function isPaidActive(phone) {
  const user = getUser(phone);
  if (!user) return false;
  const now = Math.floor(Date.now() / 1000);
  return user.expires_at > now;
}

export function updateUserProfile(phone, profileObj) {
  const normalized = normalizePhone(phone);
  db.prepare('UPDATE users SET profile_json = ? WHERE phone = ?')
    .run(JSON.stringify(profileObj), normalized);
}

// Conversation queries
export function saveMessage(phone, role, content) {
  const normalized = normalizePhone(phone);
  db.prepare('INSERT INTO conversations (phone, role, content) VALUES (?, ?, ?)')
    .run(normalized, role, content);
}

export function getRecentMessages(phone, limit = 20) {
  const normalized = normalizePhone(phone);
  const rows = db.prepare(`
    SELECT role, content, created_at FROM conversations
    WHERE phone = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(normalized, limit);
  return rows.reverse(); // chronological order
}

export function getMessagesForDate(phone, dateStr) {
  const normalized = normalizePhone(phone);
  const start = Math.floor(new Date(dateStr + 'T00:00:00').getTime() / 1000);
  const end = start + 24 * 60 * 60;
  return db.prepare(`
    SELECT role, content FROM conversations
    WHERE phone = ? AND created_at >= ? AND created_at < ?
    ORDER BY created_at ASC
  `).all(normalized, start, end);
}

// Summary queries
export function saveDailySummary(phone, date, summary) {
  const normalized = normalizePhone(phone);
  db.prepare(`
    INSERT INTO daily_summaries (phone, date, summary)
    VALUES (?, ?, ?)
    ON CONFLICT(phone, date) DO UPDATE SET summary = excluded.summary
  `).run(normalized, date, summary);
}

export function getRecentSummaries(phone, days = 7) {
  const normalized = normalizePhone(phone);
  return db.prepare(`
    SELECT date, summary FROM daily_summaries
    WHERE phone = ?
    ORDER BY date DESC
    LIMIT ?
  `).all(normalized, days).reverse();
}

// Free-trial usage (unpaid users get a few free replies before the payment gate)
export function getFreeUsage(phone) {
  const normalized = normalizePhone(phone);
  const row = db.prepare('SELECT used FROM free_usage WHERE phone = ?').get(normalized);
  return row ? row.used : 0;
}

export function incrementFreeUsage(phone) {
  const normalized = normalizePhone(phone);
  db.prepare(`
    INSERT INTO free_usage (phone, used, updated_at)
    VALUES (?, 1, strftime('%s','now'))
    ON CONFLICT(phone) DO UPDATE SET
      used = free_usage.used + 1,
      updated_at = strftime('%s','now')
  `).run(normalized);
  return getFreeUsage(normalized);
}

// Time-based free trial: returns the unix ts the user first messaged, or null.
export function getTrialStart(phone) {
  const normalized = normalizePhone(phone);
  const row = db.prepare('SELECT started_at FROM free_trials WHERE phone = ?').get(normalized);
  return row ? row.started_at : null;
}

// Records the trial start on first contact (no-op if already started).
// Always returns the (existing or new) start timestamp.
export function startTrial(phone) {
  const normalized = normalizePhone(phone);
  db.prepare(`
    INSERT OR IGNORE INTO free_trials (phone, started_at)
    VALUES (?, strftime('%s','now'))
  `).run(normalized);
  return getTrialStart(normalized);
}

// Cleanup: delete messages older than N days
export function cleanupOldMessages(days = 30) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const result = db.prepare('DELETE FROM conversations WHERE created_at < ?').run(cutoff);
  return result.changes;
}

// Get all active users (for batch jobs)
export function getActiveUsers() {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare('SELECT * FROM users WHERE expires_at > ?').all(now);
}

export default db;
