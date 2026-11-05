import { api, state, esc, $, $$, money, compact, fmtDate, toast, modal } from './core.js';

const TABS = [['dashboard', 'Dashboard'], ['movies', 'Movies'], ['payments', 'Payments'], ['users', 'Users']];

export async function renderAdmin(app, tab) {
  if (state.user?.role !== 'admin') {
    app.innerHTML = '<div class="empty"><h3>Admins only</h3><p>Sign in with an admin account to manage the platform.</p></div>';
    return;
  }
  app.innerHTML = `<div class="page">
    <div class="toolbar"><h1 style="margin:0">Admin</h1><span class="status ${state.config.paymentMode === 'live' ? 'successful' : 'pending'}">Lipila: ${esc(state.config.paymentMode)} mode</span></div>
    <div class="tabs" style="max-width:520px">${TABS.map(([k, l]) => `<button class="${k === tab ? 'active' : ''}" data-t="${k}">${l}</button>`).join('')}</div>
    <div id="adminBody"><div class="skel" style="height:300px"></div></div>
  </div>`;
  $$('.tabs button', app).forEach((b) => (b.onclick = () => (location.hash = `#/admin/${b.dataset.t}`)));
  const body = $('#adminBody', app);
  if (tab === 'movies') return moviesTab(body);
  if (tab === 'payments') return paymentsTab(body);
  if (tab === 'users') return usersTab(body);
  return dashboardTab(body);
}

// ---------------- Dashboard ----------------
async function dashboardTab(body) {
  const s = await api('/admin/stats');
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    days.push({ day: d, total: s.daily.find((x) => x.day === d)?.total || 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.total));
  body.innerHTML = `
    <div class="stats">
      <div class="stat hl"><span>Total revenue</span><b>${money(s.revenue)}</b></div>
      <div class="stat"><span>Today</span><b>${money(s.revenueToday)}</b><span>${s.salesToday} sales</span></div>
      <div class="stat"><span>Sales</span><b>${s.sales}</b></div>
      <div class="stat"><span>Users</span><b>${s.users}</b></div>
      <div class="stat"><span>Total views</span><b>${compact(s.views)}</b></div>
      <div class="stat"><span>Titles</span><b>${s.movies}</b></div>
    </div>
    <div class="admin-grid">
      <div class="panel"><h3 style="margin:0">Revenue – last 14 days</h3>
        <div class="bars">${days.map((d) => `<div class="bar" title="${d.day}: ${money(d.total)}"><i style="height:${(d.total / max) * 100}%"></i><span>${d.day.slice(8)}</span></div>`).join('')}</div>
      </div>
      <div class="panel">
        <h3 style="margin:0 0 10px">Payments</h3>
        <p style="margin:4px 0"><span class="status successful">successful</span> ${s.payments.successful || 0}</p>
        <p style="margin:4px 0"><span class="status pending">pending</span> ${s.payments.pending || 0}</p>
        <p style="margin:4px 0 14px"><span class="status failed">failed</span> ${s.payments.failed || 0}</p>
        <h3 style="margin:0 0 8px">By network</h3>
        ${s.byOperator.map((o) => `<p style="margin:4px 0">${esc(o.operator || 'Unknown')}: <b>${money(o.total)}</b> <span class="muted">(${o.n})</span></p>`).join('') || '<p class="muted">No sales yet.</p>'}
      </div>
    </div>
    <div class="panel" style="margin-top:14px"><h3 style="margin:0 0 10px">Top earning titles</h3>
      ${s.topMovies.map((t, i) => `<p style="margin:6px 0">${i + 1}. ${esc(t.title)} – <b>${money(t.total)}</b> <span class="muted">(${t.n} sales)</span></p>`).join('') || '<p class="muted">No sales yet.</p>'}
    </div>`;
}

