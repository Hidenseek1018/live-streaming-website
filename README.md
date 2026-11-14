# LiveStream — live-streaming platform

A standalone live-streaming platform: discover feed, studio (go live with your
camera), stream rooms with live video, chat, follows and shopping, a dashboard
with stats and payment options, and checkout. Card payments run through Stripe
Checkout when `STRIPE_SECRET_KEY` is set (test key first); without it, orders
only record the payment method chosen in-app.

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
- `/studio.html` — set a channel, preview camera, go live, record the stream, monitor chat/sales, end stream
- `/room.html?id=<stream id>` — watch, chat, follow, shop, checkout
- `/replay.html?id=<recording id>` — watch a recorded stream back (plain video player, no live chat)
- `/dashboard.html` — stats, listings, orders, payment options, stream history, recordings
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
sale ("Shop the feed"), recent activity (latest chat and purchases), replays
of recorded streams, and ended streams. Search and category filters still filter the live feed.

## Stream recording & replays

Hosts can record a live from the Studio and viewers can watch it back later:

- **How it works:** in the Studio live panel, hit **⏺ Record** while live.
  The browser's MediaRecorder records the host's own camera and mic stream
  (about 2.5 Mbps, WebM) and shows a red `● REC` timer. Hit **⏹ Stop
  recording** (or End stream, which saves the recording first) and the file
  uploads to the server as a replay. Replays appear under **Replays** on
  Discover and in the Dashboard, and open in `/replay.html?id=…` — a plain
  video player with play/pause/seek, no live chat, no WebRTC.
- **Where files live:** `data/recordings/` on the server's persistent volume
  (same volume as the SQLite database), one file per recording, with metadata
  (channel, title, size, duration) in the `recordings` table. Served from
  `GET /api/recordings/:id/file` with HTTP Range support so seeking works.
- **Deleting:** the host deletes their recording from the Dashboard
  (age-gated); the admin panel can delete any recording with the admin
  passcode. Deleting removes the file from disk and the database row.
  There are no accounts, so the Dashboard delete is a convention, not a
  hard ownership check — the admin passcode is the real control.
- **Honest limits:**
  - It records the host's **own camera and mic only** — not the viewers,
    not the chat, not the shop. A replay is just the host's video.
  - The recording is held in the Studio tab until it uploads — **the host
    must keep the tab open** while recording. Closing the tab mid-recording
    loses it (the page warns before closing while recording).
  - One recording is capped at **500 MB** (about 25 minutes at the default
    bitrate); larger uploads are refused with HTTP 413. There is no
    automatic cleanup — old replays keep using disk until someone deletes
    them, so watch the volume. At roughly 19 MB per minute, a 1 GB volume
    holds about 50 minutes of recordings.
  - Recordings are stored as WebM (or MP4 where the browser records that);
    very old browsers without MediaRecorder cannot record.
  - Replays are 18+ gated like the rest of the site — the replay page shows
    the age gate, and the video file itself requires the verified cookie.

## Admin panel

`/admin.html` — moderation for the site owner, linked from the Dashboard:

- **Overview:** live streams, total streams, channels, blocked channels,
  viewers now, products, orders, cancelled/refunded orders, revenue from
  active orders.
- **Live streams:** end a stream or remove it (with its chat history).
- **Chat moderation:** latest messages across all streams, delete any message.
- **Products:** list all listings, remove any listing.
- **Orders:** list all orders, mark one cancelled or refunded (record only —
  no money moves), or **Refund via Stripe** on a paid card order: the server
  looks up the Checkout Session, refunds the payment through Stripe, and only
  then marks the order refunded and restores the stock. If Stripe refuses,
  nothing changes. The button only appears for paid Stripe orders, and only
  when card checkout is switched on.
- **Buyer problem reports:** buyers report a problem with an order (order
  number + what went wrong); the admin panel lists open reports with the
  linked order and can mark each one resolved. Resolving never refunds by
  itself — the Stripe refund is a separate, deliberate step.
- **Listing reports:** visitors flag listings as misleading, prohibited, or a
  scam. The Products table shows a report count per listing and the Channels
  table shows a count per channel, so repeat offenders are visible next to
  the block controls.
