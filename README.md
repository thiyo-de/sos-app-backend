# SOS Server Gateway

Node.js backend for remote access — **Phase 2 (ported from `D:\Remote-App\remote-app\server-gateway`)**.

## Stack

Node 18+ · Express 4 · `ws` (WebSocket) · Supabase · Firebase Admin · Vitest

## Modules

```
server-gateway/
├── src/
│   ├── index.js                 # Express + WS server, auth, rate-limit, CORS
│   ├── config.js                # Env validation (fail-fast)
│   ├── routes/admin.js          # Dashboard REST (devices, commands, stats)
│   ├── middleware/              # auth.js (cookie token) + csrf.js
│   ├── services/                # socketRegistry, commandDispatcher, database,
│   │                            # fcmSender, firebaseCredentials, healthMonitor,
│   │                            # metrics, storage
│   └── test-runner/
├── public/                      # Web dashboard (login + device control)
├── render.yaml                  # Render deploy (service: sos-server)
├── .env.example                 # Template (copy to .env)
└── package.json
```

## Quick start

```bash
cp .env.example .env   # fill in SECRET_KEY, ADMIN_USERNAME/PASSWORD, WS_DEVICE_SECRET
npm install
npm run dev            # hot reload on :3000
```

Verify: `npm test` (98 tests) · dashboard at `http://localhost:3000` · health at `/health`.

## ⚠️ Security

- `.env` is dev-only placeholders — never commit real secrets.
- `WS_DEVICE_SECRET` must match the Android client's build config (Phase 3).
- Render deploy: set env vars in dashboard; `SECRET_KEY` auto-generated.

Track: [`Docs/project-track.md`](../Docs/project-track.md) — Phase 3 (client ⇄ server link) is next.