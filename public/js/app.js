import { api, state, esc, $, $$, money, compact, dur, fmtDate, fmtPremiere, countdown, isUpcoming, accessLabel, toast, movieCard, skeletonRow, requireUser } from './core.js';
import { openAuth, logout } from './auth.js';
import { openPay } from './pay.js';

const app = $('#app');
let cleanups = [];
const onCleanup = (fn) => cleanups.push(fn);

// ---------------- Router ----------------
function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [p, qs] = raw.split('?');
  return { parts: p.split('/').filter(Boolean), query: new URLSearchParams(qs || '') };
}

async function route() {
  cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  cleanups = [];
  const { parts, query } = parseHash();
  const [page, arg] = parts;
  renderNav(page || 'home');
  if (page !== 'watch') window.scrollTo(0, 0);
  try {
    if (!page) await renderHome(query);
    else if (page === 'watch') await renderWatch(arg, { autoplay: query.get('play') === '1' });
    else if (page === 'library') await renderLibrary();
    else if (page === 'account') await renderAccount();
    else if (page === 'admin') {
      const { renderAdmin } = await import('./admin.js');
      await renderAdmin(app, arg || 'dashboard', onCleanup);
    } else if (page === 'page') renderStatic(arg);
    else app.innerHTML = '<div class="empty"><h3>Page not found</h3><a class="btn primary" href="#/">Go home</a></div>';
  } catch (err) {
    console.error(err);
    if (err.status === 401) {
      app.innerHTML = '<div class="empty"><h3>Please sign in</h3><button class="btn primary" id="si">Sign in</button></div>';
      $('#si').onclick = () => openAuth('login', route);
    } else {
      app.innerHTML = `<div class="empty"><h3>Something went wrong</h3><p>${esc(err.message)}</p><a class="btn primary" href="#/">Go home</a></div>`;
    }
  }
}

const ICONS = {
  home: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3 2 11h3v9h6v-6h2v6h6v-9h3z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M10 2a8 8 0 0 1 6.32 12.9l5.39 5.4-1.42 1.4-5.39-5.38A8 8 0 1 1 10 2m0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12"/></svg>',
  lib: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 6H2v14a2 2 0 0 0 2 2h14v-2H4zm16-4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2m-8 12.5v-9l6 4.5z"/></svg>',
  user: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10m0 2c-5.3 0-9 2.7-9 6v2h18v-2c0-3.3-3.7-6-9-6"/></svg>',
  admin: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z"/></svg>',
};

function renderNav(current) {
  const u = state.user;
  $('#nav').innerHTML = `
    <a href="#/" class="${current === 'home' ? 'active' : ''}">Home</a>
    <a href="#/library" class="${current === 'library' ? 'active' : ''}">My Library</a>
    ${u?.role === 'admin' ? `<a href="#/admin" class="${current === 'admin' ? 'active' : ''}">Admin</a>` : ''}
    ${u ? `<a href="#/account" class="avatar" title="${esc(u.name)}">${esc(u.name[0].toUpperCase())}</a>`
        : '<button class="btn primary sm" id="navSignIn">Sign in</button>'}`;
  $('#navSignIn')?.addEventListener('click', () => openAuth('login', route));
  const tab = (href, icon, label, key) => `<a href="${href}" class="${current === key ? 'active' : ''}">${ICONS[icon]}<span>${label}</span></a>`;
  $('#tabbar').innerHTML = tab('#/', 'home', 'Home', 'home')
    + `<a href="#/" id="tabSearch">${ICONS.search}<span>Search</span></a>`
    + tab('#/library', 'lib', 'Library', 'library')
    + (u?.role === 'admin' ? tab('#/admin', 'admin', 'Admin', 'admin') : '')
    + (u ? tab('#/account', 'user', 'Account', 'account') : `<a href="#/account" id="tabSignIn">${ICONS.user}<span>Sign in</span></a>`);
  $('#tabSearch').onclick = (e) => { e.preventDefault(); window.scrollTo(0, 0); $('#searchInput').focus(); };
  $('#tabSignIn')?.addEventListener('click', (e) => { e.preventDefault(); openAuth('login', route); });
}

