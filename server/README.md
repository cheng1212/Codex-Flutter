# Companion server (Phase 1)

Node.js 20+ / TypeScript, zero runtime npm dependencies (only Node
built-ins, including `node:sqlite`). The mock `CodexAdapter` is the only
Codex layer in this phase — **no real Codex process is ever started**.

## Run

```sh
cd server
npm install   # dev dependencies only (typescript, @types/node, ajv for tests)
npm run build
npm start     # binds 127.0.0.1:5291 by default
```

Environment:

| Variable | Default | Notes |
|---|---|---|
| `CODEX_FLUTTER_HOST` | `127.0.0.1` | Set an explicit private-LAN address to expose the server; never `0.0.0.0` by default |
| `CODEX_FLUTTER_PORT` | `5291` | |
| `CODEX_FLUTTER_WORKSPACES` | `$HOME` | Comma list of `id=/abs/path` workspace roots |
| `CODEX_FLUTTER_DATA_DIR` | `./data` | SQLite database lives here |
| `CODEX_FLUTTER_MOCK_SCRIPT` | `approval-basic` | `plain` \| `approval-basic` \| `approval-extended` |
| `CODEX_FLUTTER_ALLOW_PERSISTENT_APPROVALS` | unset (blocked) | Set `1` only after review; enables `acceptForSession` etc. |

## Endpoints

- `GET /healthz` — no auth: status, protocol version, adapter mode.
- `POST /api/v1/pairing/code` — loopback only; returns a one-time 6-digit
  pairing code (5 min). `POST /api/v1/pairing/claim {code, deviceName}` —
  returns `{deviceId, token}` once; only the token hash is stored.
- `GET /api/v1/projects`, `GET /api/v1/sessions`,
  `GET /api/v1/sessions/:id/history?afterSeq=&limit=` — bearer token.
- `POST /api/v1/pairing/revoke {deviceId}` — a device revokes itself.
- `GET /ws?token=…` — WebSocket: `subscribe {lastSeq, sessionId?}` for
  replay, and `command {requestId, command, payload}` for
  `session.create` / `session.resume` / `message.send` / `session.cancel` /
  `approval.respond`. Replies are `command-result` messages; duplicate
  `requestId`s return the stored result without re-executing.

See `../docs/protocol.md` for the full protocol and security rules.

## Test

```sh
npm test   # builds, then runs the mock-driven contract tests (node --test)
```

Tests cover pairing, the event seq / reconnect replay, snapshot fallback,
duplicate-`requestId` dedup, approval decisions driven by
`availableDecisions`, and expired-approval clearing. They only exercise
the mock adapter — real Codex verification is a Phase 2 gate.
