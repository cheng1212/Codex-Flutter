import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Logger } from "../../logging.js";
import { RESTRICTED_DECISIONS } from "../approvals/approvals.js";
import type { ApprovalDecision } from "../../../../packages/protocol/src/types.js";
import type {
  ApprovalRequest,
  CodexAdapter,
  CodexEvent,
  CodexEventKind,
  CodexStatus,
  ThreadSummary,
  TurnHandle,
} from "./adapter.js";

/**
 * Real CodexAdapter (Phase 2): drives `codex app-server` over stdio
 * (JSON-RPC 2.0, newline-delimited), using the wire shapes from the
 * version-exact schema dump (`codex app-server generate-json-schema`,
 * 0.164.0-alpha.9; see docs/codex-capability-matrix.md §4).
 *
 * Method names are the ones in that schema's `ClientRequest` /
 * `ServerRequest` / `ServerNotification` unions, e.g. `thread/start`,
 * `turn/start`, `item/commandExecution/requestApproval`,
 * `item/agentMessage/delta`, `serverRequest/resolved`.
 *
 * Safety rules (matrix §6, carried over from the mock contract):
 * - `initialize` is sent WITHOUT `experimentalApi: true`.
 * - `thread/start` explicitly sets approvalPolicy "on-request" and
 *   sandbox "workspace-write" (matrix §15) — the companion never relies
 *   on whatever the user's local config.toml happens to say.
 * - No `--dangerously-bypass-approvals-and-sandbox`, no reading of
 *   `~/.codex/sessions` rollout files, no forwarding of auth material.
 *   The app-server is only ever reached over stdio on this machine.
 * - Events and logs carry summaries only: deltas are truncated, tool
 *   output is reduced to exit code / duration / file count, and raw
 *   command output never enters an event payload or a log line.
 *
 * Two honest deviations from the Phase 0 matrix, found while writing
 * this adapter against the generated schema:
 * - The 0.164.0-alpha.9 approval schemas carry NO `availableDecisions`
 *   field (the matrix §9 claim came from the docs page). The field is
 *   therefore treated as OPTIONAL: honoured when the server sends it,
 *   otherwise the safe defaults below apply. This must be re-checked
 *   against the target machine's CLI version (matrix §5).
 * - The legacy server requests `applyPatchApproval` / `execCommandApproval`
 *   and the client-tool requests (`item/tool/call`,
 *   `mcpServer/elicitation/request`, `tool/requestUserInput`) are answered
 *   with JSON-RPC -32601 (not supported) instead of being silently left
 *   hanging. If a real turn ever hits one, the turn fails loudly and the
 *   failure is visible — that is a Phase 2 follow-up, not a silent hang.
 */

export interface RealCodexAdapterOptions {
  /** Codex binary. Default "codex". Tests point this at a stub. */
  bin?: string;
  /** Args for the app-server process. Default ["app-server"]. */
  args?: string[];
  /** Args for the version probe. Default ["--version"]. */
  versionArgs?: string[];
  /** Extra env for the child (merged over process.env). */
  env?: NodeJS.ProcessEnv;
  /**
   * Minimum accepted CLI version, compared as semver against
   * `codex --version`. Configurable; default "0.166.0" (the stable
   * version the official docs mention — NOT the 0.164.0-alpha.9 that
   * happens to be on this dev machine).
   */
  minVersion?: string;
  /** Per JSON-RPC request timeout. Default 30_000 ms. */
  rpcTimeoutMs?: number;
  /** Turn idle timeout: no event for this long -> turn/interrupt. Default 600_000 ms. */
  turnIdleTimeoutMs?: number;
  /** Max chars kept from a single agentMessage delta. Default 8192. */
  maxDeltaChars?: number;
  /** Crash-reconnect attempts. Default 3. */
  reconnectAttempts?: number;
  /** Base reconnect delay (doubled per attempt). Default 1000 ms. */
  reconnectDelayMs?: number;
  /** Persistent grants stay blocked unless explicitly enabled. Default false. */
  allowPersistentApprovals?: boolean;
  clientName?: string;
  clientVersion?: string;
}

const DEFAULT_MIN_VERSION = "0.166.0";
const DEFAULT_APPROVAL_POLICY = "on-request";
const DEFAULT_SANDBOX = "workspace-write";
const MAX_STDIO_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_TAIL_LINES = 20;
const HISTORY_LIMIT = 100;

const ALL_DECISIONS: ApprovalDecision[] = [
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
  "acceptWithExecpolicyAmendment",
  "applyNetworkPolicyAmendment",
];

