// Shared helpers: API calls, state, HTML escaping, modals, toasts.
export const state = { user: null, config: { siteName: 'ZedStream', currency: 'ZMW', paymentMode: 'mock' } };

export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const money = (n) => `K${Number(n).toLocaleString('en-ZM', { maximumFractionDigits: 2 })}`;
export const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n));
export const dur = (min) => (!min ? '' : min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`);
export const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
export const accessLabel = (days) => (days > 0 ? `${days}-day access` : 'Lifetime access');

/** "Fri 14 Nov, 21:15" in the viewer's own time zone. */
export const fmtPremiere = (iso) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Time left until iso, e.g. "4d 21h 13m" or "12m 05s". Empty when it has passed. */
export function countdown(iso) {
  let s = Math.floor((new Date(iso) - Date.now()) / 1000);
  if (s <= 0) return '';
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export const isUpcoming = (m) => !!m.premiereAt && new Date(m.premiereAt) > Date.now();

export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

/** Opens a modal. Returns { el, close }. onClose runs once when it closes. */
export function modal(html, { wide = false, onClose } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"><button class="close" aria-label="Close">×</button>${html}</div>`;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    bg.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  $('.close', bg).onclick = close;
  document.addEventListener('keydown', onKey);
  $('#modalRoot').append(bg);
  const el = $('.modal', bg);
  setTimeout(() => $('input, select, textarea', el)?.focus(), 30);
  return { el, close };
}

export function movieCard(m, { progress, landscape = false } = {}) {
  const priceBadge = m.price > 0
    ? `<span class="badge price paid">${money(m.price)}</span>`
    : '<span class="badge price free">Free</span>';
  const upcoming = isUpcoming(m);
  const sub = m.seasonPass ? 'All episodes' : m.series && m.episode ? `Episode ${m.episode}` : [m.year, m.genres?.[0]].filter(Boolean).join(' · ');
  return `<a class="card ${landscape ? 'landscape' : ''}" href="#/watch/${m.id}" title="${esc(m.title)}">
    <div class="card-img">
      <img src="${esc(landscape ? m.backdrop : m.poster)}" alt="" loading="lazy">
      ${m.rating ? `<span class="badge rating">${m.rating.toFixed(1)}</span>` : ''}
      ${m.seasonPass ? '<span class="badge price owned">Season pass</span>' : priceBadge}
      ${upcoming ? `<span class="views premiere-tag">🎬 ${esc(fmtPremiere(m.premiereAt))}</span>`
        : progress === undefined ? `<span class="views">👁 ${compact(m.views)}</span>` : ''}
      ${progress !== undefined ? `<div class="progress"><i style="width:${Math.round(progress * 100)}%"></i></div>` : ''}
    </div>
    <div class="card-title">${esc(m.title)}</div>
    ${sub ? `<div class="card-sub">${esc(sub)}</div>` : ''}
  </a>`;
}

export const skeletonRow = (n = 8) => `<div class="row">${'<div class="skel" style="aspect-ratio:2/3"></div>'.repeat(n)}</div>`;

/** Runs fn only after the user is signed in (shows the sign-in modal first if needed). */
export function requireUser(fn) {
  if (state.user) return fn();
  import('./auth.js').then(({ openAuth }) => openAuth('login', fn));
}
