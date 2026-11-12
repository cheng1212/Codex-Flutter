import { configFromEnv } from "./config.js";
import { CompanionServer } from "./server.js";

/**
 * Companion server entry point (`npm start`).
 *
 * Defaults bind 127.0.0.1 only. To expose the server on the LAN, set
 * CODEX_FLUTTER_HOST to an explicit private-LAN address — the server
 * never binds 0.0.0.0 by default. Workspace roots come from
 * CODEX_FLUTTER_WORKSPACES as a comma list of `id=/abs/path`.
 *
 * No Codex credentials are involved here: the mock adapter (Phase 1)
 * needs none, and the Phase 2 adapter must keep Codex auth on the
 * desktop (its own `~/.codex/auth.json` / env), never forwarded.
 */

const config = configFromEnv();
const server = new CompanionServer(config);

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, stopping companion…`);
  await server.stop();
  process.exit(0);
}

await server.start();
const { host, port } = server.address();
console.log(`codex-flutter companion listening on http://${host}:${port} (mock adapter, protocol 1.0.0)`);
console.log(`health:  curl http://${host}:${port}/healthz`);
console.log(`pairing: curl -X POST http://${host}:${port}/api/v1/pairing/code   (loopback only)`);
