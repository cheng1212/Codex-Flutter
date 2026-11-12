import path from "node:path";

export interface WorkspaceRoot {
  id: string;
  name: string;
  path: string;
}

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
  });
}
