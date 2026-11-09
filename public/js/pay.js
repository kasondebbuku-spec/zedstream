// Mobile money checkout: enter number -> PIN prompt on phone -> poll status -> unlock.
import { api, state, modal, esc, money, accessLabel, fmtPremiere, isUpcoming, $ } from './core.js';

const OPERATORS = { 96: 'mtn', 76: 'mtn', 97: 'airtel', 77: 'airtel', 95: 'zamtel', 75: 'zamtel' };
const OP_NAMES = { mtn: 'MTN MoMo', airtel: 'Airtel Money', zamtel: 'Zamtel Kwacha' };

function detect(raw) {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('260')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return { op: OPERATORS[d.slice(0, 2)] || null, valid: /^[79][5-7]\d{7}$/.test(d), local: '0' + d };
}

/**
 * item: a movie from the API, or a season pass shaped like one.
 * Optional: item.payload (what to POST, default { movieId }), item.note (line under the title).
 */
export function openPay(movie, onPaid) {
  const preorder = isUpcoming(movie);
  const note = movie.note || (preorder ? `Pre-order · unlocks ${fmtPremiere(movie.premiereAt)}` : accessLabel(movie.accessDays));
  const testMode = state.config.paymentMode !== 'live';
  const savedPhone = state.user?.phone ? '0' + state.user.phone.slice(3) : '';
  let pollTimer = null;
  let stopped = false;

  const { el, close } = modal(`
    <h2>Unlock with Mobile Money</h2>
    <p class="muted" style="margin:0">Pay once and watch on any device.</p>
    <div class="pay-summary">
      <img src="${esc(movie.poster)}" alt="">
      <div><b>${esc(movie.title)}</b>${movie.episode ? `<div class="muted">Episode ${movie.episode}</div>` : ''}<div class="muted" style="font-size:13px">${esc(note)}</div></div>
      <div class="amt">${money(movie.price)}</div>
    </div>
    <div id="payBody"></div>`, {
    onClose: () => { stopped = true; clearTimeout(pollTimer); },
  });
  const body = $('#payBody', el);

  function showForm(error = '') {
    body.innerHTML = `
      ${testMode ? `<div class="test-note"><b>Test mode (${esc(state.config.paymentMode)})</b> – no real money moves.
        Use any number, or <code>0977000002</code> to simulate a failed payment.</div>` : ''}
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
      <form id="payForm" novalidate>
        <div class="field">
          <label for="payPhone">Mobile money number</label>
          <div class="phone-input">
            <input id="payPhone" type="tel" inputmode="numeric" autocomplete="tel" placeholder="097 123 4567" value="${esc(savedPhone)}" maxlength="16">
            <span class="op-detect" id="opDetect"></span>
          </div>
          <span class="hint">MTN (096/076), Airtel (097/077) or Zamtel (095/075)</span>
        </div>
        <button class="btn primary block" id="payBtn" type="submit">Pay ${money(movie.price)}</button>
      </form>
      <div class="ops" style="justify-content:center;margin-top:14px"><span class="op mtn">MTN</span><span class="op airtel">Airtel</span><span class="op zamtel">Zamtel</span></div>`;
    const input = $('#payPhone', body);
    const upd = () => {
      const { op } = detect(input.value);
      $('#opDetect', body).innerHTML = op ? `<span class="op ${op}">${OP_NAMES[op]}</span>` : '';
    };
    input.oninput = upd;
    upd();
    input.focus();
    $('#payForm', body).onsubmit = async (e) => {
      e.preventDefault();
      const { valid, local } = detect(input.value);
      if (!valid) return showForm('Enter a valid Zambian mobile number, e.g. 0977123456.');
      const btn = $('#payBtn', body);
      btn.disabled = true;
      btn.textContent = 'Sending request…';
      try {
        const r = await api('/payments', { method: 'POST', body: { ...(movie.payload || { movieId: movie.id }), phone: local } });
        if (r.status === 'successful') return showSuccess();
        if (r.status === 'failed') return showFailed(r.message);
        showWaiting(local, r.referenceId);
      } catch (err) {
        if (err.status === 409) return showSuccess();
        showForm(err.message);
      }
    };
  }

  function showWaiting(phone, ref) {
    const { op } = detect(phone);
    const started = Date.now();
    body.innerHTML = `
      <div class="pay-state">
        <div class="spinner"></div>
        <h3 style="margin:0 0 6px">Check your phone</h3>
        <p class="muted" style="margin:0 0 14px">We sent a payment request of <b style="color:#fff">${money(movie.price)}</b> to <b style="color:#fff">${esc(phone)}</b>${op ? ` (${OP_NAMES[op]})` : ''}.</p>
        <ol class="steps"><li>Wait for the prompt on your phone</li><li>Enter your mobile money PIN</li><li>The movie unlocks here automatically</li></ol>
        <p class="muted" id="payMsg" style="font-size:13px">Waiting for approval…</p>
        <button class="btn outline sm" id="payCancel">Use a different number</button>
      </div>`;
    $('#payCancel', body).onclick = () => { clearTimeout(pollTimer); showForm(); };

    const poll = async () => {
      if (stopped) return;
      try {
        const r = await api(`/payments/${encodeURIComponent(ref)}`);
        if (r.status === 'successful') return showSuccess();
        if (r.status === 'failed') return showFailed(r.message);
        if (r.message && $('#payMsg', body)) $('#payMsg', body).textContent = r.message;
      } catch { /* network blip, keep polling */ }
      if (Date.now() - started > 3 * 60e3) return showFailed('We did not get your approval in time. If money left your account, it will unlock shortly – check My Library.');
      pollTimer = setTimeout(poll, 3000);
    };
    pollTimer = setTimeout(poll, 2500);
  }

  function showSuccess() {
    body.innerHTML = `
      <div class="pay-state">
        <div class="result-ico ok">✓</div>
        <h3 style="margin:0 0 6px">Payment received!</h3>
        <p class="muted">${preorder
          ? `You're booked for the premiere of ${esc(movie.title)} on ${esc(fmtPremiere(movie.premiereAt))}. It unlocks automatically.`
          : `${esc(movie.title)} is unlocked. Enjoy!`}</p>
        <button class="btn primary block" id="watchNow">${preorder ? 'Done' : '▶ Watch now'}</button>
      </div>`;
    $('#watchNow', body).onclick = () => { close(); onPaid?.(); };
  }

  function showFailed(msg) {
    body.innerHTML = `
      <div class="pay-state">
        <div class="result-ico bad">!</div>
        <h3 style="margin:0 0 6px">Payment not completed</h3>
        <p class="muted">${esc(msg || 'The payment was declined or cancelled.')}</p>
        <button class="btn primary block" id="retry">Try again</button>
      </div>`;
    $('#retry', body).onclick = () => showForm();
  }

  showForm();
}
