# LiveStream — live-streaming platform

A standalone live-streaming platform: discover feed, studio (go live with your
camera), stream rooms with live video, chat, follows and shopping, a dashboard
with stats and payment options, and checkout. No real payment processing
anywhere — orders only record the payment method chosen in-app.

## Stack

- **Server:** Node.js 24, zero dependencies (built-in `node:http` + `node:sqlite`).
  No build step, no native modules.
- **Persistence:** SQLite file at `data/app.db` (override with `DATA_DIR`).
  Survives restarts; on Fly.io it lives on a persistent volume.
- **Live video:** WebRTC peer-to-peer (one connection per viewer), public STUN
  `stun:stun.l.google.com:19302`, **no TURN server**. Signaling is HTTP polling
  (`POST /api/signals`, `GET /api/signals?streamId=…&peerId=…&since=…`),
  addressed to a specific peer, stored in SQLite, stale signals (>90s) ignored,
  and cleared when a stream ends.
- **Frontend:** plain HTML/CSS/JS served by the same server.

## Run locally

```bash
npm install   # zero dependencies — installs nothing, just validates package.json
npm start
```

Then open http://localhost:3000

- `/` — Discover: a TikTok-style vertical feed (see below)
- `/studio.html` — set a channel, preview camera, go live, monitor chat/sales, end stream
- `/room.html?id=<stream id>` — watch, chat, follow, shop, checkout
- `/dashboard.html` — stats, listings, orders, payment options, stream history
- `/admin.html` — passcode-protected admin panel (see below)

Port: `PORT` env var (default 3000).

## Discover feed (TikTok meets Facebook)

The Discover page is a vertical full-screen feed: one live stream fills the
screen, and scrolling/swiping moves to the next. The stream playing on screen
connects as a viewer over WebRTC (same as a room); scrolling away disconnects
it. Each slide overlays the creator's name, title, category and viewer count
at the bottom, with Like / Comment / Share / Follow stacked on the right edge:

- **Like** — a real reaction, stored per viewer (`likes` table) and counted on
  the slide.
- **Comment** — opens a bottom sheet with that stream's live chat; posting
  from the sheet posts to the stream's chat.
- **Share** — copies the stream room's link.
- **Follow** — follows/unfollows the channel.

Above the feed is a stories-style row of live channels (tap one to jump to
its stream). Below the feed is a Facebook-style browse section: products for
sale ("Shop the feed"), recent activity (latest chat and purchases), and ended
streams. Search and category filters still filter the live feed.

## Admin panel

`/admin.html` — moderation for the site owner, linked from the Dashboard:

- **Overview:** live streams, total streams, channels, blocked channels,
  viewers now, products, orders, cancelled/refunded orders, revenue from
  active orders.
- **Live streams:** end a stream or remove it (with its chat history).
- **Chat moderation:** latest messages across all streams, delete any message.
- **Products:** list all listings, remove any listing.
- **Orders:** list all orders, mark one cancelled or refunded. This only
  changes the order's record — no money moves anywhere in this app, and stock
  is not restored.
- **Channels:** list channels with stream counts, block a channel (any of its
  live streams end immediately, and it gets a 403 if it tries to go live
  again) or unblock it. Orders carry a `status` (`placed` / `cancelled` /
  `refunded`).

Access is gated by a passcode, sent as the `x-admin-code` header on every
admin request (`/api/admin/*`). Set it with the `ADMIN_CODE` environment
variable before starting the server:

```bash
ADMIN_CODE=your-passcode npm start
```

If `ADMIN_CODE` is not set, the whole admin API refuses access (HTTP 503)
and the panel cannot unlock — there is no default passcode. On Railway, add
it as a service variable (Variables → New Variable: `ADMIN_CODE`) and
redeploy. The passcode is a single shared secret, not per-user accounts.

## Age verification (18+)

Every visitor must verify they are 18 or older before they can use the site:

- **Gate:** on first visit, a full-screen gate asks for a date of birth
  (day / month / year) and states the site is 18+. Under 18 gets a plain
  "18+ only" message and no way through. No ID upload, no third-party
  service, and the date of birth is never stored.
- **Real enforcement, not cosmetic:** `POST /api/age/verify` checks the
  date of birth on the server (UTC) and, for 18+, issues a random token
  stored in the `age_tokens` table and set as an HttpOnly `age_verified`
  cookie. The server checks that token on protected actions — going live
  (`POST /api/streams`), posting chat (`POST /api/streams/:id/chat`),
  listing a product (`POST /api/products`) and buying (`POST /api/orders`).
  Unverified requests get HTTP 403 with `code: "age_required"`, and the
  client re-shows the gate. A forged cookie or a flipped client flag does
  not pass, because the token must exist in the server's table.