/** Defaults when the server sends no `availableDecisions` (0.164 schema). */
const DEFAULT_COMMAND_DECISIONS: ApprovalDecision[] = ["accept", "decline"];
const DEFAULT_PERMISSIONS_DECISIONS: ApprovalDecision[] = ["accept", "decline", "cancel"];

/** Wire item type -> the snake_case vocabulary sessions.ts maps on. */
const ITEM_TYPE_MAP: Record<string, string> = {
  agentMessage: "agent_message",
  commandExecution: "command_execution",
  fileChange: "file_change",
  plan: "todo_list",
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

/** First semver-looking token in `codex --version` output. */
export function parseCodexVersion(text: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(text);
  return m ? m[0] : null;
}

function splitPrerelease(v: string): { core: number[]; pre: (string | number)[] | null } {
  const [corePart, prePart] = v.split("-", 2);
  const core = corePart.split(".").map((n) => Number(n));
  const pre = prePart === undefined ? null : prePart.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  return { core, pre };
}

/**
 * Semver comparison (no dependency). A release beats its own prerelease;
 * prerelease identifiers compare numerically when numeric, else lexically.
 * Returns <0, 0, >0.
 */
export function compareVersions(a: string, b: string): number {
  const pa = splitPrerelease(a);
  const pb = splitPrerelease(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
    } else if (typeof x === "number") {
      return -1;
    } else if (typeof y === "number") {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

interface PendingRpc {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

type ApprovalKind = "commandExecution" | "fileChange" | "permissions";

interface PendingApprovalRecord {
  rpcId: number | string;
  kind: ApprovalKind;
  threadId: string;
  turnId: string;
  itemId: string;
  availableDecisions: ApprovalDecision[];
  params: Record<string, unknown>;
}

export class RealCodexAdapter implements CodexAdapter {
  private readonly log = new Logger("codex-real");
  private readonly opts: Required<RealCodexAdapterOptions>;
  private listeners: Array<(e: CodexEvent) => void> = [];

  private child: ChildProcessWithoutNullStreams | null = null;
  private started = false;
  private stopping = false;
  private connected = false;
  private reconnecting = false;
  private version: string | null = null;

  private nextId = 1;
  private pendingRequests = new Map<number, PendingRpc>();
  private pendingApprovals = new Map<string, PendingApprovalRecord>();
  /** JSON-RPC ids of approval answers already sent (to swallow their error replies). */
  private approvalResponseIds = new Set<string>();
  /** Server request ids we already answered, awaiting serverRequest/resolved. */
  private answeredRpcIds = new Map<string, number>();
  private activeTurns = new Map<string, { threadId: string; lastActivityAt: number }>();
  private knownThreads = new Set<string>();
  private truncatedItems = new Set<string>();
  private stdoutBuf = "";
  private stderrTail: string[] = [];

  private idleTimer: NodeJS.Timeout | null = null;

  constructor(options: RealCodexAdapterOptions = {}) {
    this.opts = {
      bin: options.bin ?? "codex",
      args: options.args ?? ["app-server"],
      versionArgs: options.versionArgs ?? ["--version"],
      env: options.env ?? {},
      minVersion: options.minVersion ?? DEFAULT_MIN_VERSION,
      rpcTimeoutMs: options.rpcTimeoutMs ?? 30_000,
      turnIdleTimeoutMs: options.turnIdleTimeoutMs ?? 600_000,
      maxDeltaChars: options.maxDeltaChars ?? 8192,
      reconnectAttempts: options.reconnectAttempts ?? 3,
      reconnectDelayMs: options.reconnectDelayMs ?? 1000,
      allowPersistentApprovals: options.allowPersistentApprovals ?? false,
      clientName: options.clientName ?? "codex-flutter-companion",
      clientVersion: options.clientVersion ?? "0.1.0",
    };
  }

  on(_event: "codex-event", cb: (e: CodexEvent) => void): void {
    this.listeners.push(cb);
  }

  private emit(e: CodexEvent): void {
    for (const cb of this.listeners) cb(e);
  }

  status(): CodexStatus {
    return { mode: "real", version: this.version, connected: this.connected };
  }

  // -- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.stopping = false;
    this.version = await this.checkVersion();
    await this.spawnOnce();
    this.started = true;
    this.connected = true;
    this.startIdleSweep();
    this.log.info("codex app-server started", { version: this.version });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopIdleSweep();
    this.failPendingRequests(new Error("codex adapter stopped"));
    await this.killChild();
    this.started = false;
    this.connected = false;
  }

  /** `codex --version` probe; refuses to start on missing binary / old version. */
  private async checkVersion(): Promise<string> {
    const { bin, versionArgs, minVersion } = this.opts;
    let out: string;
    try {
      out = await new Promise<string>((resolve, reject) => {
        execFile(
          bin,
          versionArgs,
          { timeout: 10_000, windowsHide: true, env: { ...process.env, ...this.opts.env } },
          (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve(`${stdout}\n${stderr}`);
          },
        );
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        throw new Error(
          `codex binary not found: "${bin}". Install Codex CLI or set CODEX_FLUTTER_CODEX_BIN to its path. ` +
            `The companion never silently falls back to the mock adapter in real mode.`,
        );
      }
      throw new Error(
        `failed to run "${bin} ${versionArgs.join(" ")}" for the version check: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const found = parseCodexVersion(out);
    if (!found) {
      throw new Error(
        `could not parse a version from "${bin} ${versionArgs.join(" ")}" output; refusing to start in real mode`,
      );
    }
    if (compareVersions(found, minVersion) < 0) {
      throw new Error(
        `codex version ${found} is below the minimum supported ${minVersion}; ` +
          `please upgrade Codex CLI — the companion refuses to run against an older protocol schema`,
      );
    }
    return found;
  }

  /** Spawn the child and complete the initialize handshake. */
  private async spawnOnce(): Promise<void> {
    const child = spawn(this.opts.bin, this.opts.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.opts.env },
      windowsHide: true,
    });
    this.child = child;
    this.stdoutBuf = "";
    child.stdout.on("data", (c: Buffer) => this.onStdout(c));
    child.stderr.on("data", (c: Buffer) => {
      for (const line of c.toString("utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        this.stderrTail.push(truncate(t, 500));
        if (this.stderrTail.length > MAX_STDERR_TAIL_LINES) this.stderrTail.shift();
      }
    });
    child.once("exit", (code, signal) => this.onChildGone(child, `exited (code ${code ?? "?"}, signal ${signal ?? "?"})`));
    child.once("error", (err) => this.onChildGone(child, `spawn/process error: ${err.message}`));
    try {
      const result = await this.request("initialize", {
        clientInfo: { name: this.opts.clientName, version: this.opts.clientVersion },
        // No capabilities: experimentalApi stays false (matrix §6).
      });
      if (asRecord(result) === null) throw new Error("initialize returned a non-object result");
      this.sendNotification("initialized", {});
    } catch (err) {
      await this.killChild();
      throw err;
    }
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("close", () => resolve());
    });
    try {
      child.stdin.end();
    } catch {
      // Already gone.
    }
    const force = sleep(2000)
      .then(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Already gone.
        }
        return sleep(1000);
      })
      .then(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      });
    await Promise.race([exited, force]);
  }

  /**
   * Single exit/error handler for a child (guarded so a child that fires
   * both events is only handled once, and a stale child from before a
   * reconnect never triggers a second crash path).
   */
  private onChildGone(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.connected = false;
    const tail = this.stderrTail.length > 0 ? ` stderr tail: ${this.stderrTail.join(" | ")}` : "";
    this.failPendingRequests(new Error(`codex app-server ${reason}${tail}`));
    if (this.stopping || !this.started) {
      // Start() is failing via the rejected initialize, or we are
      // shutting down on purpose: nothing more to do.
      return;
    }
    if (this.reconnecting) return; // the reconnect loop owns recovery
    // Crash after a successful start: surface it, then reconnect.
    const affectedTurns = [...this.activeTurns.entries()].map(([turnId, t]) => ({ turnId, threadId: t.threadId }));
    const affectedThreads = [...new Set(affectedTurns.map((t) => t.threadId))];
    const pendingApprovals = [...this.pendingApprovals.values()];
    this.activeTurns.clear();
    this.truncatedItems.clear();
    this.started = false;
    for (const p of pendingApprovals) {
      this.pendingApprovals.delete(p.itemId);
      this.emit({
        kind: "approval.cleared",
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        reason: `codex process ${reason}`,
      });
    }
    for (const t of affectedTurns) {
      this.emit({ kind: "turn.completed", threadId: t.threadId, turnId: t.turnId, status: "interrupted" });
      this.emit({
        kind: "session.error",
        threadId: t.threadId,
        turnId: t.turnId,
        summary: `codex app-server ${reason} while the turn was running; the turn was interrupted`,
      });
    }
    this.log.error("codex app-server is gone, reconnecting", { reason, affectedTurns: affectedTurns.length });
    void this.reconnectLoop(affectedThreads);
  }

  private async reconnectLoop(affectedThreads: string[]): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      let delay = this.opts.reconnectDelayMs;
      for (let attempt = 1; attempt <= this.opts.reconnectAttempts; attempt++) {
        if (this.stopping) return;
        this.log.warn("reconnecting to codex app-server", { attempt, of: this.opts.reconnectAttempts });
        await sleep(delay);
        delay *= 2;
        if (this.stopping) return;
        try {
          this.version = await this.checkVersion();
          await this.spawnOnce();
          this.started = true;
          this.connected = true;
          await this.recoverThreads(affectedThreads);
          this.log.info("reconnected to codex app-server", { version: this.version });
          return;
        } catch (err) {
          this.log.warn("reconnect attempt failed", { attempt, msg: String(err) });
        }
      }
      this.log.error("could not reconnect to codex app-server; the real adapter is down until the companion restarts");
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Subscription/state rebuild after a reconnect: `thread/loaded/list`
   * tells us what the fresh process already has in memory; threads that
   * had a turn in flight (and are not loaded) are resumed so the user
   * can continue them with a new turn.
   */
  private async recoverThreads(threadIds: string[]): Promise<void> {
    let loaded: string[] = [];
    try {
      const res = await this.request("thread/loaded/list", {});
      loaded = asStringArray(asRecord(res)?.data) ?? [];
    } catch (err) {
      this.log.warn("thread/loaded/list failed during recovery", { msg: String(err) });
    }
    this.log.info("recovery: threads loaded in the new process", { count: loaded.length });
    const loadedSet = new Set(loaded);
    for (const threadId of threadIds) {
      if (loadedSet.has(threadId)) continue;
      try {
        await this.request("thread/resume", { threadId });
        this.knownThreads.add(threadId);
        this.emit({ kind: "thread.started", threadId });
        this.log.info("recovery: resumed thread", { threadId });
      } catch (err) {
        this.log.warn("recovery: thread/resume failed", { threadId, msg: String(err) });
      }
    }
  }

  private startIdleSweep(): void {
    this.stopIdleSweep();
    const interval = Math.min(1000, Math.max(100, Math.floor(this.opts.turnIdleTimeoutMs / 2)));
    this.idleTimer = setInterval(() => this.sweepIdleTurns(), interval);
    this.idleTimer.unref();
  }

  private stopIdleSweep(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private sweepIdleTurns(): void {
    const now = Date.now();
    for (const [turnId, t] of [...this.activeTurns]) {
      if (now - t.lastActivityAt > this.opts.turnIdleTimeoutMs) {
        this.log.warn("turn idle timeout, interrupting", { turnId, threadId: t.threadId });
        this.activeTurns.delete(turnId);
        void this.request("turn/interrupt", { threadId: t.threadId, turnId }).catch((err: unknown) => {
          this.log.warn("idle interrupt failed", { turnId, msg: String(err) });
        });
      }
    }
  }

  // -- JSON-RPC plumbing ---------------------------------------------------

  private requireChild(): ChildProcessWithoutNullStreams {
    if (!this.child) {
      throw new Error("codex app-server is not running; the real adapter is down (reconnect it by restarting the companion)");
    }
    return this.child;
  }

  private writeLine(msg: Record<string, unknown>): void {
    const child = this.requireChild();
    const line = `${JSON.stringify(msg)}\n`;
    child.stdin.write(line, (err) => {
      if (err) this.log.warn("write to codex stdin failed", { msg: String(err) });
    });
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = this.opts.rpcTimeoutMs): Promise<unknown> {
    this.requireChild();
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`codex request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pendingRequests.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.writeLine({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    try {
      this.writeLine({ jsonrpc: "2.0", method, params });
    } catch (err) {
      this.log.warn("could not send notification to codex", { method, msg: String(err) });
    }
  }

  private respondError(id: number | string, code: number, message: string): void {
    try {
      this.writeLine({ jsonrpc: "2.0", id, error: { code, message } });
    } catch (err) {
      this.log.warn("could not send error response to codex", { msg: String(err) });
    }
  }

  private failPendingRequests(err: Error): void {
    for (const [, p] of this.pendingRequests) p.reject(err);
    this.pendingRequests.clear();
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString("utf8");
    if (this.stdoutBuf.length > MAX_STDIO_BUFFER_BYTES) {
      this.log.error("codex stdout buffer exceeded the limit; killing the process");
      void this.killChild();
      this.stdoutBuf = "";
      return;
    }
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.log.warn("ignoring malformed JSON from codex stdout", { lineChars: line.length });
      return;
    }
    const msg = asRecord(parsed);
    if (!msg) {
      this.log.warn("ignoring non-object message from codex");
      return;
    }
    const m = msg as unknown as JsonRpcMessage;
    if (typeof m.method === "string") {
      if (m.id !== undefined) this.handleServerRequest(m);
      else this.handleNotification(m);
      return;
    }
    if (m.id !== undefined) {
      const key = String(m.id);
      if (this.approvalResponseIds.has(key)) {
        // Reply to an approval answer we sent (usually an error because
        // the server had already resolved the request). Expected; drop it.
        this.approvalResponseIds.delete(key);
        if (m.error) this.log.warn("codex rejected an approval answer", { code: m.error.code });
        return;
      }
      const pending = this.pendingRequests.get(typeof m.id === "number" ? m.id : -1);
      if (!pending) {
        this.log.warn("ignoring response for unknown request id", { id: key });
        return;
      }
      this.pendingRequests.delete(typeof m.id === "number" ? m.id : -1);
      if (m.error) {
        pending.reject(
          new Error(`codex ${pending.method} failed: ${m.error.message ?? "unknown error"} (code ${m.error.code ?? "?"})`),
        );
      } else {
        pending.resolve(m.result);
      }
      return;
    }
    this.log.warn("ignoring message from codex with neither method nor id");
  }

  // -- server-initiated requests (approvals) --------------------------------

  private handleServerRequest(m: JsonRpcMessage): void {
    const method = m.method ?? "";
    const id = m.id as number | string;
    const params = asRecord(m.params) ?? {};
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval": {
        this.handleApprovalRequest(id, method, params);
        return;
      }
      default: {
        // Legacy approval requests (applyPatchApproval, execCommandApproval),
        // client-tool calls (item/tool/call), elicitation and user-input
        // prompts are NOT wired into the companion protocol. Answer with
        // -32601 so the turn fails loudly instead of hanging forever.
        this.log.warn("unsupported server request from codex; answering -32601", { method });
        this.respondError(id, -32601, `method ${method} is not supported by the companion server`);
        return;
      }
    }
  }

  private handleApprovalRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    const itemId = asString(params.itemId);
    const threadId = asString(params.threadId);
    const turnId = asString(params.turnId);
    if (!itemId || !threadId || !turnId) {
      this.log.warn("approval request missing itemId/threadId/turnId; answering -32602", { method });
      this.respondError(id, -32602, "approval request is missing itemId, threadId or turnId");
      return;
    }
    const kind: ApprovalKind =
      method === "item/fileChange/requestApproval"
        ? "fileChange"
        : method === "item/permissions/requestApproval"
          ? "permissions"
          : "commandExecution";
    const offered = this.offeredDecisions(kind, params.availableDecisions);
    const record: PendingApprovalRecord = {
      rpcId: id,
      kind,
      threadId,
      turnId,
      itemId,
      availableDecisions: offered,
      params,
    };
    this.pendingApprovals.set(itemId, record);
    const event: CodexEvent = {
      kind: `item.${kind === "permissions" ? "permissions" : kind}/requestApproval` as CodexEventKind,
      threadId,
      turnId,
      itemId,
      availableDecisions: offered,
      command: asString(params.command),
      cwd: asString(params.cwd),
      reason: asString(params.reason),
    };
    const network = asRecord(params.networkApprovalContext);
    if (network) {
      event.networkApprovalContext = {
        host: asString(network.host),
        protocol: asString(network.protocol),
      };
    }
    if (kind === "permissions") {
      event.permissions = summarizePermissions(asRecord(params.permissions));
    }
    this.emit(event);
  }

  /**
   * `availableDecisions` is optional on the wire (absent from the
   * 0.164.0-alpha.9 schema): use it when present and valid, else the
   * safe per-kind default. Unknown values are filtered out.
   */
  private offeredDecisions(kind: ApprovalKind, raw: unknown): ApprovalDecision[] {
    const defaults =
      kind === "permissions"
        ? this.opts.allowPersistentApprovals
          ? (["accept", "acceptForSession", "decline", "cancel"] as ApprovalDecision[])
          : DEFAULT_PERMISSIONS_DECISIONS
        : DEFAULT_COMMAND_DECISIONS;
    if (!Array.isArray(raw)) return defaults;
    const offered = raw.filter((d): d is ApprovalDecision => typeof d === "string" && (ALL_DECISIONS as string[]).includes(d));
    if (offered.length === 0) return defaults;
    if (!this.opts.allowPersistentApprovals) {
      // Persistent grants are server-blocked by default even when the
      // request offers them: drop them from what the phone may offer.
      const filtered = offered.filter((d) => !RESTRICTED_DECISIONS.includes(d));
      return filtered.length > 0 ? filtered : defaults;
    }
    return offered;
  }

  private buildApprovalResult(pending: PendingApprovalRecord, decision: ApprovalDecision): Record<string, unknown> {
    if (pending.kind === "permissions") {
      const requested = asRecord(pending.params.permissions) ?? {};
      if (decision === "accept") return { permissions: requested, scope: "turn" };
      if (decision === "acceptForSession") return { permissions: requested, scope: "session" };
      return { permissions: {}, scope: "turn" }; // decline | cancel: grant nothing
    }
    if (pending.kind === "commandExecution" && decision === "acceptWithExecpolicyAmendment") {
      const amendment = asStringArray(pending.params.proposedExecpolicyAmendment) ?? [];
      return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } } };
    }
    if (pending.kind === "commandExecution" && decision === "applyNetworkPolicyAmendment") {
      const proposed = Array.isArray(pending.params.proposedNetworkPolicyAmendments)
        ? pending.params.proposedNetworkPolicyAmendments[0]
        : undefined;
      return { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: asRecord(proposed) ?? {} } } };
    }
    return { decision };
  }

  // -- server notifications --------------------------------------------------

  private handleNotification(m: JsonRpcMessage): void {
    const method = m.method ?? "";
    const params = asRecord(m.params) ?? {};
    switch (method) {
      case "thread/started": {
        const thread = asRecord(params.thread);
        const threadId = asString(thread?.id);
        if (threadId) this.emit({ kind: "thread.started", threadId });
        return;
      }
      case "turn/started": {
        const turn = asRecord(params.turn);
        const turnId = asString(turn?.id);
        const threadId = asString(params.threadId);
        if (turnId && threadId) this.touchTurn(turnId, threadId);
        return;
      }
      case "turn/completed": {
        const turn = asRecord(params.turn);
        const turnId = asString(turn?.id);
        const threadId = asString(params.threadId);
        const status = asString(turn?.status);
        if (!turnId || !threadId) return;
        this.activeTurns.delete(turnId);
        this.emit({
          kind: "turn.completed",
          threadId,
          turnId,
          status: status === "completed" || status === "interrupted" || status === "failed" ? status : "completed",
        });
        return;
      }
      case "turn/plan/updated": {
        const plan = Array.isArray(params.plan) ? params.plan : [];
        const turnId = asString(params.turnId);
        const threadId = asString(params.threadId);
        if (!threadId || !turnId) return;
        this.touchTurn(turnId, threadId);
        this.emit({ kind: "plan.updated", threadId, turnId, summary: summarizePlan(plan) });
        return;
      }
      case "item/started": {
        const item = asRecord(params.item);
        const itemId = asString(item?.id);
        const threadId = asString(params.threadId);
        const turnId = asString(params.turnId);
        if (!threadId || !turnId || !itemId) return;
        this.touchTurn(turnId, threadId);
        this.emit({ kind: "item.started", threadId, turnId, itemId, itemType: translateItemType(asString(item?.type)) });
        return;
      }
      case "item/completed": {
        const item = asRecord(params.item);
        const itemId = asString(item?.id);
        const threadId = asString(params.threadId);
        const turnId = asString(params.turnId);
        if (!threadId || !turnId || !itemId) return;
        this.touchTurn(turnId, threadId);
        const itemType = translateItemType(asString(item?.type));
        this.emit({
          kind: "item.completed",
          threadId,
          turnId,
          itemId,
          itemType,
          status: mapItemStatus(item),
          summary: summarizeItem(item, itemType),
        });
        return;
      }
      case "item/agentMessage/delta": {
        const threadId = asString(params.threadId);
        const turnId = asString(params.turnId);
        const itemId = asString(params.itemId);
        const delta = asString(params.delta) ?? "";
        if (!threadId || !turnId || !itemId) return;
        this.touchTurn(turnId, threadId);
        let out = delta;
        if (out.length > this.opts.maxDeltaChars) {
          out = `${out.slice(0, this.opts.maxDeltaChars)}…[truncated]`;
          if (!this.truncatedItems.has(itemId)) {
            this.truncatedItems.add(itemId);
            this.log.warn("agentMessage delta truncated", { itemId, chars: delta.length });
          }
        }
        this.emit({ kind: "item.agentMessage/delta", threadId, turnId, itemId, delta: out });
        return;
      }
      case "serverRequest/resolved": {
        const requestId = params.requestId;
        if (requestId === undefined) return;
        const key = String(requestId);
        if (this.answeredRpcIds.has(key)) {
          this.answeredRpcIds.delete(key);
          return;
        }
        // The server cleared a request we had not answered: it is dead.
        for (const [itemId, p] of [...this.pendingApprovals]) {
          if (String(p.rpcId) === key) {
            this.pendingApprovals.delete(itemId);
            this.emit({
              kind: "approval.cleared",
              threadId: p.threadId,
              turnId: p.turnId,
              itemId,
              reason: "cleared by codex before an answer was given",
            });
            return;
          }
        }
        return;
      }
      case "error": {
        const threadId = asString(params.threadId);
        const turnId = asString(params.turnId);
        if (!threadId || !turnId) return;
        this.touchTurn(turnId, threadId);
        this.emit({
          kind: "session.error",
          threadId,
          turnId,
          summary: oneLineError(params.error),
        });
        return;
      }
      case "configWarning": {
        this.log.warn("codex config warning", { message: truncate(asString(params.message) ?? "", 300) });
        return;
      }
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
      case "command/exec/outputDelta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/plan/delta": {
        // Raw tool / reasoning output: deliberately never forwarded to
        // events or logs. Still counts as turn activity.
        const turnId = asString(params.turnId);
        const threadId = asString(params.threadId);
        if (turnId && threadId) this.touchTurn(turnId, threadId);
        return;
      }
      default: {
        this.log.warn("ignoring unknown codex notification", { method });
        return;
      }
    }
  }

  private touchTurn(turnId: string, threadId: string): void {
    const t = this.activeTurns.get(turnId);
    if (t) t.lastActivityAt = Date.now();
  }

  // -- CodexAdapter ----------------------------------------------------------

  private toThreadSummary(thread: unknown): ThreadSummary {
    const t = asRecord(thread) ?? {};
    const status = asRecord(t.status);
    const preview = asString(t.preview);
    return {
      threadId: asString(t.id) ?? "",
      cwd: asString(t.cwd) ?? "",
      title: asString(t.name) ?? (preview ? truncate(preview, 80) : "session"),
      status: asString(status?.type) ?? "unknown",
    };
  }

  async listThreads(opts?: { limit?: number; cursor?: string | null }): Promise<ThreadSummary[]> {
    const params: Record<string, unknown> = {};
    if (opts?.limit !== undefined) params.limit = opts.limit;
    if (opts?.cursor !== undefined) params.cursor = opts.cursor;
    const res = await this.request("thread/list", params);
    const data = asRecord(res)?.data;
    if (!Array.isArray(data)) return [];
    return data.map((t) => this.toThreadSummary(t));
  }

  async createThread(opts: { cwd: string; model?: string; title?: string }): Promise<ThreadSummary> {
    const params: Record<string, unknown> = {
      cwd: opts.cwd,
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      sandbox: DEFAULT_SANDBOX,
    };
    if (opts.model) params.model = opts.model;
    const res = await this.request("thread/start", params);
    const thread = asRecord(asRecord(res)?.thread) ?? asRecord(res);
    const summary = this.toThreadSummary(thread);
    this.knownThreads.add(summary.threadId);
    if (opts.title) {
      // Cosmetic: a failed rename must not fail thread creation.
      try {
        await this.request("thread/name/set", { threadId: summary.threadId, name: opts.title });
        summary.title = opts.title;
      } catch (err) {
        this.log.warn("thread/name/set failed; keeping the server-side title", { threadId: summary.threadId, msg: String(err) });
      }
    }
    this.log.info("thread created", { threadId: summary.threadId, cwdChars: opts.cwd.length });
    this.emit({ kind: "thread.started", threadId: summary.threadId });
    return summary;
  }

  async resumeThread(threadId: string): Promise<ThreadSummary> {
    const res = await this.request("thread/resume", { threadId });
    const thread = asRecord(asRecord(res)?.thread) ?? asRecord(res);
    const summary = this.toThreadSummary(thread);
    this.knownThreads.add(summary.threadId);
    this.emit({ kind: "thread.started", threadId: summary.threadId });
    return summary;
  }

  async readThread(threadId: string): Promise<ThreadSummary & { turns: unknown[]; items: unknown[] }> {
    const res = await this.request("thread/read", { threadId, includeTurns: false });
    const thread = asRecord(asRecord(res)?.thread) ?? asRecord(res);
    const summary = this.toThreadSummary(thread);
    // History is paged, never dumped whole: first page only (HISTORY_LIMIT).
    // Callers must not forward raw items to clients without summarising.
    const turnsRes = await this.request("thread/turns/list", { threadId, limit: HISTORY_LIMIT });
    const itemsRes = await this.request("thread/items/list", { threadId, limit: HISTORY_LIMIT });
    const turns = asRecord(turnsRes)?.data;
    const items = asRecord(itemsRes)?.data;
    return {
      ...summary,
      turns: Array.isArray(turns) ? turns : [],
      items: Array.isArray(items) ? items : [],
    };
  }

  async startTurn(threadId: string, input: string): Promise<TurnHandle> {
    const res = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: input }],
    });
    const turn = asRecord(asRecord(res)?.turn) ?? asRecord(res);
    const turnId = asString(turn?.id) ?? "";
    if (!turnId) throw new Error("turn/start returned no turn id");
    this.activeTurns.set(turnId, { threadId, lastActivityAt: Date.now() });
    this.log.info("turn started", { threadId, turnId, inputChars: input.length });
    return { turnId, threadId };
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
    this.activeTurns.delete(turnId);
  }

  async respondApproval(req: ApprovalRequest, decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(req.itemId);
    if (!pending) return; // Already answered / cleared: nothing to resume.
    // Same order as ApprovalStore.respond: offered first, then the
    // persistent-grant gate (defence in depth; the store already blocks).
    if (!pending.availableDecisions.includes(decision)) {
      throw new Error(
        `decision "${decision}" was not offered by this request (offered: ${pending.availableDecisions.join(", ")})`,
      );
    }
    if (RESTRICTED_DECISIONS.includes(decision) && !this.opts.allowPersistentApprovals) {
      throw new Error(`decision "${decision}" is a persistent grant and is not enabled on this server`);
    }
    const result = this.buildApprovalResult(pending, decision);
    this.pendingApprovals.delete(req.itemId);
    this.answeredRpcIds.set(String(pending.rpcId), Date.now());
    if (this.answeredRpcIds.size > 1000) {
      const oldest = [...this.answeredRpcIds.entries()].sort((a, b) => a[1] - b[1]).slice(0, 500);
      for (const [k] of oldest) this.answeredRpcIds.delete(k);
    }
    this.approvalResponseIds.add(String(pending.rpcId));
    this.writeLine({ jsonrpc: "2.0", id: pending.rpcId, result });
  }

  cancelPendingApproval(itemId: string, reason: string): void {
    const pending = this.pendingApprovals.get(itemId);
    if (!pending) return;
    this.pendingApprovals.delete(itemId);
    // Answer the server's request with the safe default so the turn is
    // not left hanging: decline (or an empty permission grant). Never a
    // grant, never a turn interrupt from this path.
    try {
      const result: Record<string, unknown> =
        pending.kind === "permissions" ? { permissions: {}, scope: "turn" } : { decision: "decline" };
      this.approvalResponseIds.add(String(pending.rpcId));
      this.writeLine({ jsonrpc: "2.0", id: pending.rpcId, result });
      this.log.info("approval cleared, answered decline to codex", { itemId, reason });
    } catch (err) {
      this.log.warn("could not answer cleared approval", { itemId, reason, msg: String(err) });
    }
  }
}

