// Live-streaming platform — zero-dependency Node server.
// Built-ins only: node:http + node:sqlite (Node >= 22.5). Card payments via
// Stripe Checkout when STRIPE_SECRET_KEY is set; without it, orders are
// record-only (no charge).
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Admin passcode. If unset, the whole admin API refuses access (503) —
// there is intentionally no default passcode.
const ADMIN_CODE = process.env.ADMIN_CODE || '';
// Stripe secret key (test key first; live key later). When unset, checkout
// behaves exactly as before — record-only orders, no charge.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
// Test-only override for the Stripe API base (lets a local stub stand in for
// api.stripe.com during verification). Never set in production.
const STRIPE_API_BASE = process.env.STRIPE_API_BASE || 'https://api.stripe.com';
const stripeEnabled = () => !!STRIPE_SECRET_KEY;
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS streams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_name TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  status TEXT NOT NULL DEFAULT 'live',
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id INTEGER NOT NULL,
  author TEXT NOT NULL DEFAULT 'Anonymous',
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  stream_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  stream_id INTEGER,
  buyer TEXT NOT NULL DEFAULT 'Anonymous',
  payment_method TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  last4_or_handle TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id INTEGER NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS viewers (
  stream_id INTEGER NOT NULL,
  peer_id TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (stream_id, peer_id)
);
CREATE TABLE IF NOT EXISTS blocked_channels (
  channel TEXT NOT NULL PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (
  stream_id INTEGER NOT NULL,
  peer_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (stream_id, peer_id)
);
CREATE TABLE IF NOT EXISTS age_tokens (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- Visitor analytics (simple, first-party only — no third-party service).
-- visitors: one row per random visitor cookie (no raw IPs stored anywhere).
-- page_views: one row per HTML page load.
CREATE TABLE IF NOT EXISTS visitors (
  visitor_id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT NOT NULL,
  path TEXT NOT NULL,
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_views_day ON page_views(day);
CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views(path);
`);

// Migration: orders.status (added with the admin panel; placed/cancelled/refunded)
try {
  const cols = db.prepare('PRAGMA table_info(orders)').all();
  if (!cols.some((c) => c.name === 'status')) {
    db.exec("ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'placed'");
  }
} catch { /* column already present */ }

// Migration: orders.stripe_session_id + orders.payment_status (Stripe Checkout)
// payment_status is 'paid' or 'unpaid' for Stripe orders; NULL for older
// record-only orders.
try {
  const cols = db.prepare('PRAGMA table_info(orders)').all();
  if (!cols.some((c) => c.name === 'stripe_session_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN stripe_session_id TEXT DEFAULT NULL');
  }
  if (!cols.some((c) => c.name === 'payment_status')) {
    db.exec('ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT NULL');
  }
} catch { /* columns already present */ }

const now = () => Date.now();
const STALE_MS = 90_000; // signals older than this are ignored
const VIEWER_TTL_MS = 30_000;

function viewerCount(streamId) {
  const row = db.prepare(
    'SELECT COUNT(*) c FROM viewers WHERE stream_id = ? AND last_seen > ?'
  ).get(streamId, now() - VIEWER_TTL_MS);
  return row ? row.c : 0;
}
function likeCount(streamId) {
  const row = db.prepare('SELECT COUNT(*) c FROM likes WHERE stream_id=?').get(streamId);
  return row ? row.c : 0;
}
function withViewers(s) {
  return s ? { ...s, viewer_count: viewerCount(s.id), like_count: likeCount(s.id) } : null;
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
const esc = (s) => String(s ?? '').trim();

// ---- Age verification (18+) ----
// Verification is a random server-issued token stored in the age_tokens
// table and carried in an HttpOnly cookie. Clients cannot forge it by
// setting a flag — protected actions check the token against the DB.
const AGE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  h.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function parseDob(day, month, year) {
  const d = Number(day), m = Number(month), y = Number(year);
  if (!Number.isInteger(d) || !Number.isInteger(m) || !Number.isInteger(y)) return { error: 'Enter a valid date of birth.' };
  if (y < 1900 || y > new Date().getUTCFullYear()) return { error: 'Enter a valid date of birth.' };
  if (m < 1 || m > 12 || d < 1 || d > 31) return { error: 'Enter a valid date of birth.' };
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { error: 'Enter a valid date of birth.' };
  if (dt.getTime() > Date.now()) return { error: 'Date of birth cannot be in the future.' };
  return { date: dt };
}
function ageYears(dobUtc) {
  const t = new Date();
  let age = t.getUTCFullYear() - dobUtc.getUTCFullYear();
  const mDiff = t.getUTCMonth() - dobUtc.getUTCMonth();
  if (mDiff < 0 || (mDiff === 0 && t.getUTCDate() < dobUtc.getUTCDate())) age--;
  return age;
}
function ageVerified(req) {
  const token = parseCookies(req).age_verified;
  if (!token) return false;
  const row = db.prepare('SELECT * FROM age_tokens WHERE token=?').get(token);
  if (!row) return false;
  if (row.expires_at <= now()) {
    db.prepare('DELETE FROM age_tokens WHERE token=?').run(token);
    return false;
  }
  return true;
}
// Returns true when verified; otherwise sends 403 and returns false.
function requireAge(req, res) {
  if (ageVerified(req)) return true;
  sendJson(res, 403, { error: 'Age verification required — you must be 18 or older to use this feature.', code: 'age_required' });
  return false;
}

// ---- Stripe Checkout ----
// Card payments via Stripe's hosted Checkout. No SDK — raw HTTPS calls to
// api.stripe.com with the secret key from the environment only. The key is
// never logged. If STRIPE_SECRET_KEY is unset, the checkout endpoints report
// that card payments are not set up and the old record-only flow is used.
// No webhook in v1: payment is confirmed by retrieving the Checkout Session
// from Stripe after the buyer returns (see /api/checkout/confirm).
function stripeRequest(method, path, params) {
  return new Promise((resolve, reject) => {
    const base = new URL(STRIPE_API_BASE);
    const body = params ? new URLSearchParams(params).toString() : '';
    const lib = base.protocol === 'http:' ? http : https; // http: is test-stub only
    const req = lib.request({
      hostname: base.hostname,
      port: base.port || (base.protocol === 'http:' ? 80 : 443),
      path,
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(STRIPE_SECRET_KEY + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch { /* non-JSON error body */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        reject(new Error((parsed.error && parsed.error.message) || ('Stripe error ' + res.statusCode)));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Stripe request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---- Visitor analytics (first-party only) ----
// Every HTML page load counts as a page view. Unique visitors are identified
// by a random `visitor_id` cookie (1-year expiry) — no raw IP addresses are
// stored anywhere. The write is deferred with setImmediate so it runs after
// the page response has started streaming and can never slow a page down;
// a tracking failure is swallowed so it can never break page serving.
const TRACKED_PAGES = {
  '/': 'home', '/index.html': 'home', '/studio.html': 'studio',
  '/room.html': 'room', '/dashboard.html': 'dashboard', '/admin.html': 'admin',
};
function trackPageView(req, res, file) {
  const label = TRACKED_PAGES[file];
  if (!label) return; // only HTML pages count, not assets (style.css, app.js, …)
  // Health-check probe: the monitor fetches /?health=1 — never count it,
  // or every 15-minute check would look like a new visitor.
  if (new URL(req.url, 'http://x').searchParams.get('health') === '1') return;
  const cookies = parseCookies(req);
  let vid = cookies.visitor_id;
  if (!vid || !/^[0-9a-f]{32}$/.test(vid)) {
    vid = crypto.randomBytes(16).toString('hex');
    const cookie = `visitor_id=${vid}; Path=/; Max-Age=31536000; SameSite=Lax`;
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
  }
  const day = new Date().toISOString().slice(0, 10); // UTC day
  const ts = now();
  setImmediate(() => {
    try {
      db.prepare('INSERT OR IGNORE INTO visitors (visitor_id, first_seen, last_seen) VALUES (?,?,?)').run(vid, ts, ts);
      db.prepare('UPDATE visitors SET last_seen=? WHERE visitor_id=?').run(ts, vid);
      db.prepare('INSERT INTO page_views (visitor_id, path, day, created_at) VALUES (?,?,?,?)').run(vid, label, day, ts);
    } catch { /* analytics must never break the site */ }
  });
}
function analyticsSummary() {
  const total = db.prepare('SELECT COUNT(*) c FROM page_views').get().c;
  const uniques = db.prepare('SELECT COUNT(*) c FROM visitors').get().c;
  const today = new Date().toISOString().slice(0, 10);
  const visitsToday = db.prepare('SELECT COUNT(*) c FROM page_views WHERE day=?').get(today).c;
  const perPage = db.prepare('SELECT path, COUNT(*) AS views FROM page_views GROUP BY path ORDER BY views DESC').all();
  const perDay = db.prepare(
    "SELECT day, COUNT(*) AS views FROM page_views WHERE day >= date('now','-29 days') GROUP BY day ORDER BY day DESC"
  ).all();
  return { total_visits: total, unique_visitors: uniques, visits_today: visitsToday, per_page: perPage, per_day: perDay };
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;

    // ---- Static files ----
    if (req.method === 'GET' && !p.startsWith('/api/')) {
      let file = p === '/' ? '/index.html' : p;
      const fp = path.join(__dirname, 'public', decodeURIComponent(file));
      if (!fp.startsWith(path.join(__dirname, 'public'))) return sendJson(res, 403, { error: 'forbidden' });
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        trackPageView(req, res, file);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
        return fs.createReadStream(fp).pipe(res);
      }
      return sendJson(res, 404, { error: 'not found' });
    }

    // ---- API ----
    if (p === '/api/health') return sendJson(res, 200, { ok: true, time: now() });

    // ---- Age verification (18+) ----
    if (p === '/api/age/verify' && req.method === 'POST') {
      const b = await readBody(req);
      const parsed = parseDob(b.day, b.month, b.year);
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      if (ageYears(parsed.date) < 18) {
        return sendJson(res, 403, { error: 'You must be 18 or older to use this site.', code: 'underage' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = now() + AGE_TTL_MS;
      db.prepare('INSERT INTO age_tokens (token, created_at, expires_at) VALUES (?,?,?)').run(token, now(), expiresAt);
      db.prepare('DELETE FROM age_tokens WHERE expires_at<=?').run(now());
      res.setHeader('Set-Cookie', `age_verified=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(AGE_TTL_MS / 1000)}; SameSite=Lax`);
      return sendJson(res, 200, { verified: true, expires_at: expiresAt });
    }
    if (p === '/api/age/status' && req.method === 'GET') {
      return sendJson(res, 200, { verified: ageVerified(req) });
    }

    // ---- Admin (passcode-gated; no ADMIN_CODE set => admin disabled) ----
    if (p.startsWith('/api/admin/')) {
      if (!ADMIN_CODE) return sendJson(res, 503, { error: 'admin is not configured' });
      if (req.headers['x-admin-code'] !== ADMIN_CODE) return sendJson(res, 401, { error: 'invalid admin code' });

      if (p === '/api/admin/auth' && req.method === 'GET') return sendJson(res, 200, { ok: true });

      if (p === '/api/admin/stats' && req.method === 'GET') {
        const live = db.prepare("SELECT COUNT(*) c FROM streams WHERE status='live'").get().c;
        const totalStreams = db.prepare('SELECT COUNT(*) c FROM streams').get().c;
        const channels = db.prepare('SELECT COUNT(DISTINCT channel_name) c FROM streams').get().c;
        const blocked = db.prepare('SELECT COUNT(*) c FROM blocked_channels').get().c;
        const listings = db.prepare('SELECT COUNT(*) c FROM products').get().c;
        const orders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
        const cancelled = db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('cancelled','refunded')").get().c;
        const revenue = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM orders WHERE status='placed'").get().s;
        const viewers = db.prepare('SELECT COUNT(*) c FROM viewers WHERE last_seen>?').get(now() - VIEWER_TTL_MS).c;
        return sendJson(res, 200, {
          live_streams: live, total_streams: totalStreams, channels, blocked_channels: blocked,
          products: listings, orders, cancelled_orders: cancelled, revenue: Number(revenue), viewers,
          ...analyticsSummary(),
        });
      }

      // Live streams: list / end / remove
      if (p === '/api/admin/streams' && req.method === 'GET') {
        const status = u.searchParams.get('status') || 'live';
        const rows = db.prepare('SELECT * FROM streams WHERE status=? ORDER BY created_at DESC').all(status);
        return sendJson(res, 200, rows.map(withViewers));
      }
      const adminEndMatch = p.match(/^\/api\/admin\/streams\/(\d+)\/end$/);
      if (adminEndMatch && req.method === 'POST') {
        const id = Number(adminEndMatch[1]);
        db.prepare('UPDATE streams SET status=?, ended_at=? WHERE id=?').run('ended', now(), id);
        db.prepare('DELETE FROM signals WHERE stream_id=?').run(id);
        db.prepare('DELETE FROM viewers WHERE stream_id=?').run(id);
        const s = db.prepare('SELECT * FROM streams WHERE id=?').get(id);
        return s ? sendJson(res, 200, withViewers(s)) : sendJson(res, 404, { error: 'stream not found' });
      }
      const adminDelStream = p.match(/^\/api\/admin\/streams\/(\d+)$/);
      if (adminDelStream && req.method === 'DELETE') {
        const id = Number(adminDelStream[1]);
        const s = db.prepare('SELECT * FROM streams WHERE id=?').get(id);
        if (!s) return sendJson(res, 404, { error: 'stream not found' });
        db.prepare('DELETE FROM chat_messages WHERE stream_id=?').run(id);
        db.prepare('DELETE FROM signals WHERE stream_id=?').run(id);
        db.prepare('DELETE FROM viewers WHERE stream_id=?').run(id);
        db.prepare('UPDATE products SET stream_id=NULL WHERE stream_id=?').run(id);
        db.prepare('DELETE FROM streams WHERE id=?').run(id);
        return sendJson(res, 200, { ok: true });
      }

      // Chat moderation: recent messages across streams / delete one
      if (p === '/api/admin/chat' && req.method === 'GET') {
        const limit = Math.min(200, Math.max(1, parseInt(u.searchParams.get('limit') || '100', 10) || 100));
        const rows = db.prepare(
          'SELECT cm.*, s.title AS stream_title, s.channel_name FROM chat_messages cm LEFT JOIN streams s ON s.id=cm.stream_id ORDER BY cm.id DESC LIMIT ?'
        ).all(limit);
        return sendJson(res, 200, rows);
      }
      const adminDelChat = p.match(/^\/api\/admin\/chat\/(\d+)$/);
      if (adminDelChat && req.method === 'DELETE') {
        db.prepare('DELETE FROM chat_messages WHERE id=?').run(adminDelChat[1]);
        return sendJson(res, 200, { ok: true });
      }

      // Products: list / remove
      if (p === '/api/admin/products' && req.method === 'GET') {
        return sendJson(res, 200, db.prepare('SELECT * FROM products ORDER BY created_at DESC').all());
      }
      const adminDelProduct = p.match(/^\/api\/admin\/products\/(\d+)$/);
      if (adminDelProduct && req.method === 'DELETE') {
        db.prepare('DELETE FROM products WHERE id=?').run(adminDelProduct[1]);
        return sendJson(res, 200, { ok: true });
      }

      // Orders: list / mark cancelled or refunded (record only — no money moves)
      if (p === '/api/admin/orders' && req.method === 'GET') {
        const rows = db.prepare(
          'SELECT o.*, pr.name AS product_name FROM orders o LEFT JOIN products pr ON pr.id=o.product_id ORDER BY o.created_at DESC LIMIT 200'
        ).all();
        return sendJson(res, 200, rows);
      }
      const adminOrderStatus = p.match(/^\/api\/admin\/orders\/(\d+)\/status$/);
      if (adminOrderStatus && req.method === 'POST') {
        const b = await readBody(req);
        const status = esc(b.status);
        if (!['placed', 'cancelled', 'refunded'].includes(status)) {
          return sendJson(res, 400, { error: 'status must be placed, cancelled or refunded' });
        }
        const o = db.prepare('SELECT * FROM orders WHERE id=?').get(adminOrderStatus[1]);
        if (!o) return sendJson(res, 404, { error: 'order not found' });
        db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, o.id);
        return sendJson(res, 200, db.prepare('SELECT * FROM orders WHERE id=?').get(o.id));
      }

      // Channels: list / block / unblock (blocking ends their live streams at once)
      if (p === '/api/admin/channels' && req.method === 'GET') {
        const rows = db.prepare(
          `SELECT channel_name, COUNT(*) AS streams, SUM(CASE WHEN status='live' THEN 1 ELSE 0 END) AS live_streams,
           EXISTS(SELECT 1 FROM blocked_channels bc WHERE LOWER(bc.channel)=LOWER(streams.channel_name)) AS blocked
           FROM streams GROUP BY channel_name ORDER BY streams DESC`
        ).all();
        const blockedOnly = db.prepare(
          `SELECT channel AS channel_name, 0 AS streams, 0 AS live_streams, 1 AS blocked FROM blocked_channels
           WHERE LOWER(channel) NOT IN (SELECT LOWER(channel_name) FROM streams)`
        ).all();
        return sendJson(res, 200, [...rows, ...blockedOnly]);
      }
      if (p === '/api/admin/channels/block' && req.method === 'POST') {
        const b = await readBody(req);
        if (!esc(b.channel)) return sendJson(res, 400, { error: 'channel is required' });
        const channel = esc(b.channel);
        db.prepare('INSERT OR IGNORE INTO blocked_channels (channel, created_at) VALUES (?,?)').run(channel, now());
        const live = db.prepare("SELECT id FROM streams WHERE LOWER(channel_name)=LOWER(?) AND status='live'").all(channel);
        for (const s of live) {
          db.prepare('UPDATE streams SET status=?, ended_at=? WHERE id=?').run('ended', now(), s.id);
          db.prepare('DELETE FROM signals WHERE stream_id=?').run(s.id);
          db.prepare('DELETE FROM viewers WHERE stream_id=?').run(s.id);
        }
        return sendJson(res, 200, { ok: true, channel, ended_streams: live.length });
      }
      if (p === '/api/admin/channels/unblock' && req.method === 'POST') {
        const b = await readBody(req);
        if (!esc(b.channel)) return sendJson(res, 400, { error: 'channel is required' });
        db.prepare('DELETE FROM blocked_channels WHERE LOWER(channel)=LOWER(?)').run(esc(b.channel));
        return sendJson(res, 200, { ok: true, channel: esc(b.channel) });
      }

      return sendJson(res, 404, { error: 'unknown admin route' });
    }

    // Streams
    if (p === '/api/streams' && req.method === 'GET') {
      const status = u.searchParams.get('status');
      const category = u.searchParams.get('category');
      const q = (u.searchParams.get('q') || '').toLowerCase();
      let rows = db.prepare('SELECT * FROM streams ORDER BY created_at DESC').all();
      if (status) rows = rows.filter((r) => r.status === status);
      if (category && category !== 'All') rows = rows.filter((r) => r.category === category);
      if (q) rows = rows.filter((r) => (r.title + ' ' + r.channel_name).toLowerCase().includes(q));
      return sendJson(res, 200, rows.map(withViewers));
    }
    if (p === '/api/streams' && req.method === 'POST') {
      if (!requireAge(req, res)) return;
      const b = await readBody(req);
      if (!esc(b.channel_name) || !esc(b.title)) return sendJson(res, 400, { error: 'channel_name and title are required' });
      const blocked = db.prepare('SELECT 1 FROM blocked_channels WHERE LOWER(channel)=LOWER(?)').get(esc(b.channel_name));
      if (blocked) return sendJson(res, 403, { error: 'this channel is blocked from going live' });
      const r = db.prepare('INSERT INTO streams (channel_name,title,category,status,created_at) VALUES (?,?,?,?,?)')
        .run(esc(b.channel_name), esc(b.title), esc(b.category) || 'Other', 'live', now());
      return sendJson(res, 201, withViewers(db.prepare('SELECT * FROM streams WHERE id=?').get(r.lastInsertRowid)));
    }
    const streamMatch = p.match(/^\/api\/streams\/(\d+)$/);
    if (streamMatch && req.method === 'GET') {
      const s = db.prepare('SELECT * FROM streams WHERE id=?').get(streamMatch[1]);
      return s ? sendJson(res, 200, withViewers(s)) : sendJson(res, 404, { error: 'stream not found' });
    }
    const endMatch = p.match(/^\/api\/streams\/(\d+)\/end$/);
    if (endMatch && req.method === 'POST') {
      const id = Number(endMatch[1]);
      db.prepare('UPDATE streams SET status=?, ended_at=? WHERE id=?').run('ended', now(), id);
      db.prepare('DELETE FROM signals WHERE stream_id=?').run(id);
      db.prepare('DELETE FROM viewers WHERE stream_id=?').run(id);
      const s = db.prepare('SELECT * FROM streams WHERE id=?').get(id);
      return s ? sendJson(res, 200, withViewers(s)) : sendJson(res, 404, { error: 'stream not found' });
    }
    const hbMatch = p.match(/^\/api\/streams\/(\d+)\/heartbeat$/);
    if (hbMatch && req.method === 'POST') {
      const b = await readBody(req);
      const peer = esc(b.peer_id) || 'anon';
      const id = Number(hbMatch[1]);
      const s = db.prepare('SELECT * FROM streams WHERE id=?').get(id);
      if (!s) return sendJson(res, 404, { error: 'stream not found' });
      db.prepare('INSERT INTO viewers (stream_id, peer_id, last_seen) VALUES (?,?,?) ON CONFLICT(stream_id, peer_id) DO UPDATE SET last_seen=excluded.last_seen')
        .run(id, peer, now());
      return sendJson(res, 200, { viewer_count: viewerCount(id) });
    }

    // Chat
    const chatMatch = p.match(/^\/api\/streams\/(\d+)\/chat$/);
    if (chatMatch && req.method === 'GET') {
      const rows = db.prepare('SELECT * FROM chat_messages WHERE stream_id=? ORDER BY id ASC LIMIT 200').all(chatMatch[1]);
      return sendJson(res, 200, rows);
    }
    if (chatMatch && req.method === 'POST') {
      if (!requireAge(req, res)) return;
      const b = await readBody(req);
      if (!esc(b.text)) return sendJson(res, 400, { error: 'text is required' });
      const r = db.prepare('INSERT INTO chat_messages (stream_id, author, text, created_at) VALUES (?,?,?,?)')
        .run(chatMatch[1], esc(b.author) || 'Anonymous', esc(b.text).slice(0, 500), now());
      return sendJson(res, 201, db.prepare('SELECT * FROM chat_messages WHERE id=?').get(r.lastInsertRowid));
    }

    // Products
    if (p === '/api/products' && req.method === 'GET') {
      const sid = u.searchParams.get('stream_id');
      const rows = sid
        ? db.prepare('SELECT * FROM products WHERE stream_id=? ORDER BY created_at DESC').all(sid)
        : db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
      return sendJson(res, 200, rows);
    }
    if (p === '/api/products' && req.method === 'POST') {
      if (!requireAge(req, res)) return;
      const b = await readBody(req);
      if (!esc(b.name) || !(Number(b.price) > 0)) return sendJson(res, 400, { error: 'name and a price > 0 are required' });
      const stock = Math.max(0, parseInt(b.stock, 10) || 0);
      const r = db.prepare('INSERT INTO products (name, price, stock, stream_id, created_at) VALUES (?,?,?,?,?)')
        .run(esc(b.name), Number(b.price), stock, b.stream_id ? Number(b.stream_id) : null, now());
      return sendJson(res, 201, db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid));
    }

    // Orders
    if (p === '/api/orders' && req.method === 'GET') {
      const rows = db.prepare(
        `SELECT o.*, pr.name AS product_name FROM orders o LEFT JOIN products pr ON pr.id=o.product_id ORDER BY o.created_at DESC LIMIT 200`
      ).all();
      return sendJson(res, 200, rows);
    }
    if (p === '/api/orders' && req.method === 'POST') {
      if (!requireAge(req, res)) return;
      const b = await readBody(req);
      const product = db.prepare('SELECT * FROM products WHERE id=?').get(b.product_id);
      if (!product) return sendJson(res, 404, { error: 'product not found' });
      if (product.stock <= 0) return sendJson(res, 400, { error: 'out of stock' });
      if (!esc(b.payment_method)) return sendJson(res, 400, { error: 'payment_method is required' });
      const method = esc(b.payment_method).slice(0, 120);
      db.exec('BEGIN IMMEDIATE');
      let order;
      try {
        db.prepare('UPDATE products SET stock = stock - 1 WHERE id=? AND stock > 0').run(product.id);
        const r = db.prepare('INSERT INTO orders (product_id, stream_id, buyer, payment_method, amount, created_at) VALUES (?,?,?,?,?,?)')
          .run(product.id, b.stream_id ? Number(b.stream_id) : product.stream_id, esc(b.buyer) || 'Anonymous', method, product.price, now());
        order = db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return sendJson(res, 201, { ...order, product_name: product.name, remaining_stock: product.stock - 1 });
    }

    // Stripe Checkout: config + create session + confirm payment.
    // The order is created unpaid when the Checkout Session is made, and
    // only marked paid after the session is retrieved from Stripe and
    // reports payment_status 'paid'. URL params are never trusted alone.
    if (p === '/api/checkout/config' && req.method === 'GET') {
      return sendJson(res, 200, { stripe_enabled: stripeEnabled() });
    }
    if (p === '/api/checkout' && req.method === 'POST') {
      if (!requireAge(req, res)) return;
      const b = await readBody(req);
      const product = db.prepare('SELECT * FROM products WHERE id=?').get(b.product_id);
      if (!product) return sendJson(res, 404, { error: 'product not found' });
      if (product.stock <= 0) return sendJson(res, 400, { error: 'out of stock' });
      if (!stripeEnabled()) return sendJson(res, 503, { error: 'Card payments are not set up yet.', stripe_enabled: false });
      const streamId = b.stream_id ? Number(b.stream_id) : product.stream_id;
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers.host || `localhost:${PORT}`;
      const base = `${proto}://${host}`;
      const returnBase = streamId ? `/room.html?id=${streamId}` : '/dashboard.html';
      const sep = streamId ? '&' : '?';
      let session;
      try {
        session = await stripeRequest('POST', '/v1/checkout/sessions', {
          mode: 'payment',
          'line_items[0][price_data][currency]': 'usd',
          'line_items[0][price_data][product_data][name]': product.name,
          'line_items[0][price_data][unit_amount]': String(Math.round(Number(product.price) * 100)),
          'line_items[0][quantity]': '1',
          success_url: `${base}${returnBase}${sep}checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${base}${returnBase}${sep}checkout=cancelled`,
        });
      } catch (e) {
        return sendJson(res, 502, { error: 'Could not start secure checkout: ' + e.message });
      }
      if (!session || !session.id || !session.url) return sendJson(res, 502, { error: 'Could not start secure checkout.' });
      db.exec('BEGIN IMMEDIATE');
      let order;
      try {
        const upd = db.prepare('UPDATE products SET stock = stock - 1 WHERE id=? AND stock > 0').run(product.id);
        if (upd.changes === 0) { db.exec('ROLLBACK'); return sendJson(res, 400, { error: 'out of stock' }); }
        const r = db.prepare('INSERT INTO orders (product_id, stream_id, buyer, payment_method, amount, stripe_session_id, payment_status, created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(product.id, streamId || null, esc(b.buyer) || 'Anonymous', 'Stripe', product.price, session.id, 'unpaid', now());
        order = db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return sendJson(res, 201, { url: session.url, session_id: session.id, order_id: order.id });
    }
    if (p === '/api/checkout/confirm' && req.method === 'GET') {
      if (!requireAge(req, res)) return;
      const sessionId = u.searchParams.get('session_id') || '';
      if (!sessionId) return sendJson(res, 400, { error: 'session_id is required' });
      if (!stripeEnabled()) return sendJson(res, 503, { error: 'Card payments are not set up yet.', stripe_enabled: false });
      const order = db.prepare('SELECT * FROM orders WHERE stripe_session_id=?').get(sessionId);
      if (!order) return sendJson(res, 404, { error: 'order not found for this checkout session' });
      let session;
      try {
        session = await stripeRequest('GET', '/v1/checkout/sessions/' + encodeURIComponent(sessionId));
      } catch (e) {
        return sendJson(res, 502, { error: 'Could not verify payment with Stripe: ' + e.message });
      }
      const paid = session && session.payment_status === 'paid';
      if (paid && order.payment_status !== 'paid') {
        db.prepare("UPDATE orders SET payment_status='paid' WHERE id=?").run(order.id);
      }
      const updated = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
      return sendJson(res, 200, { paid, payment_status: session.payment_status || 'unknown', order: updated });
    }

    // Payment methods (store label + last-4/handle only — never full numbers)
    if (p === '/api/payment-methods' && req.method === 'GET') {
      return sendJson(res, 200, db.prepare('SELECT * FROM payment_methods ORDER BY is_default DESC, created_at DESC').all());
    }
    if (p === '/api/payment-methods' && req.method === 'POST') {
      const b = await readBody(req);
      if (!esc(b.label) || !esc(b.kind)) return sendJson(res, 400, { error: 'label and kind are required' });
      const count = db.prepare('SELECT COUNT(*) c FROM payment_methods').get().c;
      const r = db.prepare('INSERT INTO payment_methods (label, kind, last4_or_handle, is_default, created_at) VALUES (?,?,?,?,?)')
        .run(esc(b.label), esc(b.kind), esc(b.last4_or_handle).slice(0, 40), count === 0 ? 1 : 0, now());
      return sendJson(res, 201, db.prepare('SELECT * FROM payment_methods WHERE id=?').get(r.lastInsertRowid));
    }
    const defMatch = p.match(/^\/api\/payment-methods\/(\d+)\/default$/);
    if (defMatch && req.method === 'POST') {
      db.prepare('UPDATE payment_methods SET is_default=0').run();
      db.prepare('UPDATE payment_methods SET is_default=1 WHERE id=?').run(defMatch[1]);
      return sendJson(res, 200, db.prepare('SELECT * FROM payment_methods WHERE id=?').get(defMatch[1]) || {});
    }
    const pmMatch = p.match(/^\/api\/payment-methods\/(\d+)$/);
    if (pmMatch && req.method === 'DELETE') {
      db.prepare('DELETE FROM payment_methods WHERE id=?').run(pmMatch[1]);
      return sendJson(res, 200, { ok: true });
    }

    // Follows
    if (p === '/api/follows' && req.method === 'GET') {
      return sendJson(res, 200, db.prepare('SELECT * FROM follows ORDER BY created_at DESC').all());
    }
    if (p === '/api/follows' && req.method === 'POST') {
      const b = await readBody(req);
      if (!esc(b.channel)) return sendJson(res, 400, { error: 'channel is required' });
      db.prepare('INSERT OR IGNORE INTO follows (channel, created_at) VALUES (?,?)').run(esc(b.channel), now());
      return sendJson(res, 201, { channel: esc(b.channel), followed: true });
    }
    if (p === '/api/follows' && req.method === 'DELETE') {
      const ch = u.searchParams.get('channel');
      if (ch) db.prepare('DELETE FROM follows WHERE channel=?').run(ch);
      return sendJson(res, 200, { ok: true });
    }

    // Signals (WebRTC signaling via HTTP polling; addressed delivery only)
    if (p === '/api/signals' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.stream_id || !esc(b.from_id) || !esc(b.to_id) || !esc(b.type)) {
        return sendJson(res, 400, { error: 'stream_id, from_id, to_id and type are required' });
      }
      const s = db.prepare('SELECT * FROM streams WHERE id=?').get(b.stream_id);
      if (!s || s.status !== 'live') return sendJson(res, 400, { error: 'stream is not live' });
      const r = db.prepare('INSERT INTO signals (stream_id, from_id, to_id, type, payload, created_at) VALUES (?,?,?,?,?,?)')
        .run(Number(b.stream_id), esc(b.from_id), esc(b.to_id), esc(b.type), JSON.stringify(b.payload ?? {}), now());
      return sendJson(res, 201, { id: r.lastInsertRowid });
    }
    if (p === '/api/signals' && req.method === 'GET') {
      const streamId = u.searchParams.get('streamId');
      const peerId = u.searchParams.get('peerId');
      const since = Number(u.searchParams.get('since') || 0);
      if (!streamId || !peerId) return sendJson(res, 400, { error: 'streamId and peerId are required' });
      // Only signals addressed to this peer, newer than `since`, and not stale (>90s old).
      const rows = db.prepare(
        'SELECT * FROM signals WHERE stream_id=? AND to_id=? AND id>? AND created_at>? ORDER BY id ASC LIMIT 100'
      ).all(Number(streamId), peerId, since, now() - STALE_MS);
      return sendJson(res, 200, rows.map((r) => ({ ...r, payload: JSON.parse(r.payload || '{}') })));
    }

    // Dashboard stats
    if (p === '/api/stats' && req.method === 'GET') {
      const live = db.prepare("SELECT COUNT(*) c FROM streams WHERE status='live'").get().c;
      const totalStreams = db.prepare('SELECT COUNT(*) c FROM streams').get().c;
      const listings = db.prepare('SELECT COUNT(*) c FROM products').get().c;
      const orders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
      const revenue = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM orders').get().s;
      const follows = db.prepare('SELECT COUNT(*) c FROM follows').get().c;
      const viewers = db.prepare('SELECT COUNT(*) c FROM viewers WHERE last_seen>?').get(now() - VIEWER_TTL_MS).c;
      return sendJson(res, 200, {
        live_streams: live, total_streams: totalStreams, viewers, listings,
        orders_received: orders, purchases: orders, revenue: Number(revenue), follows,
        ...analyticsSummary(),
      });
    }

    // Visitor analytics: totals + per-page and per-day breakdown (last 30 days)
    if (p === '/api/analytics' && req.method === 'GET') {
      return sendJson(res, 200, analyticsSummary());
    }

    // Public activity feed: recent chat messages + orders across streams
    if (p === '/api/activity' && req.method === 'GET') {
      const limit = Math.min(50, Math.max(1, parseInt(u.searchParams.get('limit') || '20', 10) || 20));
      const rows = db.prepare(
        `SELECT * FROM (
           SELECT 'chat' AS kind, cm.id AS ref_id, cm.author AS actor, cm.text AS detail, cm.created_at, s.title AS stream_title, s.channel_name
           FROM chat_messages cm LEFT JOIN streams s ON s.id=cm.stream_id
           UNION ALL
           SELECT 'order' AS kind, o.id AS ref_id, o.buyer AS actor, pr.name AS detail, o.created_at, s.title AS stream_title, s.channel_name
           FROM orders o LEFT JOIN products pr ON pr.id=o.product_id LEFT JOIN streams s ON s.id=o.stream_id
         ) ORDER BY created_at DESC LIMIT ?`
      ).all(limit);
      return sendJson(res, 200, rows);
    }

    // Likes (reactions) on a stream — toggle per viewer
    const likeMatch = p.match(/^\/api\/streams\/(\d+)\/like$/);
    if (likeMatch && req.method === 'POST') {
      const b = await readBody(req);
      const peer = esc(b.peer_id) || 'anon';
      const id = Number(likeMatch[1]);
      const s = db.prepare('SELECT * FROM streams WHERE id=?').get(id);
      if (!s) return sendJson(res, 404, { error: 'stream not found' });
      const existing = db.prepare('SELECT 1 FROM likes WHERE stream_id=? AND peer_id=?').get(id, peer);
      if (existing) db.prepare('DELETE FROM likes WHERE stream_id=? AND peer_id=?').run(id, peer);
      else db.prepare('INSERT INTO likes (stream_id, peer_id, created_at) VALUES (?,?,?)').run(id, peer, now());
      return sendJson(res, 200, { liked: !existing, likes: likeCount(id) });
    }
    if (likeMatch && req.method === 'GET') {
      const peer = u.searchParams.get('peer_id') || 'anon';
      const id = Number(likeMatch[1]);
      const s = db.prepare('SELECT * FROM streams WHERE id=?').get(id);
      if (!s) return sendJson(res, 404, { error: 'stream not found' });
      const liked = !!db.prepare('SELECT 1 FROM likes WHERE stream_id=? AND peer_id=?').get(id, peer);
      return sendJson(res, 200, { likes: likeCount(id), liked });
    }

    return sendJson(res, 404, { error: 'unknown route' });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Live-streaming platform running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Data: ${path.join(DATA_DIR, 'app.db')}`);
});