- **Remembered for 30 days:** the cookie and a localStorage expiry marker
  (`age_verified_until`) both last 30 days, so a verified visitor is not
  asked again on return visits. If the cookie is cleared or expires, the
  next protected action re-shows the gate. `GET /api/age/status` reports
  whether the current visitor is verified.
- **Admin:** the admin panel keeps its own passcode and is not age-gated;
  admin actions need no separate age check.

## Visitor analytics

Simple first-party traffic counts — no third-party service or script:

- **What is tracked:** every HTML page load counts as one page view
  (home, studio, room, dashboard, admin). Static assets (CSS/JS) are not
  counted. Totals kept: total page views, unique visitors, visits today,
  views per page, and visits per day (last 30 days).
- **How visitors are counted:** a random `visitor_id` cookie (32 hex
  characters, 1-year expiry) is set on first visit. No raw IP addresses are
  stored anywhere — the server never reads or records IPs for analytics.
  A malformed cookie is replaced with a fresh one.
- **Where it is shown:** the Dashboard has a Visitor analytics card (and
  the three headline numbers in its stat grid), and the admin panel shows
  the same numbers plus the per-page and per-day breakdowns. Served by
  `GET /api/analytics`; the same fields are also included in
  `GET /api/stats` and `GET /api/admin/stats`.
- **Performance:** the tracking write is a single local SQLite insert,
  deferred with `setImmediate` so it runs after the page response has
  started streaming — it cannot slow a page down, and a tracking failure
  is swallowed so it can never break page serving. Storage is two tables
  (`visitors`, `page_views`) in the same SQLite file, created at startup.

## Installable app (PWA)

The site is an installable app — no app store, no separate download:

- **What it is:** a web app manifest (`public/manifest.json`) plus a
  service worker (`public/sw.js`), registered from `public/app.js`. The
  app is called "Live Stream", opens fullscreen (`display: standalone`),
  and uses the site's dark theme (`#0c0e13`) for the splash screen and
  browser chrome. Icons are in `public/icons/` (192×192, 512×512, and a
  maskable 512×512) — a red play mark on the dark background, generated
  locally, no external image URLs.
- **How to install (Android):** open the site in Chrome, tap the
  three-dot menu, then **Install app** (or **Add to Home screen**). The
  app icon appears on the home screen and opens the site fullscreen,
  like a native app. On desktop Chrome/Edge, use the install icon in
  the address bar.
- **What the service worker does:** it caches only the static app shell
  (HTML, CSS, JS, icons) so the app opens fast and the shell still loads
  offline. It **never** caches API responses — every `/api/*` request
  always goes to the network, so live streams, chat, orders, visitor
  counts and the 18+ age gate always see fresh server state, and WebRTC
  signalling is never interrupted.
- **Limits:** installing is per-device (each phone installs it
  separately). The app is a shortcut to the live site — it still needs
  an internet connection to stream, chat, or buy, and push notifications
  are not included.

## UX polish (2026-11-14)

Small, deliberate usability fixes across the five pages — same layout and
features, easier to use, especially on phones:

- **Discover:** the feed shows a "Finding live streams…" state while it
  loads instead of a black screen; each live slide has a clear **Watch in
  room** button; shop cards name the stream ("On Maya's stream: Cooking
  live") instead of "Pinned to stream #3"; plain wording (no "WebRTC"
  jargon for visitors).
- **Studio:** the intro is in plain language; the live panel has a **Copy
  room link** button so the host can share the stream in one tap; the
  setup buttons stack full-width on phones.
- **Room:** ended streams hide the black video box and show a clear
  "This stream has ended" note with a link back; the sound button now
  toggles (Play with sound / Mute) and shows its state; the Follow button
  keeps its state consistent; checkout has a name placeholder.
- **Dashboard / Admin:** every section shows a "Loading…" state while it
  fetches; analytics pages are named (Home, Studio, Room…) instead of
  raw paths; tables scroll sideways on phones instead of being cut off;
  form inputs have minimum widths so they wrap cleanly; destructive
  admin actions (End, Remove, Delete, Block) are styled red so they
  cannot be mistaken for neutral ones.
- **Everywhere:** a footer links the legal pages; the mobile header nav
  scrolls instead of wrapping; small buttons are bigger tap targets on
  phones; inputs are 16px on mobile so iOS does not zoom on focus;
  buttons have a visible keyboard-focus outline.

## Terms, privacy & sales policy

Three plain-language legal pages, linked in the footer of every page:

- **Terms of Service** (`/terms.html`) — 18+ only, what the site is, no
  accounts, as-is availability.
- **Privacy Policy** (`/privacy.html`) — what is collected (random visitor
  cookie, age-check token, display name, chat, orders; last-4/handle only
  for saved methods), what is not (no IPs, no trackers, no ads, nothing
  sold), and how to reset it.
