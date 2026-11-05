import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config, ROOT } from './config.js';
import { db, tx } from './db.js';
import * as lipila from './lipila.js';

const app = express();
app.set('trust proxy', 1);

const IMG_DIR = path.join(ROOT, 'uploads', 'images');
const VIDEO_DIR = path.join(ROOT, 'storage', 'videos'); // never served statically
fs.mkdirSync(IMG_DIR, { recursive: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      mediaSrc: ["'self'", 'blob:', 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cookieParser());

// ---------- Webhook (needs the raw body for signature checks, so it goes before express.json) ----------
app.post('/api/webhooks/lipila', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = req.body?.toString('utf8') || '';
  if (!lipila.verifyWebhook(req.headers, raw)) return res.status(401).json({ error: 'Bad signature' });
  let payload;
  try { payload = JSON.parse(raw); } catch { return res.status(400).json({ error: 'Bad JSON' }); }
  const data = payload.data || payload;
  const ref = data.referenceId || data.reference_id || data.externalId;
  const payment = ref && db.prepare('SELECT * FROM payments WHERE reference_id = ?').get(ref);
  if (!payment) return res.status(200).json({ ok: true, ignored: true });
  try {
    // Never trust the callback body alone: confirm with Lipila before unlocking.
    const confirmed = lipila.lipilaMode() === 'mock' ? data : await lipila.checkCollection(ref);
    applyPaymentResult(payment, confirmed);
  } catch (e) {
    console.error('Webhook re-check failed:', e.message);
  }
  res.json({ ok: true });
});

app.use(express.json({ limit: '1mb' }));

// ---------- Helpers ----------
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip + req.path;
    const t = Date.now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    arr.push(t);
    hits.set(key, arr);
    if (arr.length > max) return res.status(429).json({ error: 'Too many attempts. Please wait a moment.' });
    next();
  };
}

function signIn(res, user) {
  const token = jwt.sign({ uid: user.id }, config.jwtSecret, { expiresIn: '30d' });
  res.cookie('token', token, {
    httpOnly: true, sameSite: 'lax', secure: config.publicUrl.startsWith('https'), maxAge: 30 * 864e5,
  });
}

app.use((req, _res, next) => {
  const t = req.cookies.token;
  if (t) {
    try {
      const { uid } = jwt.verify(t, config.jwtSecret);
      req.user = db.prepare('SELECT id, name, email, phone, role FROM users WHERE id = ?').get(uid) || null;
    } catch { /* expired or invalid */ }
  }
  next();
});

const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in first.' }));
const requireAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only.' }));

function activePurchase(userId, movieId) {
  return db.prepare(`SELECT * FROM purchases WHERE user_id = ? AND movie_id = ?
    AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC LIMIT 1`).get(userId, movieId, now());
}

function hasAccess(user, movie) {
  if (!movie) return false;
  if (movie.price <= 0) return true;
  if (!user) return false;
  if (user.role === 'admin') return true;
  return !!activePurchase(user.id, movie.id);
}

function publicMovie(m) {
  return {
    id: m.id,
    title: m.title,
    description: m.description,
    genre: m.genre,
    genres: (m.genre || '').split(',').map((g) => g.trim()).filter(Boolean),
    year: m.year,
    durationMin: m.duration_min,
    ageRating: m.age_rating,
    price: m.price,
    accessDays: m.access_days,
    poster: m.poster ? `/uploads/images/${m.poster}` : `/api/art/${m.id}.svg?kind=poster`,
    backdrop: m.backdrop ? `/uploads/images/${m.backdrop}` : (m.poster ? `/uploads/images/${m.poster}` : `/api/art/${m.id}.svg?kind=backdrop`),
    trailerUrl: m.trailer_url || null,
    series: m.series,
    episode: m.episode,
    featured: !!m.featured,
    published: !!m.published,
    views: m.views,
    rating: m.rating_count ? Math.round((m.rating_sum / m.rating_count) * 10) / 10 : 0,
    ratingCount: m.rating_count,
    createdAt: m.created_at,
    hasVideo: !!(m.video_path || m.video_url),
  };
}

// ---------- Config ----------
app.get('/api/config', (_req, res) => {
  res.json({ siteName: config.siteName, currency: config.currency, paymentMode: lipila.lipilaMode() });
});

// ---------- Auth ----------
const authLimiter = rateLimit({ windowMs: 15 * 60e3, max: 20 });