- **Channels:** list channels with stream counts, block a channel (any of its
  live streams end immediately, and it gets a 403 if it tries to go live
  again) or unblock it. Orders carry a `status` (`placed` / `cancelled` /
  `refunded`).
- **Recordings:** list all replays with length and size, watch any replay,
  delete any recording (removes the file from disk too). The overview stats
  also show a recordings count.

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
  card payments via Stripe, refunds through Stripe for paid orders, buyer
  problem reports, listing reports, seller responsibilities, disputes, and
  listing removal.

**Honesty built in:** all three pages describe what the site actually does —
card payments go through Stripe when switched on (test mode until live
payments are enabled), a paid card order can be refunded back to the original
card, and buyers can report problems. The site provides no escrow and no
buyer protection beyond that refund process. Each page also notes the terms
are standard terms, not legal advice, and should be reviewed by a lawyer
before real money moves through the site.

**Acknowledgments:** at checkout, the buyer must tick a box agreeing to
the Terms and Sales Policy and confirming the order is only recorded
before the order can be placed. Anyone listing a product (Studio, room,
or Dashboard) must tick a seller-terms box first. The boxes are
client-side checks on the existing forms — the server still enforces the
age gate on every protected action.

## Trust & safety: refunds and problem reports

Keeping sellers honest, and giving buyers a way back when a sale goes wrong:

- **Real Stripe refunds (admin only):** on any paid card order, the admin
  panel shows **Refund via Stripe**. The server retrieves the Checkout
  Session from Stripe, takes its payment intent, and creates a full refund
  through Stripe (`POST /v1/refunds`). Only after Stripe confirms the refund
  does the server mark the order `refunded` (and `payment_status`
  `refunded`), record the Stripe refund id, and restore the product stock
  by 1. If Stripe refuses or cannot be reached, nothing changes — the order
  stays paid and the stock stays put. The record-only Cancel/Refund buttons
  stay for record-only orders; they never move money. The Stripe button
  appears only for paid Stripe orders, and only when `STRIPE_SECRET_KEY`
  is set.
- **Buyer problem reports:** a buyer with an order number can report a
  problem from the stream room or the Dashboard (not as described, never
  arrived, damaged, or something else, plus an optional note). Reports land
  in the `disputes` table and show in the admin panel with the linked order;
  admin can mark a report resolved. Resolving a report never refunds by
  itself — the refund is a separate, deliberate step.
- **Listing reports:** any visitor can flag a listing (misleading,
  prohibited, scam, or other) from the room page or a shop card on
  Discover. Reports are counted per listing and per channel in the admin
  panel, next to the block/unblock controls, so a channel with repeat
  reports is obvious at a glance. Blocking a channel ends its live streams
  immediately and bars it from going live again.
- **Honest limits:**
  - Refunds only work for orders actually paid through Stripe. Record-only
    orders have no payment to refund.
  - There is no escrow and no automatic payout hold — money goes to the
    site's Stripe account at checkout, and a refund comes out of that
    account. Sellers are not paid out automatically (Stripe Connect is a
    separate, later step).
  - Reports rely on buyers speaking up — the site cannot detect a bad sale
    on its own, and it cannot force a seller to deliver or a buyer to pay.
  - Full refunds only in v1 (no partial refunds), and no webhook: a refund
    made in the Stripe Dashboard is not reflected on the site unless the
    admin also marks the order refunded here.

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
| `GET /api/recordings` | List replays (newest first) |
| `POST /api/recordings?stream_id=&channel=&title=&duration=` | Upload a recording (raw video body, age-gated, max 500 MB) |
| `GET /api/recordings/:id` | One replay's metadata |
| `GET /api/recordings/:id/file` | Stream the recording file (age-gated, HTTP Range supported) |
| `DELETE /api/recordings/:id` | Delete a recording, file included (age-gated) |
| `POST /api/streams/:id/heartbeat` `{peer_id}` | Viewer join/heartbeat → viewer count |
| `GET/POST /api/streams/:id/chat` | Live chat |
| `GET/POST /api/products` | Listings (optional `stream_id` pin) |
| `GET/POST /api/orders` | Buy (decrements stock, records payment method) / list |
| `GET /api/checkout/config` | Whether card checkout (Stripe) is switched on |
| `POST /api/checkout` `{product_id, stream_id, buyer}` | Create a Stripe Checkout Session; returns the Stripe payment URL (age-gated) |
| `GET /api/checkout/confirm?session_id=` | Retrieve the session from Stripe; marks the order paid only when Stripe says it is paid (age-gated) |
| `POST /api/disputes` `{order_id, reason, note}` | Report a problem with an order (age-gated) |
| `POST /api/listing-reports` `{product_id, reason, note}` | Flag a listing as misleading, prohibited, scam, or other (age-gated) |
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
| `POST /api/admin/orders/:id/refund` | Admin: refund a paid Stripe order through Stripe (money back to the card, stock restored) |
| `GET /api/admin/disputes` · `POST /api/admin/disputes/:id/resolve` | Admin: buyer problem reports, mark one resolved |
| `GET /api/admin/listing-reports` | Admin: recent listing reports with product and channel |
| `GET /api/admin/recordings` · `DELETE /api/admin/recordings/:id` | Admin: list recordings, delete one (file included) |
| `GET /api/admin/channels` · `POST /api/admin/channels/block` · `POST /api/admin/channels/unblock` | Admin: channels, block/unblock |

