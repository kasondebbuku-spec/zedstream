import { api, state, modal, esc, toast, $ } from './core.js';

export function openAuth(mode = 'login', after) {
  const { el, close } = modal(`
    <h2>Welcome to ${esc(state.config.siteName)}</h2>
    <p class="muted" style="margin:0">Sign in to buy movies and keep them on all your devices.</p>
    <div class="tabs"><button data-m="login">Sign in</button><button data-m="register">Create account</button></div>
    <form id="authForm" novalidate>
      <div id="authErr"></div>
      <div class="field reg"><label for="aName">Full name</label><input id="aName" name="name" autocomplete="name" placeholder="e.g. Chanda Mwila"></div>
      <div class="field"><label for="aEmail">Email</label><input id="aEmail" name="email" type="email" autocomplete="email" placeholder="you@example.com" required></div>
      <div class="field reg"><label for="aPhone">Mobile money number <span class="muted">(optional)</span></label><input id="aPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0977 123 456"></div>
      <div class="field"><label for="aPass">Password</label><input id="aPass" name="password" type="password" autocomplete="current-password" required minlength="6"></div>
      <button class="btn primary block" type="submit" id="authBtn">Sign in</button>
    </form>`);

  const setMode = (m) => {
    mode = m;
    el.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.m === m));
    el.querySelectorAll('.reg').forEach((f) => f.classList.toggle('hidden', m !== 'register'));
    $('#authBtn', el).textContent = m === 'login' ? 'Sign in' : 'Create account';
    $('#aPass', el).autocomplete = m === 'login' ? 'current-password' : 'new-password';
    $('#authErr', el).innerHTML = '';
  };
  el.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
  setMode(mode);

  $('#authForm', el).onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    const btn = $('#authBtn', el);
    btn.disabled = true;
    try {
      const { user } = await api(`/auth/${mode}`, { method: 'POST', body });
      state.user = user;
      window.dispatchEvent(new Event('userchange'));
      close();
      toast(mode === 'login' ? `Welcome back, ${user.name.split(' ')[0]}!` : 'Account created. Enjoy!', 'ok');
      after?.();
    } catch (err) {
      $('#authErr', el).innerHTML = `<div class="error">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  };
}

export async function logout() {
  await api('/auth/logout', { method: 'POST' });
  state.user = null;
  window.dispatchEvent(new Event('userchange'));
  location.hash = '#/';
  toast('Signed out');
}