app.post('/api/auth/register', authLimiter, (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name?.trim() || !email?.trim() || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const msisdn = phone ? lipila.normalizePhone(phone) : null;
  if (phone && !msisdn) return res.status(400).json({ error: 'Enter a valid Zambian mobile number, e.g. 0977123456.' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim())) return res.status(409).json({ error: 'An account with that email already exists.' });
  const r = db.prepare('INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)')
    .run(name.trim(), email.trim(), msisdn, bcrypt.hashSync(password, 10));
  const user = db.prepare('SELECT id, name, email, phone, role FROM users WHERE id = ?').get(r.lastInsertRowid);
  signIn(res, user);
  res.json({ user });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) return res.status(401).json({ error: 'Wrong email or password.' });
  signIn(res, u);
  res.json({ user: { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role } });
});

app.post('/api/auth/logout', (_req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => res.json({ user: req.user || null }));

// ---------- Catalogue ----------
app.get('/api/movies', (req, res) => {
  const { q, sort = 'latest', genre, price } = req.query;
  const where = ['published = 1'];
  const args = [];
  if (q) { where.push('(title LIKE ? OR description LIKE ? OR genre LIKE ? OR series LIKE ?)'); const s = `%${q}%`; args.push(s, s, s, s); }
  if (genre) { where.push('genre LIKE ?'); args.push(`%${genre}%`); }
  if (price === 'free') where.push('price <= 0');
  if (price === 'paid') where.push('price > 0');
  const order = {
    latest: 'created_at DESC, id DESC',
    popular: 'views DESC',
    rating: '(CASE WHEN rating_count > 0 THEN rating_sum * 1.0 / rating_count ELSE 0 END) DESC',
    az: 'title COLLATE NOCASE ASC, episode ASC',
    oldest: 'created_at ASC, id ASC',
  }[sort] || 'created_at DESC, id DESC';
  const rows = db.prepare(`SELECT * FROM movies WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...args);
  res.json({ movies: rows.map(publicMovie) });
});

app.get('/api/genres', (_req, res) => {
  const set = new Set();
  for (const { genre } of db.prepare('SELECT genre FROM movies WHERE published = 1').all()) {
    (genre || '').split(',').map((g) => g.trim()).filter(Boolean).forEach((g) => set.add(g));
  }
  res.json({ genres: [...set].sort() });
});

app.get('/api/movies/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM movies WHERE id = ?').get(req.params.id);
  if (!m || (!m.published && req.user?.role !== 'admin')) return res.status(404).json({ error: 'Movie not found.' });
  const access = hasAccess(req.user, m);
  const purchase = req.user ? activePurchase(req.user.id, m.id) : null;
  const episodes = m.series
    ? db.prepare('SELECT * FROM movies WHERE series = ? AND published = 1 ORDER BY episode, id').all(m.series).map(publicMovie)
    : [];
  const firstGenre = (m.genre || '').split(',')[0]?.trim();
  const related = db.prepare(`SELECT * FROM movies WHERE id != ? AND published = 1 AND (genre LIKE ? OR series IS NULL)
    ORDER BY views DESC LIMIT 12`).all(m.id, `%${firstGenre || ''}%`)
    .filter((r) => !m.series || r.series !== m.series).map(publicMovie);
  const extra = {};
  if (req.user) {
    extra.userRating = db.prepare('SELECT stars FROM ratings WHERE user_id = ? AND movie_id = ?').get(req.user.id, m.id)?.stars || 0;
    extra.progress = db.prepare('SELECT seconds, duration FROM progress WHERE user_id = ? AND movie_id = ?').get(req.user.id, m.id) || null;
    extra.inWatchlist = !!db.prepare('SELECT 1 FROM watchlist WHERE user_id = ? AND movie_id = ?').get(req.user.id, m.id);
  }
  res.json({
    movie: publicMovie(m),
    hasAccess: access,
    accessExpiresAt: purchase?.expires_at || null,
    episodes,
    related,
    ...extra,
  });
});

app.post('/api/movies/:id/rate', requireAuth, (req, res) => {
  const stars = Math.round(Number(req.body?.stars));
  if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'Stars must be 1-5.' });
  const m = db.prepare('SELECT id FROM movies WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Movie not found.' });
  tx(() => {
    const prev = db.prepare('SELECT stars FROM ratings WHERE user_id = ? AND movie_id = ?').get(req.user.id, m.id);
    if (prev) {
      db.prepare('UPDATE ratings SET stars = ? WHERE user_id = ? AND movie_id = ?').run(stars, req.user.id, m.id);
      db.prepare('UPDATE movies SET rating_sum = rating_sum + ? WHERE id = ?').run(stars - prev.stars, m.id);
    } else {
      db.prepare('INSERT INTO ratings (user_id, movie_id, stars) VALUES (?, ?, ?)').run(req.user.id, m.id, stars);
      db.prepare('UPDATE movies SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE id = ?').run(stars, m.id);
    }
  });
  const u = db.prepare('SELECT rating_sum, rating_count FROM movies WHERE id = ?').get(m.id);
  res.json({ rating: Math.round((u.rating_sum / u.rating_count) * 10) / 10, ratingCount: u.rating_count, userRating: stars });
});

app.post('/api/movies/:id/view', (req, res) => {
  const m = db.prepare('SELECT * FROM movies WHERE id = ?').get(req.params.id);
  if (!m || !hasAccess(req.user, m)) return res.json({ ok: false });
  const viewer = req.user ? `u${req.user.id}` : `ip${req.ip}`;
  const recent = db.prepare(`SELECT 1 FROM view_log WHERE movie_id = ? AND viewer = ? AND created_at > datetime('now', '-6 hours')`).get(m.id, viewer);
  if (!recent) {
    db.prepare('INSERT INTO view_log (movie_id, viewer) VALUES (?, ?)').run(m.id, viewer);
    db.prepare('UPDATE movies SET views = views + 1 WHERE id = ?').run(m.id);
  }
  res.json({ ok: true });
});

app.post('/api/movies/:id/progress', requireAuth, (req, res) => {
  const seconds = Number(req.body?.seconds) || 0;
  const duration = Number(req.body?.duration) || 0;
  db.prepare(`INSERT INTO progress (user_id, movie_id, seconds, duration, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, movie_id) DO UPDATE SET seconds = excluded.seconds, duration = excluded.duration, updated_at = excluded.updated_at`)
    .run(req.user.id, Number(req.params.id), seconds, duration);
  res.json({ ok: true });
});

app.post('/api/movies/:id/watchlist', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT 1 FROM watchlist WHERE user_id = ? AND movie_id = ?').get(req.user.id, id);
  if (exists) db.prepare('DELETE FROM watchlist WHERE user_id = ? AND movie_id = ?').run(req.user.id, id);
  else db.prepare('INSERT INTO watchlist (user_id, movie_id) VALUES (?, ?)').run(req.user.id, id);
  res.json({ inWatchlist: !exists });
});

app.get('/api/me/library', requireAuth, (req, res) => {
  const uid = req.user.id;
  const cont = db.prepare(`SELECT m.*, p.seconds, p.duration FROM progress p JOIN movies m ON m.id = p.movie_id
    WHERE p.user_id = ? AND p.seconds > 10 AND (p.duration = 0 OR p.seconds < p.duration * 0.95) AND m.published = 1
    ORDER BY p.updated_at DESC LIMIT 20`).all(uid)
    .map((r) => ({ ...publicMovie(r), progress: r.duration ? r.seconds / r.duration : 0 }));
  const purchases = db.prepare(`SELECT m.*, pu.expires_at, pu.created_at AS bought_at FROM purchases pu JOIN movies m ON m.id = pu.movie_id
    WHERE pu.user_id = ? ORDER BY pu.id DESC`).all(uid)
    .map((r) => ({ ...publicMovie(r), expiresAt: r.expires_at, boughtAt: r.bought_at, active: !r.expires_at || r.expires_at > now() }));
  const watchlist = db.prepare(`SELECT m.* FROM watchlist w JOIN movies m ON m.id = w.movie_id WHERE w.user_id = ? AND m.published = 1
    ORDER BY w.created_at DESC`).all(uid).map(publicMovie);
  const payments = db.prepare(`SELECT reference_id, movie_id, movie_title, amount, currency, phone, operator, status, provider_message, created_at
    FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 50`).all(uid);
  res.json({ continueWatching: cont, purchases, watchlist, payments });
});

// ---------- Generated artwork for movies without uploaded posters ----------
app.get('/api/art/:id.svg', (req, res) => {
  const m = db.prepare('SELECT title, series, episode, genre FROM movies WHERE id = ?').get(req.params.id);
  const title = m?.series || m?.title || 'Untitled';
  const h = [...title].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const h1 = h % 360, h2 = (h1 + 40 + (h % 80)) % 360;
  const backdrop = req.query.kind === 'backdrop';
  const [w, ht] = backdrop ? [1280, 720] : [400, 600];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const words = title.toUpperCase().split(' ');
  const lines = [];
  for (const wd of words) {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + wd).length <= (backdrop ? 22 : 12)) lines[lines.length - 1] = last + ' ' + wd; else lines.push(wd);
  }
  const fs1 = backdrop ? 72 : 46;
  const startY = ht / 2 - ((lines.length - 1) * fs1 * 1.1) / 2;
  const text = lines.map((l, i) => `<text x="${w / 2}" y="${startY + i * fs1 * 1.1}" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="${fs1}" fill="#fff" fill-opacity=".95">${esc(l)}</text>`).join('');
  const sub = m?.episode ? `EPISODE ${m.episode}` : (m?.genre || '').split(',')[0].toUpperCase();
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1},70%,32%)"/><stop offset="1" stop-color="hsl(${h2},75%,12%)"/></linearGradient>
<radialGradient id="r" cx=".3" cy=".25" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".25"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#r)"/>
<circle cx="${w * 0.82}" cy="${ht * 0.18}" r="${w * 0.22}" fill="hsl(${h2},80%,55%)" fill-opacity=".18"/>
${backdrop ? `<circle cx="${w * 0.65}" cy="${ht * 0.75}" r="${w * 0.3}" fill="hsl(${h1},80%,50%)" fill-opacity=".12"/>` : `${text}
<text x="${w / 2}" y="${startY + lines.length * fs1 * 1.1 + 10}" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" letter-spacing="6" fill="#fff" fill-opacity=".75">${esc(sub)}</text>`}
</svg>`);
});

// ---------- Protected streaming ----------
app.get('/api/stream/:id', asyncH(async (req, res) => {
  const m = db.prepare('SELECT * FROM movies WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).end();
  if (!hasAccess(req.user, m)) return res.status(402).json({ error: 'Payment required to watch this movie.' });
  res.set('Cache-Control', 'private, no-store');

  if (m.video_path) {
    const file = path.join(VIDEO_DIR, path.basename(m.video_path));
    if (!fs.existsSync(file)) return res.status(404).end();
    const size = fs.statSync(file).size;
    const ext = path.extname(file).toLowerCase();
    const type = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.m4v': 'video/mp4' }[ext] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const [s, e] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(s, 10) || 0;
      const end = e ? Math.min(parseInt(e, 10), size - 1) : Math.min(start + 4 * 1024 * 1024 - 1, size - 1);
      if (start >= size) return res.status(416).set('Content-Range', `bytes */${size}`).end();
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': type });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': size, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
    }
    return;
  }

  if (m.video_url) {
    // Proxy remote video so the real URL is never exposed to the browser.
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    const upstream = await fetch(m.video_url, { headers: req.headers.range ? { Range: req.headers.range } : {}, signal: ac.signal });
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
    return;
  }
  res.status(404).json({ error: 'No video uploaded for this title yet.' });
}));

// ---------- Payments (Lipila mobile money) ----------
function applyPaymentResult(payment, data) {
  const status = lipila.normalizeStatus(data?.status);
  const message = data?.message || data?.statusMessage || null;
  if (status === 'successful') {
    tx(() => {
      // Only the first successful update creates the purchase (webhook + polling can race).
      const r = db.prepare(`UPDATE payments SET status = 'successful', provider_status = ?, provider_message = ?, provider_id = COALESCE(?, provider_id),
        raw = ?, updated_at = datetime('now') WHERE id = ? AND status != 'successful'`)
        .run(String(data.status), message, data.identifier || null, JSON.stringify(data), payment.id);
      if (r.changes && payment.movie_id) {
        const movie = db.prepare('SELECT access_days FROM movies WHERE id = ?').get(payment.movie_id);
        const expires = movie?.access_days > 0 ? new Date(Date.now() + movie.access_days * 864e5).toISOString().replace('T', ' ').slice(0, 19) : null;
        db.prepare('INSERT INTO purchases (user_id, movie_id, payment_id, expires_at) VALUES (?, ?, ?, ?)').run(payment.user_id, payment.movie_id, payment.id, expires);
      }
    });
  } else if (status === 'failed') {
    db.prepare(`UPDATE payments SET status = 'failed', provider_status = ?, provider_message = ?, raw = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'`).run(String(data.status), message, JSON.stringify(data), payment.id);
  } else if (message) {
    db.prepare(`UPDATE payments SET provider_status = ?, provider_message = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'`)
      .run(String(data?.status || 'Pending'), message, payment.id);
  }
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
}

const payLimiter = rateLimit({ windowMs: 10 * 60e3, max: 10 });

app.post('/api/payments', requireAuth, payLimiter, asyncH(async (req, res) => {
  const movie = db.prepare('SELECT * FROM movies WHERE id = ? AND published = 1').get(req.body?.movieId);
  if (!movie) return res.status(404).json({ error: 'Movie not found.' });
  if (movie.price <= 0) return res.status(400).json({ error: 'This movie is free.' });
  if (hasAccess(req.user, movie)) return res.status(409).json({ error: 'You already have access to this movie.' });
  const phone = lipila.normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid MTN, Airtel or Zamtel number, e.g. 0977123456.' });

  // Re-use a payment that is still waiting for the PIN instead of sending a second prompt.
  const pending = db.prepare(`SELECT * FROM payments WHERE user_id = ? AND movie_id = ? AND phone = ? AND status = 'pending'
    AND created_at > datetime('now', '-2 minutes') ORDER BY id DESC LIMIT 1`).get(req.user.id, movie.id, phone);
  if (pending) return res.json({ referenceId: pending.reference_id, status: 'pending', message: 'Check your phone to approve the payment.' });

  const referenceId = `ZS${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const operator = lipila.detectOperator(phone);
  const ins = db.prepare(`INSERT INTO payments (reference_id, user_id, movie_id, movie_title, amount, currency, phone, operator, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(referenceId, req.user.id, movie.id, movie.title, movie.price, config.currency, phone, operator, lipila.lipilaMode());
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(ins.lastInsertRowid);

  if (!req.user.phone) db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, req.user.id);

  try {
    const result = await lipila.createCollection({
      referenceId,
      amount: movie.price,
      phone,
      narration: `${config.siteName}: ${movie.title}`.slice(0, 60),
      email: req.user.email,
    });
    const updated = applyPaymentResult(payment, result);
    res.json({ referenceId, status: updated.status, message: updated.provider_message || 'Check your phone and enter your PIN to approve.' });
  } catch (e) {
    console.error('Lipila collection failed:', e.message, e.data || '');
    db.prepare(`UPDATE payments SET status = 'failed', provider_message = ?, updated_at = datetime('now') WHERE id = ?`).run(e.message, payment.id);
    res.status(502).json({ error: `Payment could not be started: ${e.message}`, referenceId });
  }
}));

app.get('/api/payments/:ref', requireAuth, asyncH(async (req, res) => {
  let p = db.prepare('SELECT * FROM payments WHERE reference_id = ?').get(req.params.ref);
  if (!p || (p.user_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).json({ error: 'Payment not found.' });
  if (p.status === 'pending') {
    try { p = applyPaymentResult(p, await lipila.checkCollection(p.reference_id)); }
    catch (e) { console.warn('Status check failed:', e.message); }
  }
  res.json({ referenceId: p.reference_id, status: p.status, message: p.provider_message, amount: p.amount, movieId: p.movie_id });
}));

// Background check for payments where the webhook never arrived.
setInterval(async () => {
  db.prepare(`UPDATE payments SET status = 'failed', provider_message = 'Timed out waiting for approval', updated_at = datetime('now')
    WHERE status = 'pending' AND created_at < datetime('now', '-30 minutes')`).run();
  const pending = db.prepare(`SELECT * FROM payments WHERE status = 'pending' AND created_at < datetime('now', '-20 seconds')`).all();
  for (const p of pending) {
    try { applyPaymentResult(p, await lipila.checkCollection(p.reference_id)); } catch { /* try again next round */ }
  }
}, 30e3).unref();

// ---------- Admin ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, file, cb) => cb(null, file.fieldname === 'video' ? VIDEO_DIR : IMG_DIR),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 8 * 1024 ** 3 },
  fileFilter: (_req, file, cb) => {
    const ok = file.fieldname === 'video' ? /^video\//.test(file.mimetype) : /^image\//.test(file.mimetype);
    cb(ok ? null : new Error(`Wrong file type for ${file.fieldname}.`), ok);
  },
}).fields([{ name: 'poster', maxCount: 1 }, { name: 'backdrop', maxCount: 1 }, { name: 'video', maxCount: 1 }]);

function removeFile(dir, name) {
  if (name) fs.rm(path.join(dir, path.basename(name)), { force: true }, () => {});
}

function movieFields(body) {
  const num = (v, d = null) => (v === undefined || v === '' ? d : Number(v));
  return {
    title: String(body.title || '').trim(),
    description: body.description || '',
    genre: body.genre || '',
    year: num(body.year),
    duration_min: num(body.durationMin),
    age_rating: body.ageRating || '',
    price: Math.max(0, num(body.price, 0)),
    access_days: Math.max(0, num(body.accessDays, 0)),
    video_url: body.videoUrl?.trim() || null,
    trailer_url: body.trailerUrl?.trim() || null,
    series: body.series?.trim() || null,
    episode: num(body.episode),
    featured: body.featured === 'true' || body.featured === '1' || body.featured === 'on' ? 1 : 0,
    published: body.published === 'false' || body.published === '0' ? 0 : 1,
  };
}

app.get('/api/admin/movies', requireAuth, requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT * FROM movies ORDER BY id DESC').all();
  const revenue = Object.fromEntries(db.prepare(`SELECT movie_id, SUM(amount) AS total, COUNT(*) AS n FROM payments WHERE status = 'successful' GROUP BY movie_id`).all()
    .map((r) => [r.movie_id, r]));
  res.json({ movies: rows.map((m) => ({ ...publicMovie(m), videoUrl: m.video_url, videoFile: m.video_path, revenue: revenue[m.id]?.total || 0, sales: revenue[m.id]?.n || 0 })) });
});