All `/api/admin/*` routes require the `x-admin-code` header matching
`ADMIN_CODE`; they return 401 for a wrong/missing code and 503 when
`ADMIN_CODE` is not set.

## Payments — honest limits

Checkout offers Card, PayPal, Apple Pay, Google Pay, Cash App, bank transfer,
plus any saved methods (default pre-selected). Saved methods store only a
nickname, kind, and last-4/handle — never full numbers.

## Stripe Checkout (test mode first)

When `STRIPE_SECRET_KEY` is set, buying a product goes through Stripe's
hosted Checkout instead of the record-only flow:

1. `POST /api/checkout` (age-gated) creates a Stripe Checkout Session for the
   product (USD, price in cents) and creates the order as `unpaid` with the
   session id, decrementing stock in the same transaction. The buyer is
   redirected to Stripe's payment page.
2. Stripe returns the buyer to the site with `?checkout=success&session_id=…`.
   `GET /api/checkout/confirm` retrieves that session from Stripe and marks
   the order `paid` only when Stripe reports `payment_status: 'paid'`. URL
   params alone are never trusted.
3. The Dashboard orders table shows Paid (Stripe) / Unpaid / Record only per
   order, and the admin orders list shows the Stripe payment status too.

- **Env var:** `STRIPE_SECRET_KEY` (set on Railway as a service variable).
  Without it, `GET /api/checkout/config` reports `stripe_enabled: false` and
  checkout behaves exactly as before — record-only, no charge, no breakage.
- **Test vs live:** start with a Stripe **test** secret key (`sk_test_…`) and
  Stripe's test cards; switch to a **live** key (`sk_live_…`) only when ready
  for real money. Money goes to the connected Stripe account; paying sellers
  out automatically (Stripe Connect) is a separate, later step.
- **No webhook in v1:** payment is confirmed by the session-retrieval call
  above. If a buyer pays but closes the tab before returning, the order stays
  `unpaid` until someone opens the return link — a Stripe webhook endpoint
  would close that gap and is the next improvement.
- **Refunds:** a paid card order can be refunded from the admin panel — the
  server creates the refund through Stripe (`POST /v1/refunds` with the
  session's payment intent) and only marks the order refunded after Stripe
  confirms it, restoring the stock. Record-only Cancel/Refund in the admin
  panel still only changes the record and never moves money. See "Trust &
  safety" above.
- The server talks to Stripe with raw `node:https` calls (no Stripe SDK, zero
  new dependencies). The secret key is never logged. `STRIPE_API_BASE` is a
  test-only override that lets a local stub stand in for `api.stripe.com`
  during verification — never set it in production.

## Live video — honest limits

Video is peer-to-peer WebRTC with STUN only, so it works when both peers can
reach each other directly (the common home-network case). Symmetric NATs /
strict corporate firewalls may fail to connect — in that case the room shows an
honest "couldn't establish a live video connection" message instead of spinning
forever. Autoplay starts muted; use "Play with sound" to unmute.
