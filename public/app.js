/* ---- Installable app (PWA) ---- */
// Registers the service worker, which caches only the static app shell
// (HTML/CSS/JS/icons). API calls, chat, live signalling and the age gate
// always go to the network — the worker never caches them.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

async function api(path, opts) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 403 && d.code === 'age_required') {
      ageForget();
      showAgeGate();
      throw new Error('Age verification required — you must be 18 or older.');
    }
    throw new Error(d.error || ('HTTP ' + r.status));
  }
  return d;
}
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function viewerId() {
  let id = localStorage.getItem('viewer_id');
  if (!id) { id = 'v-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); localStorage.setItem('viewer_id', id); }
  return id;
}
function displayName() {
  let n = localStorage.getItem('display_name');
  if (!n) { n = 'Guest-' + Math.floor(Math.random() * 900 + 100); localStorage.setItem('display_name', n); }
  return n;
}
const CATEGORIES = ['Gaming', 'Music', 'Shopping', 'Talk', 'Sports', 'Cooking', 'Other'];
const ONE_TIME_METHODS = ['Card', 'PayPal', 'Apple Pay', 'Google Pay', 'Cash App', 'Bank transfer'];

/* ---- Toast notifications ---- */
function ensureToastRoot() {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    document.body.appendChild(root);
  }
  return root;
}
function toast(message, type = 'ok', ms = 3200) {
  const root = ensureToastRoot();
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/* ---- Active nav highlight ---- */
(function markActiveNav() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  document.querySelectorAll('header nav a').forEach(a => {
    const href = a.getAttribute('href') || '';
    const normalized = href.replace(/\/$/, '') || '/';
    if (normalized === path || (path === '/' && href === '/')) a.classList.add('active');
    else if (path.endsWith(href) && href !== '/') a.classList.add('active');
  });
})();

// ---- Age verification (18+) ----
const AGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AGE_KEY = 'age_verified_until';
function ageStoredValid() {
  try { return Number(localStorage.getItem(AGE_KEY) || 0) > Date.now(); } catch (e) { return false; }
}
function ageRemember() {
  try { localStorage.setItem(AGE_KEY, String(Date.now() + AGE_TTL_MS)); } catch (e) {}
}
function ageForget() {
  try { localStorage.removeItem(AGE_KEY); } catch (e) {}
}
function dobAge(d, m, y) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  const t = new Date();
  let age = t.getUTCFullYear() - y;
  const md = t.getUTCMonth() - (m - 1);
  if (md < 0 || (md === 0 && t.getUTCDate() < d)) age--;
  return age;
}
function buildAgeGate() {
  let el = document.getElementById('ageGate');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'ageGate';
  el.className = 'age-gate';
  el.innerHTML = `<div class="age-box">
    <h2>🔞 You must be 18 or older</h2>
    <p>This site is for adults only. Enter your date of birth to continue.</p>
    <div class="row">
      <input id="dobDay" type="number" min="1" max="31" placeholder="Day" inputmode="numeric">
      <input id="dobMonth" type="number" min="1" max="12" placeholder="Month" inputmode="numeric">
      <input id="dobYear" type="number" min="1900" max="2100" placeholder="Year" inputmode="numeric">
    </div>
    <button id="ageVerifyBtn">Verify I'm 18 or older</button>
    <p id="ageErr" class="warn"></p>
    <p class="note">No ID upload, no account — your date of birth is only used to check your age, and it is not stored.</p>
  </div>`;
  document.body.appendChild(el);
  document.getElementById('ageVerifyBtn').onclick = submitAge;
  ['dobDay', 'dobMonth', 'dobYear'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') submitAge(); });
  });
  return el;
}
function showAgeGate() {
  const el = buildAgeGate();
  el.style.display = 'flex';
}
function hideAgeGate() {
  const el = document.getElementById('ageGate');
  if (el) el.remove();
}
function showAgeBlocked() {
  const box = document.querySelector('#ageGate .age-box');
  if (box) box.innerHTML = `<h2>Sorry — 18+ only</h2><p>You must be 18 or older to use this site.</p><p class="note">This is an adults-only live-streaming platform.</p>`;
}
async function submitAge() {
  const d = parseInt(document.getElementById('dobDay').value, 10);
  const m = parseInt(document.getElementById('dobMonth').value, 10);
  const y = parseInt(document.getElementById('dobYear').value, 10);
  const err = document.getElementById('ageErr');
  if (!err) return;
  const age = dobAge(d, m, y);
  if (age === null || y < 1900) { err.textContent = 'Enter a valid date of birth.'; return; }
  if (age < 18) { showAgeBlocked(); return; }
  err.textContent = '';
  try {
    const r = await fetch('/api/age/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day: d, month: m, year: y }) });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.verified) { ageRemember(); hideAgeGate(); toast('Welcome — age verified', 'ok'); return; }
    if (data.code === 'underage') { showAgeBlocked(); return; }
    err.textContent = data.error || 'Verification failed — try again.';
  } catch (e) { err.textContent = 'Could not reach the server — try again.'; }
}
async function checkAgeGate() {
  if (location.pathname === '/admin.html') return;
  if (ageStoredValid()) return;
  showAgeGate();
  try {
    const r = await fetch('/api/age/status');
    const d = await r.json().catch(() => ({}));
    if (d.verified) { ageRemember(); hideAgeGate(); }
  } catch (e) { /* server unreachable — gate stays up */ }
}
checkAgeGate();