app.post('/api/admin/movies', requireAuth, requireAdmin, upload, (req, res) => {
  const f = movieFields(req.body);
  if (!f.title) return res.status(400).json({ error: 'Title is required.' });
  const files = req.files || {};
  const r = db.prepare(`INSERT INTO movies (title, description, genre, year, duration_min, age_rating, price, access_days, video_url, trailer_url,
    series, episode, featured, published, poster, backdrop, video_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(f.title, f.description, f.genre, f.year, f.duration_min, f.age_rating, f.price, f.access_days, f.video_url, f.trailer_url,
      f.series, f.episode, f.featured, f.published, files.poster?.[0]?.filename || null, files.backdrop?.[0]?.filename || null, files.video?.[0]?.filename || null);
  res.json({ movie: publicMovie(db.prepare('SELECT * FROM movies WHERE id = ?').get(r.lastInsertRowid)) });
});

app.put('/api/admin/movies/:id', requireAuth, requireAdmin, upload, (req, res) => {
  const m = db.prepare('SELECT * FROM movies WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Movie not found.' });
  const f = movieFields(req.body);
  if (!f.title) return res.status(400).json({ error: 'Title is required.' });
  const files = req.files || {};
  const poster = files.poster?.[0]?.filename || (req.body.removePoster === '1' ? null : m.poster);
  const backdrop = files.backdrop?.[0]?.filename || (req.body.removeBackdrop === '1' ? null : m.backdrop);
  const video = files.video?.[0]?.filename || (req.body.removeVideo === '1' ? null : m.video_path);
  if (poster !== m.poster) removeFile(IMG_DIR, m.poster);
  if (backdrop !== m.backdrop) removeFile(IMG_DIR, m.backdrop);
  if (video !== m.video_path) removeFile(VIDEO_DIR, m.video_path);
  db.prepare(`UPDATE movies SET title=?, description=?, genre=?, year=?, duration_min=?, age_rating=?, price=?, access_days=?, video_url=?, trailer_url=?,
    series=?, episode=?, featured=?, published=?, poster=?, backdrop=?, video_path=? WHERE id = ?`)
    .run(f.title, f.description, f.genre, f.year, f.duration_min, f.age_rating, f.price, f.access_days, f.video_url, f.trailer_url,
      f.series, f.episode, f.featured, f.published, poster, backdrop, video, m.id);
  res.json({ movie: publicMovie(db.prepare('SELECT * FROM movies WHERE id = ?').get(m.id)) });
});

app.delete('/api/admin/movies/:id', requireAuth, requireAdmin, (req, res) => {
  const m = db.prepare('SELECT * FROM movies WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Movie not found.' });
  db.prepare('DELETE FROM movies WHERE id = ?').run(m.id);
  removeFile(IMG_DIR, m.poster);
  removeFile(IMG_DIR, m.backdrop);
  removeFile(VIDEO_DIR, m.video_path);
  res.json({ ok: true });
});

app.get('/api/admin/stats', requireAuth, requireAdmin, (_req, res) => {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const revenue = one(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM payments WHERE status = 'successful'`);
  const today = one(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM payments WHERE status = 'successful' AND date(created_at) = date('now')`);
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM payments GROUP BY status').all().map((r) => [r.status, r.n]));
  const daily = db.prepare(`SELECT date(created_at) AS day, SUM(amount) AS total, COUNT(*) AS n FROM payments
    WHERE status = 'successful' AND created_at > datetime('now', '-14 days') GROUP BY day ORDER BY day`).all();
  const byOperator = db.prepare(`SELECT operator, SUM(amount) AS total, COUNT(*) AS n FROM payments WHERE status = 'successful' GROUP BY operator`).all();
  const topMovies = db.prepare(`SELECT movie_title AS title, SUM(amount) AS total, COUNT(*) AS n FROM payments WHERE status = 'successful'
    GROUP BY movie_id ORDER BY total DESC LIMIT 5`).all();
  res.json({
    revenue: revenue.total, sales: revenue.n, revenueToday: today.total, salesToday: today.n,
    users: one('SELECT COUNT(*) AS n FROM users').n,
    movies: one('SELECT COUNT(*) AS n FROM movies').n,
    views: one('SELECT COALESCE(SUM(views),0) AS n FROM movies').n,
    payments: byStatus, daily, byOperator, topMovies, paymentMode: lipila.lipilaMode(),
  });
});

app.get('/api/admin/payments', requireAuth, requireAdmin, (req, res) => {
  const status = req.query.status;
  const rows = db.prepare(`SELECT p.*, u.name AS user_name, u.email AS user_email FROM payments p JOIN users u ON u.id = p.user_id
    ${status ? 'WHERE p.status = ?' : ''} ORDER BY p.id DESC LIMIT 500`).all(...(status ? [status] : []));
  res.json({ payments: rows.map(({ raw, ...r }) => r) });
});

app.post('/api/admin/payments/:ref/recheck', requireAuth, requireAdmin, asyncH(async (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE reference_id = ?').get(req.params.ref);
  if (!p) return res.status(404).json({ error: 'Payment not found.' });
  const data = await lipila.checkCollection(p.reference_id);
  const u = applyPaymentResult({ ...p, status: p.status === 'failed' ? 'pending' : p.status }, data);
  res.json({ status: u.status, message: u.provider_message, provider: data });
}));

app.post('/api/admin/grant', requireAuth, requireAdmin, (req, res) => {
  const { email, movieId, days } = req.body || {};
  const u = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email || '').trim());
  const m = db.prepare('SELECT id FROM movies WHERE id = ?').get(movieId);
  if (!u || !m) return res.status(404).json({ error: 'User or movie not found.' });
  const expires = Number(days) > 0 ? new Date(Date.now() + Number(days) * 864e5).toISOString().replace('T', ' ').slice(0, 19) : null;
  db.prepare('INSERT INTO purchases (user_id, movie_id, expires_at) VALUES (?, ?, ?)').run(u.id, m.id, expires);
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  const rows = db.prepare(`SELECT u.id, u.name, u.email, u.phone, u.role, u.created_at,
    (SELECT COALESCE(SUM(amount),0) FROM payments WHERE user_id = u.id AND status = 'successful') AS spent,
    (SELECT COUNT(*) FROM purchases WHERE user_id = u.id) AS purchases
    FROM users u ORDER BY u.id DESC LIMIT 1000`).all();
  res.json({ users: rows });
});

app.put('/api/admin/users/:id/role', requireAuth, requireAdmin, (req, res) => {
  const role = req.body?.role === 'admin' ? 'admin' : 'user';
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'You cannot change your own role.' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.json({ ok: true });
});

// ---------- Static files & SPA ----------
app.use('/uploads/images', express.static(IMG_DIR, { maxAge: '7d' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(err.status || (err instanceof multer.MulterError ? 400 : 500)).json({ error: err.message || 'Server error' });
});

app.listen(config.port, () => {
  console.log(`${config.siteName} running at http://localhost:${config.port}`);
  console.log(`Payments: Lipila ${lipila.lipilaMode()} mode`);
});