function translateItemType(wire: string | undefined): string {
  if (!wire) return "unknown";
  return ITEM_TYPE_MAP[wire] ?? wire;
}

function mapItemStatus(item: Record<string, unknown> | null): string {
  const s = asString(item?.status);
  if (s === "completed" || s === "failed" || s === "declined") return s;
  return "completed";
}

/** Metadata-only summary: exit code / duration / file count. Never raw output. */
function summarizeItem(item: Record<string, unknown> | null, itemType: string): string | undefined {
  if (!item) return undefined;
  if (itemType === "command_execution") {
    const exitCode = item.exitCode;
    const duration = typeof item.durationMs === "number" ? ` in ${item.durationMs}ms` : "";
    return `exit ${typeof exitCode === "number" ? exitCode : "?"}${duration}`;
  }
  if (itemType === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes.length : 0;
    return `${changes} file(s) ${asString(item.status) ?? ""}`.trim();
  }
  if (itemType === "todo_list") {
    return truncate(asString(item.text) ?? "plan updated", 200);
  }
  return undefined;
}

function summarizePlan(plan: unknown[]): string {
  for (const step of plan) {
    const s = asRecord(step);
    const status = asString(s?.status);
    const text = asString(s?.step);
    if (text && status !== "completed") return truncate(text, 200);
  }
  const first = asRecord(plan[0]);
  const text = asString(first?.step);
  if (text) return truncate(text, 200);
  return `plan updated (${plan.length} step${plan.length === 1 ? "" : "s"})`;
}

/** One-line permission summaries for the approval card (paths/hosts only). */
function summarizePermissions(perms: Record<string, unknown> | null): string[] {
  if (!perms) return [];
  const out: string[] = [];
  const fs = asRecord(perms.fileSystem);
  const entries = Array.isArray(fs?.entries) ? fs.entries : [];
  for (const e of entries.slice(0, 5)) {
    const r = asRecord(e);
    if (!r) continue;
    const p = asString(r.path) ?? asString(r.glob) ?? "";
    const access = asString(r.access) ?? asString(r.mode) ?? "";
    if (p) out.push(truncate(`fs ${access ? `${access} ` : ""}${p}`, 120));
  }
  const net = asRecord(perms.network);
  if (net && net.enabled === true) out.push("network enabled");
  return out;
}

function oneLineError(error: unknown): string {
  if (typeof error === "string") return truncate(error, 200);
  const r = asRecord(error);
  if (r) {
    const msg = asString(r.message) ?? asString(r.code) ?? "";
    if (msg) return truncate(msg, 200);
  }
  return "codex reported an error";
}
