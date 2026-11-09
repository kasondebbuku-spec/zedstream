import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { config, ROOT } from './config.js';

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
export const db = new DatabaseSync(path.join(ROOT, 'data', 'app.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS movies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  genre TEXT DEFAULT '',
  year INTEGER,
  duration_min INTEGER,
  age_rating TEXT DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  access_days INTEGER NOT NULL DEFAULT 0,
  poster TEXT,
  backdrop TEXT,
  video_path TEXT,
  video_url TEXT,
  trailer_url TEXT,
  series TEXT,
  episode INTEGER,
  featured INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 1,
  views INTEGER NOT NULL DEFAULT 0,
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ratings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  stars INTEGER NOT NULL,
  PRIMARY KEY (user_id, movie_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  movie_id INTEGER REFERENCES movies(id) ON DELETE SET NULL,
  movie_title TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ZMW',
  phone TEXT NOT NULL,
  operator TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_status TEXT,
  provider_message TEXT,
  provider_id TEXT,
  mode TEXT,
  raw TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  payment_id INTEGER REFERENCES payments(id),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  seconds REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, movie_id)
);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, movie_id)
);

CREATE TABLE IF NOT EXISTS view_log (
  movie_id INTEGER NOT NULL,
  viewer TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id, movie_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_view_log ON view_log(movie_id, viewer, created_at);

-- Season pass: one payment unlocks every episode of a series, including future ones.
CREATE TABLE IF NOT EXISTS series_passes (
  series TEXT PRIMARY KEY,
  price REAL NOT NULL,
  access_days INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS series_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series TEXT NOT NULL,
  payment_id INTEGER REFERENCES payments(id),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_series_purchases ON series_purchases(user_id, series);
`);

// Columns added after the first release.
function addColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
addColumn('movies', 'premiere_at', 'TEXT'); // 'YYYY-MM-DD HH:MM:SS' UTC; locked until then
addColumn('payments', 'series', 'TEXT'); // set for season pass payments

/** UTC time `ms` from now, in SQLite's 'YYYY-MM-DD HH:MM:SS' format. */
export function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString().replace('T', ' ').slice(0, 19);
}

// Create the admin account from .env on first run.
if (config.adminEmail && config.adminPassword) {
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(config.adminEmail);
  if (!exists) {
    db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run('Admin', config.adminEmail, bcrypt.hashSync(config.adminPassword, 10), 'admin');
    console.log(`Admin account created: ${config.adminEmail}`);
  }
}

// Demo catalogue so the site isn't empty on first run. Delete these from the admin panel.
const count = db.prepare('SELECT COUNT(*) AS n FROM movies').get().n;
if (count === 0) {
  // Short public sample clips (test-videos.co.uk). Replace with your own uploads.
  const V = 'https://test-videos.co.uk/vids/';
  const BBB = V + 'bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_5MB.mp4';
  const SIN = V + 'sintel/mp4/h264/720/Sintel_720_10s_5MB.mp4';
  const JEL = V + 'jellyfish/mp4/h264/720/Jellyfish_720_10s_5MB.mp4';
  // Made-up placeholder titles. Premiere date is set 5 days after first run.
  const premiere = isoIn(5 * 864e5 + 3 * 36e5);
  const VM = 'Village Matters';
  const demo = [
    ['The Last Move', 'A ruthless game of power, betrayal and loyalty plays out in the heart of Lusaka. Every move has a price.', 'Crime, Drama', 2026, 112, '16', 25, 0, SIN, null, null, 1, 12400, 41, 10, null],
    ['Broken Oath', 'When a young lawyer uncovers corruption in her own firm, she must choose between her career and the truth.', 'Drama, Thriller', 2026, 98, '13', 25, 3, SIN, null, null, 1, 860, 39, 10, null],
    ['The Last Move: Behind the Scenes', 'Meet the cast and crew and see how the film was made.', 'Documentary', 2026, 12, 'PG', 0, 0, JEL, null, null, 0, 310, 46, 10, null],
    [VM, 'Episode 1 – A chief\'s son returns home with a secret that could tear the family apart.', 'Comedy, Drama', 2025, 24, 'PG', 0, 0, BBB, VM, 1, 0, 3900, 40, 10, null],
    [VM, 'Episode 2 – The secret spreads through the market, and nobody is safe.', 'Comedy, Drama', 2025, 24, 'PG', 15, 0, BBB, VM, 2, 0, 640, 42, 10, null],
    [VM, 'Episode 3 – A wedding, a feud and a goat that knows too much.', 'Comedy, Drama', 2025, 24, 'PG', 15, 0, JEL, VM, 3, 0, 520, 43, 10, null],
    [VM, 'Episode 4 – Season finale. The truth finally comes out.', 'Comedy, Drama', 2025, 24, 'PG', 15, 0, SIN, VM, 4, 0, 410, 45, 10, null],
    ['Lost & Found', 'A lost phone. Hundreds of contacts. One very bad day.', 'Comedy', 2025, 88, '13', 0, 0, BBB, null, null, 0, 1250, 37, 10, null],
    ['Kafue Nights', 'Two strangers stranded on the Kafue river after dark discover they share a past.', 'Romance', 2026, 104, '16', 20, 7, JEL, null, null, 0, 950, 40, 10, null],
    ['Copperbelt Gold', 'A mining town heist goes wrong in every possible way.', 'Action, Crime', 2026, 121, '16', 30, 0, SIN, null, null, 1, 3100, 44, 10, null],
    ['Rainy Season', 'A family farm, a failing harvest and one last chance to save everything. The big premiere of the year.', 'Drama', 2026, 109, '13', 30, 0, BBB, null, null, 1, 0, 0, 0, premiere],
  ];
  const ins = db.prepare(`INSERT INTO movies (title, description, genre, year, duration_min, age_rating, price, access_days, video_url, series, episode, featured, views, rating_sum, rating_count, premiere_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const m of demo) ins.run(...m);
  db.prepare('INSERT INTO series_passes (series, price, access_days) VALUES (?, ?, ?)').run(VM, 30, 0);
  console.log('Seeded demo movies.');
}

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
