# Deploying to Google Cloud Run

This repo ships a `Dockerfile`, so it deploys to **Cloud Run** — Google's managed,
click-and-go service. No VM to manage.

## Important limitation (read first)

Cloud Run only accepts **HTTP/TCP traffic on one port**. It does **not** route **UDP**.
The video calls use **WebRTC over UDP**, so on Cloud Run:

- ✅ Works: landing/intake pages, staff login, dashboards, the task pool, request
  tracking, in-call **text chat**, admin dashboard, `/metrics`.
- ❌ Does **not** work: the actual **live video/audio** (it will sit on "Connecting").

For a demo where the **video must connect**, Cloud Run is the wrong tool — a self-hosted
SFU needs UDP, which on GCP means a Compute Engine VM (or GKE with a UDP load balancer).
Deploy here for everything-but-the-video; use a VM if the video itself must work in the cloud.

## Option A — GCP Console (no CLI)

1. Console → **Cloud Run** → **Create service**.
2. Choose **Continuously deploy from a repository** → **Set up with Cloud Build**.
3. Connect GitHub, pick **`vecvedant/Atomberg-Grand-Finale`**, branch **`main`**.
4. Build type: **Dockerfile** (root `/Dockerfile`). Save.
5. **Authentication:** Allow unauthenticated invocations.
6. **Container / Connections:** turn **Session affinity ON** (keeps a client on one
   instance — needed for Socket.IO) and set **Min instances = 1, Max instances = 1**
   (the SFU/presence state is in-memory, single-instance).
7. Create. Wait for the build, then open the assigned `https://…run.app` URL.
8. **Then set env vars and redeploy** (see below) so invite/track links are correct.

## Option B — gcloud CLI

```bash
gcloud run deploy atomberg-grand-finale \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --session-affinity \
  --min-instances 1 --max-instances 1
```

`--source .` uses the `Dockerfile`. After the first deploy, note the service URL and set
the env vars below, then run the command again.

## Required environment variables

| Var | Why |
|-----|-----|
| `PUBLIC_BASE_URL` | **Set to the deployed `https://…run.app` URL.** Invite links and the customer "track / join" links are built from this. If unset they point at `localhost` and won't work. (Known only after the first deploy — set it, then redeploy.) |
| `JWT_SECRET` | A long random string. If unset, a random one is generated each boot, so everyone's login/invite tokens break on every restart. |

Set them in the Console (Edit & deploy new revision → Variables) or:

```bash
gcloud run services update atomberg-grand-finale --region asia-south1 \
  --set-env-vars PUBLIC_BASE_URL=https://YOUR-SERVICE.run.app,JWT_SECRET=PUT_A_LONG_RANDOM_STRING_HERE
```

## Notes

- **HTTPS** is automatic on Cloud Run, so `getUserMedia` (camera/mic permission) works.
- **Storage is ephemeral:** the SQLite DB, uploaded files, and recordings live on the
  instance's local disk and reset on cold start / redeploy. Fine for a demo (demo
  accounts are re-seeded on boot); for persistence, move to Cloud SQL + Cloud Storage.
- Demo logins: `admin`/`admin123`, `manager`/`manager123`, `agent`/`agent123`.