// ---------------- Movies ----------------
async function moviesTab(body) {
  const { movies } = await api('/admin/movies');
  body.innerHTML = `
    <div class="toolbar"><input class="input" id="mFilter" placeholder="Filter titles…" style="max-width:320px"><button class="btn primary" id="addMovie">+ Upload movie</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th></th><th>Title</th><th>Price</th><th>Views</th><th>Rating</th><th>Sales</th><th>Revenue</th><th>Status</th><th></th></tr></thead>
      <tbody id="mRows">${movies.map((m) => `<tr data-title="${esc((m.title + ' ' + (m.series || '')).toLowerCase())}">
        <td><img class="thumb" src="${esc(m.poster)}" alt=""></td>
        <td><b>${esc(m.title)}</b>${m.episode ? ` <span class="muted">Ep ${m.episode}</span>` : ''}<div class="muted" style="font-size:12px">${esc(m.genre)}${m.videoFile ? ' · uploaded file' : m.videoUrl ? ' · video URL' : ' · <span style="color:#f87171">no video</span>'}</div></td>
        <td>${m.price > 0 ? money(m.price) : '<span class="tag-free">Free</span>'}</td>
        <td>${compact(m.views)}</td><td>${m.rating ? '★ ' + m.rating.toFixed(1) : '–'}</td>
        <td>${m.sales}</td><td>${money(m.revenue)}</td>
        <td>${m.published ? '<span class="status successful">live</span>' : '<span class="status pending">hidden</span>'}${m.featured ? ' <span class="status pending">featured</span>' : ''}</td>
        <td><button class="btn sm outline" data-edit="${m.id}">Edit</button> <button class="btn sm danger" data-del="${m.id}">Delete</button></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  $('#mFilter').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    $$('#mRows tr').forEach((r) => r.classList.toggle('hidden', !r.dataset.title.includes(q)));
  };
  $('#addMovie').onclick = () => movieForm(null, () => moviesTab(body));
  $$('[data-edit]', body).forEach((b) => (b.onclick = () => movieForm(movies.find((m) => m.id === +b.dataset.edit), () => moviesTab(body))));
  $$('[data-del]', body).forEach((b) => (b.onclick = async () => {
    const m = movies.find((x) => x.id === +b.dataset.del);
    if (!confirm(`Delete “${m.title}”? This also deletes its uploaded files.`)) return;
    await api(`/admin/movies/${m.id}`, { method: 'DELETE' });
    toast('Deleted', 'ok');
    moviesTab(body);
  }));
}