- **Seller &amp; Sales Policy** (`/sales-policy.html`) — how sales work,
  seller responsibilities, disputes, and listing removal.

**Honesty built in:** all three pages — and the footer on every page —
say plainly that checkout does **not** charge real money: orders only
record the payment method chosen, and the site provides no buyer
protection, escrow, or refunds. Each page also notes the terms are
standard terms, not legal advice, and should be reviewed by a lawyer
before real money moves through the site.

**Acknowledgments:** at checkout, the buyer must tick a box agreeing to
the Terms and Sales Policy and confirming the order is only recorded
before the order can be placed. Anyone listing a product (Studio, room,
or Dashboard) must tick a seller-terms box first. The boxes are
client-side checks on the existing forms — the server still enforces the
age gate on every protected action.

## Deploy — Fly.io (free allowance)

Fly.io was picked because, unlike Render's free tier, it offers a persistent
volume in its free allowance, which is what SQLite needs to survive restarts —
and it runs a plain Dockerfile with no extra services. The app needs one
long-lived Node process (HTTP polling signaling works fine), which Fly's
shared-cpu-1x machine covers.

```bash
# one-time: install flyctl and log in (creates no account here — do it yourself)
fly launch --no-deploy        # accepts the included fly.toml
fly volumes create live_stream_data --region iad --size 1
fly deploy
fly open
```

`fly.toml` sets `internal_port = 8080` (the Dockerfile listens on `PORT=8080`),
`DATA_DIR=/data` (the mounted volume), a `/api/health` check, and
`min_machines_running = 1` so polling/signaling is never cold-started away.
Note: Fly's free allowance changes over time — check their current pricing
before relying on it being $0.

## API (all under `/api/`)

| Endpoint | Purpose |
|---|---|
| `GET /api/streams?status=&category=&q=` / `POST /api/streams` | List / go live |
| `GET /api/streams/:id` · `POST /api/streams/:id/end` | Stream detail / end (clears signals) |
| `POST /api/streams/:id/heartbeat` `{peer_id}` | Viewer join/heartbeat → viewer count |
| `GET/POST /api/streams/:id/chat` | Live chat |
| `GET/POST /api/products` | Listings (optional `stream_id` pin) |
| `GET/POST /api/orders` | Buy (decrements stock, records payment method) / list |
| `GET/POST /api/payment-methods` · `POST /api/payment-methods/:id/default` · `DELETE /api/payment-methods/:id` | Saved methods (label + last-4/handle only) |
| `GET/POST/DELETE /api/follows` | Follow channels |
| `POST/GET /api/signals` | WebRTC signaling (join/offer/answer/ice, addressed delivery) |
| `GET /api/stats` · `GET /api/health` | Dashboard stats (includes visitor totals) / health check |
| `GET /api/analytics` | Visitor analytics: totals, views per page, visits per day (30 days) |
| `GET /api/activity?limit=` | Recent chat + orders across streams |
| `GET /api/streams/:id/like?peer_id=` · `POST /api/streams/:id/like` `{peer_id}` | Like count/state, toggle a like |
| `POST /api/age/verify` `{day, month, year}` · `GET /api/age/status` | Age check (18+, sets verification cookie) / verification state |
| `GET /api/admin/auth` · `GET /api/admin/stats` | Admin auth check / overview stats |
| `GET /api/admin/streams` · `POST /api/admin/streams/:id/end` · `DELETE /api/admin/streams/:id` | Admin: live streams, end, remove |
| `GET /api/admin/chat` · `DELETE /api/admin/chat/:id` | Admin: recent chat, delete message |
| `GET /api/admin/products` · `DELETE /api/admin/products/:id` | Admin: listings, remove listing |
| `GET /api/admin/orders` · `POST /api/admin/orders/:id/status` `{status}` | Admin: orders, mark placed/cancelled/refunded |
| `GET /api/admin/channels` · `POST /api/admin/channels/block` · `POST /api/admin/channels/unblock` | Admin: channels, block/unblock |

All `/api/admin/*` routes require the `x-admin-code` header matching
`ADMIN_CODE`; they return 401 for a wrong/missing code and 503 when
`ADMIN_CODE` is not set.

## Payments — honest limits

Checkout offers Card, PayPal, Apple Pay, Google Pay, Cash App, bank transfer,
plus any saved methods (default pre-selected). Saved methods store only a
nickname, kind, and last-4/handle — never full numbers. **No money moves:**
orders record the chosen method and amount in SQLite and decrement stock.

## Live video — honest limits

Video is peer-to-peer WebRTC with STUN only, so it works when both peers can
reach each other directly (the common home-network case). Symmetric NATs /
strict corporate firewalls may fail to connect — in that case the room shows an
honest "couldn't establish a live video connection" message instead of spinning
forever. Autoplay starts muted; use "Play with sound" to unmute.
