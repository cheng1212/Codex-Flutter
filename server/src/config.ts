import path from "node:path";

export interface WorkspaceRoot {
  id: string;
  name: string;
  path: string;
}

export type CodexMode = "mock" | "real";

export interface ServerConfig {
  /** Default 127.0.0.1. A LAN host is only used when explicitly configured. */
  host: string;
  port: number;
  dataDir: string;
  workspaces: WorkspaceRoot[];
  heartbeatIntervalMs: number;
  /** Pending-approval TTL; after it the request is cleared as expired. */
  approvalTtlMs: number;
  pairingCodeTtlMs: number;
  /** Max retained protocol events; older ones are dropped (replay gap -> snapshot). */
  maxEvents: number;
  /** Mock adapter script: "plain" | "approval-basic" | "approval-extended". */
  mockScript: "plain" | "approval-basic" | "approval-extended";
  /**
   * Persistent approval grants (acceptForSession, execpolicy/network
   * amendments) stay blocked unless an operator explicitly enables them
   * after review. Default false.
   */
  allowPersistentApprovals: boolean;
  /** Which CodexAdapter to run: mock (default) or the real app-server adapter. */
  codexMode: CodexMode;
  /** Codex binary for real mode. Default "codex". */
  codexBin: string;
  /** Args for the app-server process. Default ["app-server"]. */
  codexArgs: string[];
  /** Args for the `codex --version` probe. Default ["--version"]. */
  codexVersionArgs: string[];
  /**
   * Minimum accepted `codex --version`, semver-compared. Default "0.166.0"
   * (the stable version the official docs mention). A lower version makes
   * real mode refuse to start — it never silently runs an old schema.
   */
  codexMinVersion: string;
  /** Per JSON-RPC request timeout (ms). Default 30_000. */
  codexRpcTimeoutMs: number;
  /** Turn idle timeout: no event for this long -> turn/interrupt (ms). Default 600_000. */
  codexTurnIdleTimeoutMs: number;
  /** Max chars kept from a single agentMessage delta. Default 8192. */
  codexMaxDeltaChars: number;
  /** Crash-reconnect attempts. Default 3. */
  codexReconnectAttempts: number;
  /** Base reconnect delay, doubled per attempt (ms). Default 1000. */
  codexReconnectDelayMs: number;
}

export function defaultConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 5291,
    workspaces: [],
    heartbeatIntervalMs: 30_000,
    approvalTtlMs: 15 * 60_000,
    pairingCodeTtlMs: 5 * 60_000,
    maxEvents: 5000,
    mockScript: "approval-basic",
    allowPersistentApprovals: false,
    codexMode: "mock",
    codexBin: "codex",
    codexArgs: ["app-server"],
    codexVersionArgs: ["--version"],
    codexMinVersion: "0.166.0",
    codexRpcTimeoutMs: 30_000,
    codexTurnIdleTimeoutMs: 600_000,
    codexMaxDeltaChars: 8192,
    codexReconnectAttempts: 3,
    codexReconnectDelayMs: 1000,
    ...overrides,
    // NB: dataDir must be resolved AFTER the spread — an explicit
    // `dataDir: undefined` (e.g. from an unset env var in configFromEnv)
    // must not clobber the default, or `npm start` crashes on boot.
    dataDir: overrides.dataDir ?? path.join(process.cwd(), "data"),
  };
}

/** Config from environment, for `npm start`. No secrets are read from env. */
export function configFromEnv(): ServerConfig {
  const workspaces: WorkspaceRoot[] = [];
  const raw = process.env.CODEX_FLUTTER_WORKSPACES ?? "";
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [id, p] = entry.split("=", 2);
    if (id && p) workspaces.push({ id, name: id, path: p });
  }
  if (workspaces.length === 0) {
    const home = process.env.HOME ?? process.cwd();
    workspaces.push({ id: "default", name: "default", path: home });
  }
  const mockScript = process.env.CODEX_FLUTTER_MOCK_SCRIPT;
  const codexMode = process.env.CODEX_FLUTTER_CODEX_MODE;
  return defaultConfig({
    host: process.env.CODEX_FLUTTER_HOST ?? "127.0.0.1",
    port: Number(process.env.CODEX_FLUTTER_PORT ?? 5291),
    dataDir: process.env.CODEX_FLUTTER_DATA_DIR,
    workspaces,
    mockScript:
      mockScript === "plain" || mockScript === "approval-extended"
        ? mockScript
        : "approval-basic",
    allowPersistentApprovals:
      process.env.CODEX_FLUTTER_ALLOW_PERSISTENT_APPROVALS === "1",
    codexMode: codexMode === "real" ? "real" : "mock",
    codexBin: process.env.CODEX_FLUTTER_CODEX_BIN ?? "codex",
    codexArgs: splitArgs(process.env.CODEX_FLUTTER_CODEX_ARGS, ["app-server"]),
    codexVersionArgs: splitArgs(process.env.CODEX_FLUTTER_CODEX_VERSION_ARGS, ["--version"]),
    codexMinVersion: process.env.CODEX_FLUTTER_CODEX_MIN_VERSION ?? "0.166.0",
    codexRpcTimeoutMs: envMs(process.env.CODEX_FLUTTER_CODEX_RPC_TIMEOUT_MS, 30_000),
    codexTurnIdleTimeoutMs: envMs(process.env.CODEX_FLUTTER_CODEX_TURN_IDLE_TIMEOUT_MS, 600_000),
    codexMaxDeltaChars: envMs(process.env.CODEX_FLUTTER_CODEX_MAX_DELTA_CHARS, 8192),
    codexReconnectAttempts: envMs(process.env.CODEX_FLUTTER_CODEX_RECONNECT_ATTEMPTS, 3),
    codexReconnectDelayMs: envMs(process.env.CODEX_FLUTTER_CODEX_RECONNECT_DELAY_MS, 1000),
  });
}

function envMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function splitArgs(raw: string | undefined, fallback: string[]): string[] {
  if (!raw || !raw.trim()) return fallback;
  return raw.split(/\s+/).filter(Boolean);
}
