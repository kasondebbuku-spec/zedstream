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
`);

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
  const demo = [
    ['The Pawn', 'A ruthless game of power, betrayal and loyalty plays out in the heart of Lusaka. Every move has a price.', 'Crime, Drama', 2026, 112, '16', 25, 0, SIN, null, null, 1, 17700, 35, 10],
    ['Contravene', 'When a young lawyer uncovers corruption in her own firm, she must choose between her career and the truth.', 'Drama, Thriller', 2026, 98, '13', 25, 3, SIN, null, null, 1, 472, 38, 10],
    ['The Pawn - Behind the Scenes', 'Exclusive look at the cast and crew making The Pawn.', 'Documentary', 2026, 12, 'PG', 0, 0, JEL, null, null, 0, 160, 45, 10],
    ['Mwamba Wakulubemba', 'Episode 1 – A village chief\'s son returns home with a secret that could tear the family apart.', 'Comedy, Drama', 2025, 24, 'PG', 0, 0, BBB, 'Mwamba Wakulubemba', 1, 0, 2200, 34, 10],
    ['Mwamba Wakulubemba', 'Episode 2 – The secret spreads through the market, and nobody is safe.', 'Comedy, Drama', 2025, 24, 'PG', 0, 0, BBB, 'Mwamba Wakulubemba', 2, 0, 208, 37, 10],
    ['Mwamba Wakulubemba', 'Episode 3 – A wedding, a feud and a goat that knows too much.', 'Comedy, Drama', 2025, 24, 'PG', 0, 0, JEL, 'Mwamba Wakulubemba', 3, 0, 174, 41, 10],
    ['Mwamba Wakulubemba', 'Episode 4 – Season finale. The truth finally comes out.', 'Comedy, Drama', 2025, 24, 'PG', 15, 2, SIN, 'Mwamba Wakulubemba', 4, 0, 72, 42, 10],
    ['Phone Book', 'A lost phone. Hundreds of contacts. One very bad day.', 'Comedy', 2025, 88, '13', 0, 0, BBB, null, null, 0, 186, 34, 10],
    ['Kafue Nights', 'Two strangers stranded on the Kafue river after dark discover they share a past.', 'Romance', 2026, 104, '16', 20, 7, JEL, null, null, 0, 950, 40, 10],
    ['Copperbelt Gold', 'A mining town heist goes wrong in every possible way.', 'Action, Crime', 2026, 121, '16', 30, 0, SIN, null, null, 1, 3100, 44, 10],
  ];
  const ins = db.prepare(`INSERT INTO movies (title, description, genre, year, duration_min, age_rating, price, access_days, video_url, series, episode, featured, views, rating_sum, rating_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const m of demo) ins.run(...m);
  console.log('Seeded demo movies.');
}

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