// ---------------- Search & sort ----------------
let searchTimer;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = e.target.value.trim();
    const sort = $('#sortSelect').value;
    location.hash = q ? `#/?q=${encodeURIComponent(q)}&sort=${sort}` : '#/';
  }, 300);
});
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); $('#searchInput').blur(); });
$('#sortSelect').addEventListener('change', (e) => {
  const { parts, query } = parseHash();
  if (parts.length || query.get('q')) {
    query.set('sort', e.target.value);
    location.hash = `#/?${query}`;
  } else {
    allMoviesSort = e.target.value;
    loadAllMovies();
    $('#allMovies')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

// ---------------- Home ----------------
let allMoviesSort = 'latest';
let allMoviesFilter = 'all';

async function renderHome(query) {
  const q = query.get('q');
  const sort = query.get('sort') || 'latest';
  $('#sortSelect').value = sort;
  if (q) return renderSearch(q, sort);
  $('#searchInput').value = '';

  app.innerHTML = `<div class="hero skel" style="border-radius:0"></div><div class="section">${skeletonRow()}</div>`;
  const [{ movies }, popular, lib] = await Promise.all([
    api('/movies?sort=latest'),
    api('/movies?sort=popular'),
    state.user ? api('/me/library').catch(() => null) : null,
  ]);
  if (!movies.length) {
    app.innerHTML = `<div class="empty"><h3>No movies yet</h3><p>${state.user?.role === 'admin' ? '<a class="btn primary" href="#/admin/movies">Upload your first movie</a>' : 'Check back soon.'}</p></div>`;
    return;
  }

  const featured = movies.filter((m) => m.featured);
  const heroItems = (featured.length ? featured : popular.movies.slice(0, 5)).slice(0, 6);
  const genres = {};
  movies.forEach((m) => m.genres.forEach((g) => (genres[g] ||= []).push(m)));
  const topGenres = Object.entries(genres).filter(([, l]) => l.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, 4);
  const comingSoon = movies.filter(isUpcoming).sort((a, b) => new Date(a.premiereAt) - new Date(b.premiereAt));
  const free = movies.filter((m) => m.price <= 0);
  const paid = movies.filter((m) => m.price > 0);
  const row = (title, list, opts) => (list.length ? `<section class="section"><div class="section-head"><h2>${esc(title)}</h2></div>
    <div class="row ${opts?.landscape ? 'wide' : ''}">${list.map((m) => movieCard(m, { ...opts, progress: opts?.withProgress ? m.progress : undefined })).join('')}</div></section>` : '');

  app.innerHTML = `
    <section class="hero" id="hero">
      ${heroItems.map((m, i) => `<div class="hero-slide ${i === 0 ? 'active' : ''}"><img src="${esc(m.backdrop)}" alt="" ${i ? 'loading="lazy"' : ''}></div>`).join('')}
      <div class="hero-content" id="heroContent"></div>
      ${heroItems.length > 1 ? `<div class="hero-dots">${heroItems.map((_, i) => `<button aria-label="Slide ${i + 1}" data-i="${i}" class="${i === 0 ? 'active' : ''}"></button>`).join('')}</div>` : ''}
    </section>
    <div class="advert">
      <small>ADVERT</small>
      <div><h3>Watch the latest Zambian blockbusters</h3><p>Pay in seconds with mobile money. No card needed.</p></div>
      <div class="ops"><span class="op mtn">MTN MoMo</span><span class="op airtel">Airtel Money</span><span class="op zamtel">Zamtel Kwacha</span></div>
    </div>
    ${row('Coming soon – pre-order now', comingSoon)}
    ${lib ? row('Continue watching', lib.continueWatching, { landscape: true, withProgress: true }) : ''}
    ${row('Trending now', popular.movies.slice(0, 15))}
    ${row('New releases', movies.slice(0, 15))}
    ${row('Premium – pay with mobile money', paid)}
    ${row('Free to watch', free)}
    ${topGenres.map(([g, list]) => row(g, list)).join('')}
    <section class="section" id="allMovies">
      <div class="section-head"><h2>All Movies</h2></div>
      <div class="chips" id="chips">
        ${['all', 'free', 'paid'].map((f) => `<button class="chip" data-f="${f}">${f === 'all' ? 'All' : f === 'free' ? 'Free' : 'Premium'}</button>`).join('')}
        ${Object.keys(genres).sort().map((g) => `<button class="chip" data-f="g:${esc(g)}">${esc(g)}</button>`).join('')}
      </div>
      <div class="grid" id="allGrid"></div>
    </section>`;

  // Hero carousel
  let idx = 0;
  const showSlide = (i) => {
    idx = i;
    $$('.hero-slide').forEach((s, j) => s.classList.toggle('active', j === i));
    $$('.hero-dots button').forEach((s, j) => s.classList.toggle('active', j === i));
    const m = heroItems[i];
    $('#heroContent').innerHTML = `
      ${isUpcoming(m) ? `<div class="hero-premiere">🎬 PREMIERE · ${esc(fmtPremiere(m.premiereAt))} · <span id="heroCd">${countdown(m.premiereAt)}</span></div>` : ''}
      <h1 class="hero-title">${esc(m.title)}</h1>
      <div class="meta">
        ${m.rating ? `<span class="star">★ ${m.rating.toFixed(1)}</span>` : ''}
        ${m.year ? `<span>${m.year}</span>` : ''}
        ${m.ageRating ? `<span class="pill">${esc(m.ageRating)}+</span>` : ''}
        ${m.durationMin ? `<span>${dur(m.durationMin)}</span>` : ''}
        ${m.genres.length ? `<span>${esc(m.genres.join(' · '))}</span>` : ''}
        ${m.price > 0 ? `<span class="tag-paid">${money(m.price)}</span>` : '<span class="tag-free">FREE</span>'}
      </div>
      <p class="hero-desc">${esc(m.description)}</p>
      <div class="hero-actions">
        ${isUpcoming(m)
          ? `<a class="btn primary" href="#/watch/${m.id}">🎬 ${m.price > 0 ? `Pre-order ${money(m.price)}` : 'Remind me'}</a>`
          : `<a class="btn primary" href="#/watch/${m.id}?play=1">▶ Watch Now</a>`}
        <a class="btn ghost" href="#/watch/${m.id}">ⓘ More info</a>
      </div>`;
  };
  showSlide(0);
  $$('.hero-dots button').forEach((b) => (b.onclick = () => { showSlide(+b.dataset.i); restart(); }));
  let timer;
  const restart = () => { clearInterval(timer); if (heroItems.length > 1) timer = setInterval(() => showSlide((idx + 1) % heroItems.length), 7000); };
  restart();
  onCleanup(() => clearInterval(timer));
  const heroCdTimer = setInterval(() => {
    const el = $('#heroCd');
    if (el) el.textContent = countdown(heroItems[idx].premiereAt) || 'Out now';
  }, 1000);
  onCleanup(() => clearInterval(heroCdTimer));

  $$('#chips .chip').forEach((c) => (c.onclick = () => { allMoviesFilter = c.dataset.f; loadAllMovies(); }));
  $('#sortSelect').value = allMoviesSort;
  loadAllMovies();
}

async function loadAllMovies() {
  const grid = $('#allGrid');
  if (!grid) return;
  $$('#chips .chip').forEach((c) => c.classList.toggle('active', c.dataset.f === allMoviesFilter));
  const p = new URLSearchParams({ sort: allMoviesSort });
  if (allMoviesFilter === 'free' || allMoviesFilter === 'paid') p.set('price', allMoviesFilter);
  if (allMoviesFilter.startsWith('g:')) p.set('genre', allMoviesFilter.slice(2));
  const { movies } = await api(`/movies?${p}`);
  grid.innerHTML = movies.map((m) => movieCard(m)).join('') || '<p class="muted">Nothing here yet.</p>';
}

async function renderSearch(q, sort) {
  $('#searchInput').value = q;
  const { movies } = await api(`/movies?q=${encodeURIComponent(q)}&sort=${sort}`);
  app.innerHTML = `<section class="section" style="padding-top:26px">
    <div class="section-head"><h2>${movies.length} result${movies.length === 1 ? '' : 's'} for “${esc(q)}”</h2></div>
    ${movies.length ? `<div class="grid">${movies.map((m) => movieCard(m)).join('')}</div>` : '<div class="empty"><h3>No matches</h3><p>Try a different title, genre or series.</p></div>'}
  </section>`;
}

// ---------------- Watch page ----------------
async function renderWatch(id, { autoplay = false } = {}) {
  window.scrollTo(0, 0);
  app.innerHTML = '<div class="player-wrap skel" style="border-radius:0"></div>';
  const data = await api(`/movies/${id}`);
  const { movie: m, hasAccess, canWatch, episodes, related, seriesPass: pass, watermark } = data;
  document.title = `${m.title} – ${state.config.siteName}`;
  onCleanup(() => (document.title = state.config.siteName));

  const upcoming = isUpcoming(m);
  const idxEp = episodes.findIndex((e) => e.id === m.id);
  const nextEp = idxEp >= 0 ? episodes[idxEp + 1] : null;
  const resumeAt = data.progress && data.progress.seconds > 10 && (!data.progress.duration || data.progress.seconds < data.progress.duration * 0.95) ? data.progress.seconds : 0;

  // Season pass offer, shaped like a movie so the checkout can sell it.
  const passItem = pass && !pass.owned ? {
    id: m.id,
    title: `${pass.series} · Season pass`,
    poster: pass.poster,
    price: pass.price,
    accessDays: pass.accessDays,
    note: `All ${pass.episodes} episodes, new ones included · ${accessLabel(pass.accessDays)}`,
    payload: { series: pass.series },
  } : null;
  const passSave = pass ? Math.max(0, pass.fullPrice - pass.price) : 0;
  const passLabel = passItem ? `Season pass ${money(pass.price)}${passSave ? ` · save ${money(passSave)}` : ''}` : '';

  // One checkout at a time: extra taps while it loads are ignored.
  let opening = false;
  const payFlow = (item) => requireUser(async () => {
    if (opening || document.querySelector('.modal')) return;
    opening = true;
    const btns = $$('#payBtn, #payBtn2, #passBtn, #passBtn2');
    btns.forEach((b) => { b.disabled = true; });
    try {
      const fresh = await api(`/movies/${id}`);
      const alreadyOwned = item.payload?.series ? fresh.seriesPass?.owned : fresh.hasAccess;
      if (alreadyOwned) return renderWatch(id, { autoplay: fresh.canWatch });
      openPay(item, () => renderWatch(id, { autoplay: !upcoming }));
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      opening = false;
      btns.forEach((b) => { b.disabled = false; });
    }
  });

  const trailerBtn = m.trailerUrl ? '<button class="btn ghost" id="trailerBtn">▶ Trailer</button>' : '';
  let cover;
  if (canWatch) {
    cover = `<div class="play-cover" id="playCover"><div>
        <button class="big-play" id="bigPlay" aria-label="Play"><svg width="34" height="34" viewBox="0 0 24 24"><path fill="#fff" d="M8 5v14l11-7z"/></svg></button>
        ${resumeAt ? `<p style="margin:14px 0 0;font-weight:600">Resume from ${Math.floor(resumeAt / 60)}:${String(Math.floor(resumeAt % 60)).padStart(2, '0')}</p>` : ''}
      </div></div>`;
  } else if (hasAccess && upcoming) {
    cover = `<div class="paywall"><div class="paywall-box">
        <div class="lock-ico">🎬</div>
        <h2>${m.price > 0 ? "You're booked for the premiere!" : 'Free premiere'}</h2>
        <p>${esc(m.title)} premieres ${esc(fmtPremiere(m.premiereAt))}. It unlocks here automatically.</p>
        <div class="countdown" id="cd"></div>
        ${trailerBtn}
      </div></div>`;
  } else {
    cover = `<div class="paywall"><div class="paywall-box">
        <div class="lock-ico">${upcoming ? '🎬' : '🔒'}</div>
        <h2>${upcoming ? `Premieres ${esc(fmtPremiere(m.premiereAt))}` : `Unlock “${esc(m.title)}”`}</h2>
        ${upcoming ? '<div class="countdown" id="cd"></div>' : ''}
        <p>${upcoming ? `Pre-order for <b>${money(m.price)}</b> and watch the moment it premieres.` : `Pay <b>${money(m.price)}</b> with mobile money · ${accessLabel(m.accessDays)}`}</p>
        <div class="pay-options">
          <button class="btn primary" id="payBtn">${upcoming ? `Pre-order ${money(m.price)}` : `Pay ${money(m.price)} with Mobile Money`}</button>
          ${passItem ? `<button class="btn ghost" id="passBtn">${passLabel}</button>` : ''}
          ${trailerBtn}
        </div>
        <div class="ops"><span class="op mtn">MTN</span><span class="op airtel">Airtel</span><span class="op zamtel">Zamtel</span></div>
      </div></div>`;
  }

  let accessNote = '';
  if (state.user?.role === 'admin' && m.price > 0 && !pass?.owned) accessNote = `<div class="access-note">Admin preview${upcoming ? ` · public premiere ${esc(fmtPremiere(m.premiereAt))}` : ''}</div>`;
  else if (pass?.owned) accessNote = `<div class="access-note">✓ Season pass${data.accessExpiresAt ? ` · until ${fmtDate(data.accessExpiresAt)}` : ''}</div>`;
  else if (m.price > 0 && hasAccess && upcoming) accessNote = `<div class="access-note">✓ Pre-ordered · premieres ${esc(fmtPremiere(m.premiereAt))}</div>`;
  else if (m.price > 0 && hasAccess) accessNote = `<div class="access-note">✓ Unlocked${data.accessExpiresAt ? ` · until ${fmtDate(data.accessExpiresAt)}` : ''}</div>`;

  let mainAction = '';
  if (canWatch) mainAction = '<button class="btn primary" id="playBtn2">▶ Play</button>';
  else if (!hasAccess) mainAction = `<button class="btn primary" id="payBtn2">${upcoming ? 'Pre-order' : 'Pay'} ${money(m.price)}</button>`;

  app.innerHTML = `
    <div class="player-wrap" id="player">
      <img class="backdrop" src="${esc(m.backdrop)}" alt="">
      ${cover}
    </div>

    <section class="detail">
      <div class="detail-poster"><img src="${esc(m.poster)}" alt=""></div>
      <div>
        <h1>${esc(m.title)}${m.series && m.episode ? ` <span class="muted" style="font-weight:600;font-size:.55em">Episode ${m.episode}</span>` : ''}</h1>
        <div class="meta">
          ${upcoming ? `<span class="tag-premiere">🎬 Premieres ${esc(fmtPremiere(m.premiereAt))}</span>` : ''}
          ${m.rating ? `<span class="star">★ ${m.rating.toFixed(1)}</span><span class="muted">(${m.ratingCount})</span>` : ''}
          ${upcoming ? '' : `<span>👁 ${compact(m.views)} views</span>`}
          ${m.year ? `<span>${m.year}</span>` : ''}
          ${m.ageRating ? `<span class="pill">${esc(m.ageRating)}+</span>` : ''}
          ${m.durationMin ? `<span>${dur(m.durationMin)}</span>` : ''}
          ${m.genres.length ? `<span>${esc(m.genres.join(' · '))}</span>` : ''}
          ${m.price > 0 ? `<span class="tag-paid">${money(m.price)}</span>` : '<span class="tag-free">FREE</span>'}
        </div>
        ${accessNote}
        <div class="detail-actions">
          ${mainAction}
          <button class="btn outline" id="listBtn">${data.inWatchlist ? '✓ In My List' : '+ My List'}</button>
          <button class="btn outline" id="shareBtn">↗ Share</button>
        </div>
        <p class="desc">${esc(m.description)}</p>
        ${upcoming ? '' : `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span class="muted">Your rating:</span>
          <div class="stars" id="stars">${[1, 2, 3, 4, 5].map((s) => `<button data-s="${s}" class="${s <= (data.userRating || 0) ? 'on' : ''}" aria-label="${s} stars">★</button>`).join('')}</div>
        </div>`}
      </div>
    </section>

    ${episodes.length > 1 ? `<section class="section"><div class="section-head"><h2>${esc(m.series)} · Episodes</h2></div>
      ${passItem ? `<div class="pass-box">
        <div><b>Season pass · ${money(pass.price)}</b>
          <p>Unlock all ${pass.episodes} episodes in one payment${passSave ? ` and save ${money(passSave)}` : ''}. New episodes are included free.</p></div>
        <button class="btn primary" id="passBtn2">Get season pass</button>
      </div>` : pass?.owned ? '<div class="access-note" style="margin-bottom:12px">✓ You have the season pass for every episode</div>' : ''}
      <div class="episodes">${episodes.map((e) => `<a class="ep ${e.id === m.id ? 'current' : ''}" href="#/watch/${e.id}">
        <div class="ep-num">${e.episode ?? ''}</div>
        <div class="ep-img"><img src="${esc(e.backdrop)}" alt="" loading="lazy"></div>
        <div><h4>${e.episode ? `Episode ${e.episode}` : esc(e.title)}</h4><p>${esc(e.description)}</p></div>
        <div>${e.price <= 0 ? '<span class="tag-free">FREE</span>' : pass?.owned ? '<span class="tag-free">✓</span>' : `<span class="badge paid" style="position:static">${money(e.price)}</span>`}</div>
      </a>`).join('')}</div></section>` : ''}

    ${related.length ? `<section class="section"><div class="section-head"><h2>More like this</h2></div>
      <div class="row">${related.map((r) => movieCard(r)).join('')}</div></section>` : ''}`;

  // Premiere countdown: re-render the page the moment it premieres.
  const cd = $('#cd');
  if (cd) {
    const tick = () => {
      const left = countdown(m.premiereAt);
      if (!left) { clearInterval(timer); renderWatch(id); return; }
      cd.innerHTML = left.split(' ').map((p) => `<span><b>${p.replace(/\D+$/, '')}</b>${p.replace(/^\d+/, '')}</span>`).join('');
    };
    const timer = setInterval(tick, 1000);
    tick();
    onCleanup(() => clearInterval(timer));
  }

  // Player
  let video;
  const startPlayback = () => {
    if (video) { video.play(); return; }
    const wrap = $('#player');
    // Paid titles get a moving watermark with the viewer's number. Native fullscreen and
    // picture-in-picture are turned off for them because they would hide the watermark.
    wrap.innerHTML = `<video id="video" controls playsinline autoplay preload="auto" poster="${esc(m.backdrop)}"
        controlsList="nodownload${watermark ? ' nofullscreen' : ''}" ${watermark ? 'disablePictureInPicture' : ''} src="/api/stream/${m.id}"></video>
      ${watermark ? `<div class="watermark" id="wm">${esc(watermark)}</div>
        <button class="fs-btn" id="fsBtn" aria-label="Full screen" title="Full screen">⛶</button>` : ''}`;
    video = $('#video');
    // Start playback inside the tap that called us; browsers can ignore the autoplay attribute.
    video.play().catch(() => {});
    video.oncontextmenu = (e) => e.preventDefault();
    if (watermark) setupWatermark(wrap, video);
    let counted = false;
    let lastSave = 0;
    const save = () => {
      if (!state.user || !video.duration) return;
      api(`/movies/${m.id}/progress`, { method: 'POST', body: { seconds: video.currentTime, duration: video.duration } }).catch(() => {});
    };
    video.addEventListener('loadedmetadata', () => { if (resumeAt && resumeAt < video.duration - 5) video.currentTime = resumeAt; }, { once: true });
    video.addEventListener('play', () => {
      if (!counted) { counted = true; api(`/movies/${m.id}/view`, { method: 'POST' }).catch(() => {}); }
    });
    video.addEventListener('timeupdate', () => { if (Date.now() - lastSave > 10000) { lastSave = Date.now(); save(); } });
    video.addEventListener('pause', save);
    video.addEventListener('ended', () => {
      save();
      if (nextEp) {
        const b = document.createElement('a');
        b.className = 'btn primary next-up';
        b.href = `#/watch/${nextEp.id}?play=1`;
        b.textContent = `Next: Episode ${nextEp.episode} ▶`;
        wrap.append(b);
      }
    });
    video.addEventListener('error', async () => {
      const r = await fetch(`/api/stream/${m.id}`, { method: 'HEAD' }).catch(() => null);
      if (r?.status === 402) return toast('Your access has expired. Please pay again to watch.', 'bad');
      // Show a retry button over the player instead of leaving a dead video.
      if ($('#retryVideo')) return;
      const b = document.createElement('button');
      b.id = 'retryVideo';
      b.className = 'btn primary next-up';
      b.textContent = '↻ Video did not load. Try again';
      b.onclick = () => { b.remove(); video.load(); video.play().catch(() => {}); };
      $('#player').append(b);
    });
    onCleanup(save);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const on = (sel, fn) => $(sel)?.addEventListener('click', fn);
  on('#bigPlay', startPlayback);
  on('#playBtn2', startPlayback);
  on('#payBtn', () => payFlow(m));
  on('#payBtn2', () => payFlow(m));
  on('#passBtn', () => payFlow(passItem));
  on('#passBtn2', () => payFlow(passItem));
  on('#trailerBtn', () => {
    $('#player').innerHTML = `<video controls autoplay playsinline src="${esc(m.trailerUrl)}"></video>`;
  });
  if (autoplay) {
    if (canWatch) startPlayback();
    else if (!hasAccess) payFlow(m);
  }

  $('#listBtn').onclick = () => requireUser(async () => {
    const r = await api(`/movies/${m.id}/watchlist`, { method: 'POST' });
    $('#listBtn').textContent = r.inWatchlist ? '✓ In My List' : '+ My List';
    toast(r.inWatchlist ? 'Added to My List' : 'Removed from My List', 'ok');
  });
  $('#shareBtn').onclick = async () => {
    const url = `${location.origin}/#/watch/${m.id}`;
    if (navigator.share) { try { await navigator.share({ title: m.title, url }); } catch { /* cancelled */ } }
    else { await navigator.clipboard.writeText(url); toast('Link copied', 'ok'); }
  };
  $$('#stars button').forEach((b) => (b.onclick = () => requireUser(async () => {
    const r = await api(`/movies/${m.id}/rate`, { method: 'POST', body: { stars: +b.dataset.s } });
    $$('#stars button').forEach((x) => x.classList.toggle('on', +x.dataset.s <= r.userRating));
    toast(`Thanks! Rated ${r.userRating}★`, 'ok');
  })));
}

/** Moves the watermark around and keeps it visible in fullscreen. */
function setupWatermark(wrap, video) {
  const wm = $('#wm', wrap);
  const move = () => {
    wm.style.top = `${8 + Math.random() * 72}%`;
    wm.style.left = `${4 + Math.random() * 56}%`;
  };
  move();
  const timer = setInterval(move, 12000);
  onCleanup(() => clearInterval(timer));

  // Fullscreen the wrapper (video + watermark), never the bare video.
  const isFs = () => document.fullscreenElement === wrap || wrap.classList.contains('pseudo-fs');
  const toggle = async () => {
    if (isFs()) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      wrap.classList.remove('pseudo-fs');
      document.body.classList.remove('no-scroll');
    } else if (wrap.requestFullscreen) {
      await wrap.requestFullscreen().catch(() => { wrap.classList.add('pseudo-fs'); document.body.classList.add('no-scroll'); });
    } else {
      // iPhone Safari can't fullscreen a div: fill the screen with CSS instead.
      wrap.classList.add('pseudo-fs');
      document.body.classList.add('no-scroll');
    }
  };
  $('#fsBtn', wrap).onclick = toggle;
  video.addEventListener('dblclick', (e) => { e.preventDefault(); toggle(); });
  const onFs = () => {
    if (document.fullscreenElement === video) document.exitFullscreen().then(() => wrap.requestFullscreen()).catch(() => {});
  };
  document.addEventListener('fullscreenchange', onFs);
  onCleanup(() => {
    document.removeEventListener('fullscreenchange', onFs);
    document.body.classList.remove('no-scroll');
  });
}

// ---------------- Library & account ----------------
async function renderLibrary() {
  if (!state.user) {
    app.innerHTML = `<div class="empty"><h3>Your library</h3><p>Sign in to see movies you've bought, your list and what you were watching.</p><button class="btn primary" id="si">Sign in</button></div>`;
    $('#si').onclick = () => openAuth('login', route);
    return;
  }
  const lib = await api('/me/library');
  const active = lib.purchases.filter((p) => p.active);
  const sect = (title, list, opts = {}) => `<section class="section"><div class="section-head"><h2>${title}</h2></div>
    ${list.length ? `<div class="grid">${list.map((m) => movieCard(m, opts.progress ? { progress: m.progress } : {})).join('')}</div>` : `<p class="muted">${opts.empty}</p>`}</section>`;
  app.innerHTML = `<div class="page" style="padding-bottom:0"><h1>My Library</h1></div>
    ${lib.continueWatching.length ? sect('Continue watching', lib.continueWatching, { progress: true }) : ''}
    ${sect('Purchased', active, { empty: 'Movies you pay for will appear here.' })}
    ${sect('My List', lib.watchlist, { empty: 'Tap “+ My List” on any movie to save it for later.' })}`;
}

async function renderAccount() {
  if (!state.user) { openAuth('login', route); app.innerHTML = '<div class="empty"><h3>Please sign in</h3></div>'; return; }
  const lib = await api('/me/library');
  const u = state.user;
  app.innerHTML = `<div class="page">
    <h1>My Account</h1>
    <div class="panel" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:22px">
      <div class="avatar" style="width:56px;height:56px;font-size:22px">${esc(u.name[0].toUpperCase())}</div>
      <div style="flex:1;min-width:200px"><b style="font-size:18px">${esc(u.name)}</b><div class="muted">${esc(u.email)}${u.phone ? ' · 0' + esc(u.phone.slice(3)) : ''}</div></div>
      ${u.role === 'admin' ? '<a class="btn outline" href="#/admin">Admin dashboard</a>' : ''}
      <button class="btn outline" id="logoutBtn">Sign out</button>
    </div>
    <h2 style="font-size:20px">Payment history</h2>
    ${lib.payments.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Movie</th><th>Amount</th><th>Number</th><th>Status</th><th>Reference</th></tr></thead>
      <tbody>${lib.payments.map((p) => `<tr>
        <td>${fmtDate(p.created_at)}</td>
        <td>${p.movie_id ? `<a href="#/watch/${p.movie_id}">${esc(p.movie_title)}</a>` : esc(p.movie_title)}</td>
        <td>${money(p.amount)}</td><td>0${esc(p.phone.slice(3))} <span class="muted">${esc(p.operator || '')}</span></td>
        <td><span class="status ${p.status}">${p.status}</span></td><td class="muted">${esc(p.reference_id)}</td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="muted">No payments yet.</p>'}
  </div>`;
  $('#logoutBtn').onclick = logout;
}

// ---------------- Static pages ----------------
function renderStatic(name) {
  const site = esc(state.config.siteName);
  const pages = {
    terms: ['Terms & Conditions', `<p>By using ${site} you agree to watch content for personal, non-commercial use only. Purchases unlock a title for the period shown at checkout. Recording, re-uploading or sharing paid content is prohibited.</p>
      <h2>Payments</h2><p>Payments are processed by mobile money through Lipila. Once a payment is approved on your phone, the title unlocks on your account. If money leaves your wallet but the title does not unlock within 30 minutes, contact support with your payment reference.</p>`],
    privacy: ['Privacy Policy', `<p>We store your name, email, phone number and viewing history to run the service. Your mobile money PIN is never seen or stored by ${site}; it is entered only on your phone. We do not sell your data.</p>`],
    copyright: ['Copyright', `<p>All films on ${site} are the property of their respective owners and are streamed with permission. To report infringement, contact us with the title and proof of ownership.</p>`],
  };
  const [title, body] = pages[name] || ['Not found', '<p>Page not found.</p>'];
  app.innerHTML = `<div class="page prose"><h1>${title}</h1>${body}</div>`;
}

// ---------------- Boot ----------------
async function boot() {
  try {
    const [cfg, me] = await Promise.all([api('/config'), api('/auth/me')]);
    state.config = cfg;
    state.user = me.user;
  } catch { /* offline: keep defaults */ }
  const name = state.config.siteName;
  document.title = name;
  const split = name.match(/^(.*?)([A-Z][a-z]+)$/);
  $('#brandName').innerHTML = split && split[1] ? `${esc(split[1].toUpperCase())}<b>${esc(split[2].toUpperCase())}</b>` : esc(name.toUpperCase());
  $('#copyright').textContent = `© ${new Date().getFullYear()} ${name}`;
  window.addEventListener('hashchange', route);
  window.addEventListener('userchange', route);
  route();
}
boot();