function movieForm(m, done) {
  const v = (x) => esc(x ?? '');
  const { el, close } = modal(`
    <h2>${m ? 'Edit movie' : 'Upload movie'}</h2>
    <form id="mForm" class="form-grid" style="margin-top:16px" novalidate>
      <div id="mErr" class="full"></div>
      <div class="field full"><label>Title *</label><input name="title" required value="${v(m?.title)}"></div>
      <div class="field full"><label>Description</label><textarea name="description">${v(m?.description)}</textarea></div>
      <div class="field"><label>Genres</label><input name="genre" value="${v(m?.genre)}" placeholder="Drama, Comedy"></div>
      <div class="field"><label>Year</label><input name="year" type="number" value="${v(m?.year)}"></div>
      <div class="field"><label>Duration (minutes)</label><input name="durationMin" type="number" value="${v(m?.durationMin)}"></div>
      <div class="field"><label>Age rating</label><input name="ageRating" value="${v(m?.ageRating)}" placeholder="PG, 13, 16, 18"></div>
      <div class="field"><label>Price (ZMW) – 0 = free</label><input name="price" type="number" min="0" step="0.5" value="${v(m?.price ?? 0)}"></div>
      <div class="field"><label>Access after payment</label><select name="accessDays">
        ${[[0, 'Lifetime'], [1, '1 day'], [2, '2 days'], [3, '3 days'], [7, '7 days'], [30, '30 days']].map(([d, l]) => `<option value="${d}" ${(m?.accessDays ?? 0) === d ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>
      <div class="field"><label>Series name (for episodes)</label><input name="series" value="${v(m?.series)}"></div>
      <div class="field"><label>Episode number</label><input name="episode" type="number" value="${v(m?.episode)}"></div>
      <div class="field"><label>Poster (portrait image)</label><input name="poster" type="file" accept="image/*"></div>
      <div class="field"><label>Banner (wide image)</label><input name="backdrop" type="file" accept="image/*"></div>
      <div class="field full"><label>Video file</label><input name="video" type="file" accept="video/*">
        <span class="hint">${m?.videoFile ? 'A file is uploaded. Choose a new one to replace it. ' : ''}MP4 (H.264/AAC) plays on every phone.</span></div>
      <div class="field full"><label>…or video URL (streamed through this server, never shown to viewers)</label><input name="videoUrl" type="url" value="${v(m?.videoUrl)}" placeholder="https://…/movie.mp4"></div>
      <div class="field full"><label>Trailer URL (free preview, optional)</label><input name="trailerUrl" type="url" value="${v(m?.trailerUrl)}"></div>
      <label class="check"><input type="checkbox" name="featured" ${m?.featured ? 'checked' : ''}> Feature on home banner</label>
      <label class="check"><input type="checkbox" name="published" ${m ? (m.published ? 'checked' : '') : 'checked'}> Published</label>
      ${m?.videoFile ? '<label class="check full"><input type="checkbox" name="removeVideo"> Remove uploaded video file</label>' : ''}
      <div class="full"><div class="upload-progress hidden" id="upBar"><i></i></div>
        <button class="btn primary block" id="mSave" type="submit">${m ? 'Save changes' : 'Upload'}</button></div>
    </form>`, { wide: true });

  $('#mForm', el).onsubmit = (e) => {
    e.preventDefault();
    const f = e.target.elements;
    if (!f.title.value.trim()) { $('#mErr', el).innerHTML = '<div class="error">Title is required.</div>'; return; }
    const fd = new FormData(e.target);
    fd.set('featured', f.featured.checked ? '1' : '0');
    fd.set('published', f.published.checked ? '1' : '0');
    if (f.removeVideo) fd.set('removeVideo', f.removeVideo.checked ? '1' : '0');
    for (const k of ['poster', 'backdrop', 'video']) if (!f[k].files.length) fd.delete(k);
    // XHR instead of fetch so we can show upload progress for big video files.
    const xhr = new XMLHttpRequest();
    xhr.open(m ? 'PUT' : 'POST', m ? `/api/admin/movies/${m.id}` : '/api/admin/movies');
    const bar = $('#upBar', el);
    const btn = $('#mSave', el);
    bar.classList.remove('hidden');
    btn.disabled = true;
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      const pct = Math.round((ev.loaded / ev.total) * 100);
      $('i', bar).style.width = pct + '%';
      btn.textContent = pct < 100 ? `Uploading… ${pct}%` : 'Processing…';
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) { close(); toast(m ? 'Saved' : 'Movie uploaded', 'ok'); done(); }
      else { $('#mErr', el).innerHTML = `<div class="error">${esc(data.error || 'Upload failed')}</div>`; btn.disabled = false; btn.textContent = 'Try again'; }
    };
    xhr.onerror = () => { $('#mErr', el).innerHTML = '<div class="error">Network error during upload.</div>'; btn.disabled = false; };
    xhr.send(fd);
  };
}

// ---------------- Payments ----------------
async function paymentsTab(body, status = '') {
  const { payments } = await api(`/admin/payments${status ? `?status=${status}` : ''}`);
  body.innerHTML = `
    <div class="toolbar"><div class="chips" style="margin:0">${['', 'successful', 'pending', 'failed'].map((s) => `<button class="chip ${s === status ? 'active' : ''}" data-s="${s}">${s || 'All'}</button>`).join('')}</div>
      <span class="muted">${payments.length} payments · ${money(payments.filter((p) => p.status === 'successful').reduce((a, p) => a + p.amount, 0))} received</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Customer</th><th>Movie</th><th>Amount</th><th>Number</th><th>Status</th><th>Message</th><th>Reference</th><th></th></tr></thead>
      <tbody>${payments.map((p) => `<tr>
        <td>${fmtDate(p.created_at)}</td><td>${esc(p.user_name)}<div class="muted" style="font-size:12px">${esc(p.user_email)}</div></td>
        <td>${esc(p.movie_title)}</td><td><b>${money(p.amount)}</b></td>
        <td>0${esc(p.phone.slice(3))} <span class="muted">${esc(p.operator || '')}</span></td>
        <td><span class="status ${p.status}">${p.status}</span>${p.mode !== 'live' ? ` <span class="muted" style="font-size:11px">${esc(p.mode)}</span>` : ''}</td>
        <td class="muted" style="max-width:240px;overflow:hidden;text-overflow:ellipsis">${esc(p.provider_message || '')}</td>
        <td class="muted">${esc(p.reference_id)}</td>
        <td>${p.status !== 'successful' ? `<button class="btn sm outline" data-re="${esc(p.reference_id)}">Re-check</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No payments.</td></tr>'}</tbody>
    </table></div>`;
  $$('.chip', body).forEach((c) => (c.onclick = () => paymentsTab(body, c.dataset.s)));
  $$('[data-re]', body).forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try {
      const r = await api(`/admin/payments/${encodeURIComponent(b.dataset.re)}/recheck`, { method: 'POST' });
      toast(`Lipila says: ${r.status}`, r.status === 'successful' ? 'ok' : '');
      paymentsTab(body, status);
    } catch (e) { toast(e.message, 'bad'); b.disabled = false; }
  }));
}

// ---------------- Users ----------------
async function usersTab(body) {
  const [{ users }, { movies }] = await Promise.all([api('/admin/users'), api('/admin/movies')]);
  body.innerHTML = `
    <div class="panel" style="margin-bottom:14px">
      <h3 style="margin:0 0 10px">Give free access</h3>
      <form id="grantForm" style="display:flex;gap:10px;flex-wrap:wrap">
        <input class="input" name="email" type="email" placeholder="Customer email" required style="flex:1;min-width:200px">
        <select class="input" name="movieId" style="flex:1;min-width:200px">${movies.filter((m) => m.price > 0).map((m) => `<option value="${m.id}">${esc(m.title)}${m.episode ? ' Ep ' + m.episode : ''}</option>`).join('')}</select>
        <select class="input" name="days" style="width:140px"><option value="0">Lifetime</option><option value="1">1 day</option><option value="3">3 days</option><option value="7">7 days</option></select>
        <button class="btn primary">Grant</button>
      </form>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Joined</th><th>Purchases</th><th>Spent</th><th>Role</th></tr></thead>
      <tbody>${users.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.email)}</td><td>${u.phone ? '0' + esc(u.phone.slice(3)) : '–'}</td>
        <td>${fmtDate(u.created_at)}</td><td>${u.purchases}</td><td>${money(u.spent)}</td>
        <td>${u.id === state.user.id ? '<span class="status successful">admin (you)</span>'
          : `<select class="input" data-role="${u.id}" style="height:32px;width:100px"><option ${u.role === 'user' ? 'selected' : ''}>user</option><option ${u.role === 'admin' ? 'selected' : ''}>admin</option></select>`}</td></tr>`).join('')}</tbody>
    </table></div>`;
  $('#grantForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/admin/grant', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('Access granted', 'ok');
      usersTab(body);
    } catch (err) { toast(err.message, 'bad'); }
  };
  $$('[data-role]', body).forEach((s) => (s.onchange = async () => {
    await api(`/admin/users/${s.dataset.role}/role`, { method: 'PUT', body: { role: s.value } });
    toast('Role updated', 'ok');
  }));
}
