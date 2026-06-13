# Atomberg Video Support Platform

> **Built by Vedant** — Atomberg hackathon finale.
> **Live demo:** https://atombergvideo-150175342104.asia-south1.run.app · **Source:** https://github.com/vecvedant/Atomberg-Grand-Finale

A self-owned, real-time **video support platform** for customer-support teams. An agent
creates a session, shares an invite link, and the customer joins from a browser — both see
and hear each other, chat, share files, and the agent can record the session for review.

**Media routes through our own server (a WebRTC SFU). There is no peer-to-peer connection
between browsers and no third-party hosted video API** (no Twilio/Agora/Daily/Vonage). The
SFU is built with [werift](https://github.com/shinyoshiaki/werift-webrtc), a pure-TypeScript
WebRTC stack, so the whole thing runs with **zero native build steps**.

---

## Demo accounts

Judges can sign in instantly at `http://localhost:3000`. There are three staff tiers
(**Admin → Manager → Agent**):

| Role    | Username  | Password     | What they do |
|---------|-----------|--------------|--------------|
| Admin   | `admin`   | `admin123`   | The single master account. Adds/removes **managers** and reviews their performance. Cannot be created from the UI. |
| Manager | `manager` | `manager123` | Runs an agent pool: adds/removes **agents**, posts **tasks**, and sees per-agent reports. |
| Agent   | `agent`   | `agent123`   | Accepts pooled **tasks**, runs the call, and accrues a delivery count. Belongs to the manager above. |

**Customers need no account** — they join via the invite link (`/customer.html?token=…`).

### Roles & task pool (Rapido-style)

- A **manager** (or admin) posts a task into the manager's pool — it starts **open**.
- Every **agent** under that manager sees it under *Available tasks* and **accepts** one at
  their convenience; the task becomes theirs and they run/schedule the call.
- Access is enforced by tier: an admin sees everything, a manager only their pool, an agent
  only their assigned tasks. An admin can never be created through the app (only by seeding).

---

## Quick start

Requirements: **Node.js ≥ 22** (tested on Node 24). No database server, no compiler, no ffmpeg.

```bash
npm install        # install dependencies (all pure-JS / prebuilt — no native build)
npm run seed       # create the demo agent + admin accounts
npm run dev        # start with auto-reload  (or: npm start)
```

Then open **http://localhost:3000** and sign in as `agent` / `agent123`.

> Camera/microphone access requires a *secure context*. `http://localhost` counts as secure,
> so the local demo works over plain HTTP. To demo across two machines on a LAN, put the app
> behind HTTPS (a reverse proxy with a self-signed cert is enough) — browsers block
> `getUserMedia` on non-localhost HTTP.

### Try it end-to-end

1. Sign in as **agent** → **Create session & join** → allow camera/mic.
2. Copy the **invite link** from the right-hand panel.
3. Open the invite link in a **second browser / incognito window**, enter a name, **Join call**.
4. You now have a two-way video call routed through the server. Try:
   - **Chat** and **file sharing** (the **Attach** button) in the side panel
   - **Mute / camera** toggles
   - **Record** then **Stop recording** (the customer sees a "recording" indicator)
   - **End session** (closes both connections cleanly)
5. Sign in as **admin** (`admin` / `admin123`) at `/admin.html` to see live sessions,
   durations, event logs, recordings, and to force-end any session.

---

## Configuration

Everything has sensible local defaults; copy `.env.example` to `.env` to override.

| Variable             | Default                  | Purpose                                             |
|----------------------|--------------------------|-----------------------------------------------------|
| `PORT`               | `3000`                   | HTTP port                                           |
| `JWT_SECRET`         | *(random per start)*     | Signs login + invite tokens. **Set this** for stable tokens across restarts. |
| `SESSION_TOKEN_TTL`  | `12h`                    | Agent/admin login lifetime                          |
| `INVITE_TOKEN_TTL`   | `24h`                    | Customer invite-link lifetime                       |
| `RECONNECT_GRACE_MS` | `15000`                  | How long a dropped participant's slot is held       |
| `MAX_UPLOAD_BYTES`   | `26214400` (25 MB)       | Max shared-file size                                |
| `PUBLIC_BASE_URL`    | `http://localhost:3000`  | Base URL used in generated invite links             |

---

## Feature checklist (vs. problem statement)

**Must-haves**
- [x] Agent creates a session and invites a customer via a shareable link/token
- [x] Both join from the browser, no install
- [x] Server tracks who is in a session at any time (presence + roster)
- [x] Either party can end the session; all connections close cleanly
- [x] Session history (who joined, when, how long) persisted and queryable
- [x] Real-time audio + video, **routed through the server (SFU), not P2P**
- [x] Mute audio / disable video at any time
- [x] In-call chat, delivered live and persisted; retrievable after the call
- [x] Two roles (Call Agent, Customer) with server-enforced access control

**Support workflow extras**
- [x] **Agent accounts** — admins create agents and reset passwords; users change their own password ("Forgot password?" routes to the admin, since there is no email service)
- [x] **Schedule a call** — create a session for a future date/time with a problem description; share the invite link
- [x] **Describe the problem** — captured on creation, shown to the customer before joining and in the record
- [x] **Recording consent** — an unmissable "this call is being recorded" banner for all participants
- [x] **Change camera / microphone** — in-call device picker, switches live
- [x] **Resolution + feedback** — agent marks resolved / not resolved with notes; customer rates the call, says whether it was solved, and leaves a comment

**Customer self-service**
- [x] **Public intake form** — anyone raises a support request; it auto-routes to the least-busy manager, auto-computes warranty from the purchase date, and accepts an optional bill photo
- [x] **Track a request** by reference code **or mobile number** — a live status timeline
- [x] **Get on the line** (a live FIFO queue) **or schedule for later**; a waiting customer can even reschedule from the waiting room
- [x] The Join button stays inactive until an agent actually picks the request up

**Good-to-haves (all implemented)**
- [x] **Call recording** — server-side WebM, status lifecycle (recording → processing → ready), downloadable
- [x] **File sharing in chat** — images/PDF/docs, validated + access-controlled
- [x] **Reconnect handling** — grace window; seamless rejoin without notifying the peer
- [x] **Admin dashboard** — live sessions, history, event logs, force-end
- [x] **Observability** — Prometheus metrics at `/metrics`

---

## How it's tested

Automated checks live in `scripts/` and run against a running server (`npm start` first):

| Script                          | Proves                                                                 |
|---------------------------------|------------------------------------------------------------------------|
| `node scripts/phase1-check.mjs`     | Auth, sessions, presence, **bidirectional chat**, persistence, access control |
| `node scripts/browser-sfu-check.mjs`| **Real Chromium** (fake camera): A/V flows **both ways through the server**, both tiles render video, chat |
| `node scripts/recording-check.mjs`  | Recording start→stop→ready→download as valid WebM + auth                |
| `node scripts/file-check.mjs`       | File upload, MIME rejection, share-in-chat, authorized download         |
| `node scripts/reconnect-check.mjs`  | Drop + reconnect within grace → same slot, peer not notified            |
| `node scripts/hierarchy-check.mjs`  | Admin/Manager/Agent rules, no admin-creation path, task pool accept, cross-pool isolation, performance stats, customer feedback |
| `node scripts/intake-check.mjs`     | Public intake → auto-routing to least-busy manager, warranty compute, bill upload |
| `node scripts/track-check.mjs`      | Track by reference + mobile number, privacy-safe live status |
| `node scripts/queue-check.mjs`      | "Get on the line" live queue (FIFO) + the agent's live/scheduled split |
| `node scripts/reschedule-check.mjs` | Schedule-for-later, including rescheduling from the waiting room |
| `node scripts/backguard-check.mjs`  | Browser **Back** on a dashboard signs the user out; a refresh keeps the session |

The browser tests use Puppeteer with `--use-fake-device-for-media-stream`, so they verify the
real product path (browser ↔ server SFU) without a physical camera.

---

## Architecture

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the system diagram, the SFU media flow, the
negotiation model, and the horizontal-scaling plan.

Stack at a glance: **Node + TypeScript** (run via `tsx`, no build) · **Express** REST ·
**Socket.IO** signaling/chat/presence · **werift** SFU · **node:sqlite** persistence ·
**prom-client** metrics · vanilla-JS browser client (no build step).

---

## Deployment

A `Dockerfile` is included, so the app deploys to **Google Cloud Run** in a few clicks — see
**[DEPLOY-GCP.md](DEPLOY-GCP.md)** for the exact steps. Cloud Run runs the full app (pages,
sign-in, dashboards, intake, tracking, chat, admin, metrics) over automatic HTTPS. **One
caveat:** the live audio/video does **not** flow on Cloud Run, because serverless platforms
only route HTTP/TCP and the SFU needs UDP — for the actual camera-to-camera call, run it
locally (above) or on a VM with a public IP. The deployed link is great for showing the
product; the local run is where the video works.

---

## Known limitations

- **Optimized for 1:1 support calls** (agent ↔ customer). The SFU forwards N-way, but the UI
  and recording layout assume two participants.
- **Recording** muxes all live tracks into one WebM; single-stream players show the primary
  (customer) video — VLC/track-aware players expose all tracks. No server-side compositing
  (that would need ffmpeg, intentionally avoided to keep the stack build-free).
- **`getUserMedia` needs HTTPS** off-localhost (browser requirement, not an app limitation).
- **Transitive advisory**: werift pulls in the `ip` package, which has an open SSRF
  mis-categorization advisory (`GHSA-2p57-rm9w-gvfp`) with no upstream fix. It's used only for
  ICE candidate classification inside the WebRTC stack — not reachable from our request
  handling — and is documented here for transparency.
- With no `JWT_SECRET` set, a random secret is generated per start, so existing tokens/invite
  links stop working after a restart. Set `JWT_SECRET` in `.env` to avoid this.

## Project layout

```
src/
  server.ts            app wiring (Express + Socket.IO + metrics + static)
  config.ts            env config with local defaults
  db/                  node:sqlite connection, schema.sql, repositories
  auth/                JWT tokens, scrypt passwords, role middleware
  api/                 REST: auth, sessions, files, recordings, admin
  realtime/            Socket.IO signaling, presence, chat, SFU, recorder
  services/            session create/end/record helpers
  metrics/             Prometheus registry
public/                vanilla-JS client (landing, login, agent, manager, admin, customer, intake, track)
scripts/               automated verification scripts
```

---

## Author

Built by **Vedant** for the Atomberg hackathon finale.
