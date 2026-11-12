# Companion server (Phase 2)

Node.js 20+ / TypeScript, zero runtime npm dependencies (only Node
built-ins, including `node:sqlite`). Two `CodexAdapter` implementations:

- **mock** (default): the Phase 1 scripted adapter — no real Codex
  process is ever started.
- **real** (`CODEX_FLUTTER_CODEX_MODE=real`): `server/src/modules/codex/
  real-adapter.ts` drives a local `codex app-server` over stdio
  (JSON-RPC 2.0). Start-up runs `codex --version` first and refuses to
  run if the binary is missing or below `CODEX_FLUTTER_CODEX_MIN_VERSION`
  (default `0.166.0`); it never silently falls back to the mock.

The real adapter is verified against a local fake app-server stub
(`server/tests/fake-app-server.mjs`, `npm test` runs
`real-adapter.test.ts`): handshake, threads, streaming, the three
approval kinds, interrupt, idle timeout, RPC timeout, crash +
reconnect. **A real login turn on the target machine is still
unverified** — see `docs/codex-capability-matrix.md` §5.

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
| `CODEX_FLUTTER_CODEX_MODE` | `mock` | `mock` \| `real` — `real` drives the local `codex app-server` |
| `CODEX_FLUTTER_CODEX_BIN` | `codex` | Codex binary for real mode |
| `CODEX_FLUTTER_CODEX_ARGS` | `app-server` | Whitespace-separated args for the app-server process |
| `CODEX_FLUTTER_CODEX_VERSION_ARGS` | `--version` | Whitespace-separated args for the version probe |
| `CODEX_FLUTTER_CODEX_MIN_VERSION` | `0.166.0` | Minimum accepted `codex --version` (semver); lower refuses to start |
| `CODEX_FLUTTER_CODEX_RPC_TIMEOUT_MS` | `30000` | Per JSON-RPC request timeout |
| `CODEX_FLUTTER_CODEX_TURN_IDLE_TIMEOUT_MS` | `600000` | No event for this long → `turn/interrupt` |
| `CODEX_FLUTTER_CODEX_MAX_DELTA_CHARS` | `8192` | Max chars kept from one agentMessage delta |
| `CODEX_FLUTTER_CODEX_RECONNECT_ATTEMPTS` | `3` | Crash-reconnect attempts |
| `CODEX_FLUTTER_CODEX_RECONNECT_DELAY_MS` | `1000` | Base reconnect delay (doubled per attempt) |

## Endpoints

- `GET /healthz` — no auth: status, protocol version, adapter mode.
  In real mode it reports `codex: {mode:"real", version, connected}` —
  `version` is the `codex --version` result, `connected` is false while
  the app-server is down or reconnecting.
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
npm test   # builds, then runs contract tests + real-adapter tests vs the fake app-server (node --test)
```

Tests cover pairing, the event seq / reconnect replay, snapshot fallback,
duplicate-`requestId` dedup, approval decisions driven by
`availableDecisions`, and expired-approval clearing; plus the real
adapter against the fake app-server stub (threads, streaming, the three
approval kinds, interrupt, idle timeout, crash + reconnect, version
gate). They do **not** cover a real logged-in Codex turn, Windows
sandbox behaviour, or `model/list` — those are Phase 2 gates on the
target machine (matrix §5).
