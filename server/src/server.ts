import http from "node:http";
import net from "node:net";
import { URL } from "node:url";
import { PROTOCOL_VERSION, type CommandResult } from "../../packages/protocol/src/types.js";
import type { ServerConfig } from "./config.js";
import { Store } from "./db.js";
import { Logger } from "./logging.js";
import { EventBus } from "./modules/events/event-bus.js";
import { PairingService } from "./modules/auth/pairing.js";
import { ProjectsService } from "./modules/projects/projects.js";
import { ApprovalError, ApprovalStore } from "./modules/approvals/approvals.js";
import type { CodexAdapter } from "./modules/codex/adapter.js";
import { MockCodexAdapter } from "./modules/codex/mock-adapter.js";
import { RealCodexAdapter } from "./modules/codex/real-adapter.js";
import { SessionsService } from "./modules/sessions/sessions.js";
import { handleWsUpgrade, isLoopbackAddress, type WsConnection } from "./ws.js";

const SERVER_VERSION = "0.1.0";
const MAX_BODY_BYTES = 1_000_000;

interface WsClient {
  conn: WsConnection;
  deviceId: string;
  sessionFilter: string | null;
  sessions: Set<string>;
}

function jsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function bearerToken(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) {
    return h.slice(7).trim();
  }
  return null;
}

/**
 * Companion server (Phase 1): REST + WebSocket over one HTTP listener.
 *
 * Security boundaries (README):
 * - Binds 127.0.0.1 by default; a LAN host is only used when explicitly
 *   configured, and every request still needs a paired token.
 * - No generic shell API anywhere. The only way to run anything is the
 *   CodexAdapter (mock in this phase, real app-server in Phase 2), and
 *   every command is checked against the paired device, the session and
 *   the workspace allow-list first.
 * - Pairing codes are created loopback-only; tokens are stored hashed
 *   and never logged. Codex auth material is never accepted, stored or
 *   forwarded by this server.
 * - In real mode the adapter is the RealCodexAdapter (stdio to a local
 *   `codex app-server`); a missing binary or an outdated CLI version
 *   fails server startup loudly — it never silently falls back to mock.
 */
export class CompanionServer {
  private readonly log = new Logger("companion");
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly pairing: PairingService;
  private readonly projects: ProjectsService;
  private readonly approvals: ApprovalStore;
  private readonly sessions: SessionsService;
  private readonly adapter: CodexAdapter;
  private readonly httpServer: http.Server;
  private readonly clients = new Set<WsClient>();
  private readonly sessionClients = new Map<string, Set<WsClient>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reapTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: ServerConfig) {
    this.store = new Store(config.dataDir, config.maxEvents);
    this.bus = new EventBus(this.store);
    this.pairing = new PairingService(this.store, config.pairingCodeTtlMs);
    this.projects = new ProjectsService(config.workspaces);
    this.adapter =
      config.codexMode === "real"
        ? new RealCodexAdapter({
            bin: config.codexBin,
            args: config.codexArgs,
            versionArgs: config.codexVersionArgs,
            minVersion: config.codexMinVersion,
            rpcTimeoutMs: config.codexRpcTimeoutMs,
            turnIdleTimeoutMs: config.codexTurnIdleTimeoutMs,
            maxDeltaChars: config.codexMaxDeltaChars,
            reconnectAttempts: config.codexReconnectAttempts,
            reconnectDelayMs: config.codexReconnectDelayMs,
            allowPersistentApprovals: config.allowPersistentApprovals,
          })
        : new MockCodexAdapter(config.mockScript);
    this.approvals = new ApprovalStore(
      this.store,
      config.approvalTtlMs,
      config.allowPersistentApprovals,
      (itemId, reason) => this.onApprovalCleared(itemId, reason),
    );
    this.sessions = new SessionsService(
      this.store,
      this.projects,
      this.adapter,
      this.bus,
      this.approvals,
    );
    this.bus.subscribe((event) => {
      const text = JSON.stringify({ type: "event", event });
      for (const client of this.clients) {
        if (client.sessionFilter && event.sessionId !== "" && event.sessionId !== client.sessionFilter) continue;
        client.conn.sendText(text);
      }
    });
    this.httpServer = http.createServer((req, res) => {
      void this.handleRest(req, res).catch((err: unknown) => {
        this.log.error("rest handler failed", { msg: String(err) });
        if (!res.headersSent) this.sendJson(res, 500, { error: { code: "internal", message: "internal error" } });
      });
    });
    this.httpServer.on("upgrade", (req, socket) => {
      const url = new URL(req.url ?? "/ws", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get("token") ?? bearerToken(req);
      const deviceId = token ? this.pairing.verifyToken(token) : null;
      if (!deviceId) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!handleWsUpgrade(req, socket as net.Socket, (conn) => this.onWsConnected(conn, deviceId))) {
        socket.destroy();
      }
    });
  }

  // -- approval lifecycle ------------------------------------------------
  private onApprovalCleared(itemId: string, reason: string): void {
    const row = this.store.getApproval(itemId);
    if (!row) return;
    this.adapter.cancelPendingApproval(itemId, reason);
    this.bus.publish(row.session_id, "approval.resolved", {
      itemId,
      threadId: row.thread_id,
      turnId: row.turn_id,
      status: reason === "expired" ? "expired" : "cleared",
      reason,
    });
  }

  // -- REST ---------------------------------------------------------------
  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  }

  private authedDevice(req: http.IncomingMessage): string | null {
    const token = bearerToken(req);
    return token ? this.pairing.verifyToken(token) : null;
  }

  private async handleRest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";
    const remote = req.socket.remoteAddress ?? "";

    if (method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`codex-flutter companion ${SERVER_VERSION} (${this.config.codexMode} adapter, protocol ${PROTOCOL_VERSION})\n`);
      return;
    }
    if (method === "GET" && path === "/healthz") {
      const codexStatus = this.adapter.status?.() ?? {
        mode: this.config.codexMode,
        version: null,
        connected: false,
      };
      this.sendJson(res, 200, {
        status: "ok",
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: SERVER_VERSION,
        codex: {
          ...codexStatus,
          ...(this.config.codexMode === "mock" ? { script: this.config.mockScript } : {}),
        },
        time: new Date().toISOString(),
      });
      return;
    }
    if (method === "POST" && path === "/api/v1/pairing/code") {
      // Pairing codes are minted on the desktop itself, never over the LAN.
      if (!isLoopbackAddress(remote)) {
        this.sendJson(res, 403, { error: { code: "forbidden", message: "pairing codes can only be created on the desktop (loopback)" } });
        return;
      }
      const { code, expiresAt } = this.pairing.createCode();
      this.log.info("pairing code created", { expiresAt });
      this.sendJson(res, 200, { code, expiresAt });
      return;
    }
    if (method === "POST" && path === "/api/v1/pairing/claim") {
      const body = (await jsonBody(req)) as { code?: string; deviceName?: string };
      if (typeof body.code !== "string" || typeof body.deviceName !== "string" || !body.deviceName.trim()) {
        this.sendJson(res, 400, { error: { code: "bad-request", message: "code and deviceName are required" } });
        return;
      }
      const issued = this.pairing.claim(body.code, body.deviceName.trim());
      if (!issued) {
        this.sendJson(res, 401, { error: { code: "invalid-code", message: "pairing code is wrong, expired, or already used" } });
        return;
      }
      this.log.info("device paired", { deviceId: issued.deviceId });
      this.sendJson(res, 200, { deviceId: issued.deviceId, token: issued.token });
      return;
    }

    // All remaining REST endpoints need a paired device token.
    const deviceId = this.authedDevice(req);
    if (!deviceId) {
      this.sendJson(res, 401, { error: { code: "unauthorized", message: "missing or invalid bearer token" } });
      return;
    }
    if (method === "POST" && path === "/api/v1/pairing/revoke") {
      const body = (await jsonBody(req)) as { deviceId?: string };
      const target = typeof body.deviceId === "string" ? body.deviceId : deviceId;
      if (target !== deviceId) {
        this.sendJson(res, 403, { error: { code: "forbidden", message: "a device can only revoke itself" } });
        return;
      }
      this.pairing.revoke(target);
      this.sendJson(res, 200, { revoked: true });
      return;
    }
    if (method === "GET" && path === "/api/v1/projects") {
      this.sendJson(res, 200, { projects: this.projects.list() });
      return;
    }
    if (method === "GET" && path === "/api/v1/sessions") {
      this.sendJson(res, 200, { sessions: this.sessions.listSessions() });
      return;
    }
    const historyMatch = /^\/api\/v1\/sessions\/([^/]+)\/history$/.exec(path);
    if (method === "GET" && historyMatch) {
      const sessionId = decodeURIComponent(historyMatch[1]);
      if (!this.store.getSession(sessionId)) {
        this.sendJson(res, 404, { error: { code: "not-found", message: `unknown session: ${sessionId}` } });
        return;
      }
      const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0") || 0;
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "500") || 500, 1000);
      const replay = this.bus.historyForSession(sessionId, afterSeq, limit);
      this.sendJson(res, 200, {
        sessionId,
        snapshotRequired: replay.snapshotRequired,
        events: replay.events,
      });
      return;
    }
    this.sendJson(res, 404, { error: { code: "not-found", message: `no such route: ${method} ${path}` } });
  }

  // -- WebSocket -----------------------------------------------------------
  private onWsConnected(conn: WsConnection, deviceId: string): void {
    const client: WsClient = { conn, deviceId, sessionFilter: null, sessions: new Set() };
    this.clients.add(client);
    this.log.info("ws client connected", { deviceId });
    conn.onMessage = (text) => {
      void this.handleWsMessage(client, text).catch((err: unknown) => {
        this.log.error("ws handler failed", { msg: String(err) });
        conn.sendText(JSON.stringify({ type: "command-result", requestId: "", ok: false, error: { code: "internal", message: "internal error" } }));
      });
    };
    conn.onClose = () => {
      this.clients.delete(client);
      for (const sessionId of client.sessions) {
        const set = this.sessionClients.get(sessionId);
        if (set) {
          set.delete(client);
          if (set.size === 0) {
            // Last viewer of this session disconnected: any approval still
            // waiting on that phone is dead — clear it, do not leave it
            // answerable after the client is gone.
            this.approvals.clearForSession(sessionId, "disconnected");
            this.sessionClients.delete(sessionId);
          }
        }
      }
      this.log.info("ws client disconnected", { deviceId });
    };
  }

  private trackSession(client: WsClient, sessionId: string): void {
    client.sessions.add(sessionId);
    let set = this.sessionClients.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionClients.set(sessionId, set);
    }
    set.add(client);
  }

  private result(requestId: string, ok: boolean, data?: Record<string, unknown>, error?: { code: string; message: string }): CommandResult {
    return { type: "command-result", requestId, ok, ...(data ? { data } : {}), ...(error ? { error } : {}) };
  }

  private async handleWsMessage(client: WsClient, text: string): Promise<void> {
    let msg: { type?: string; requestId?: string; command?: string; payload?: Record<string, unknown>; lastSeq?: number; sessionId?: string };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      client.conn.sendText(JSON.stringify(this.result("", false, undefined, { code: "bad-request", message: "invalid JSON" })));
      return;
    }

    if (msg.type === "subscribe") {
      const lastSeq = typeof msg.lastSeq === "number" ? msg.lastSeq : 0;
      if (typeof msg.sessionId === "string" && msg.sessionId) {
        client.sessionFilter = msg.sessionId;
        this.trackSession(client, msg.sessionId);
      }
      const replay = this.bus.replaySince(lastSeq);
      if (replay.snapshotRequired) {
        client.conn.sendText(JSON.stringify({ type: "snapshot-required", lastSeq, floorSeq: this.store.floorSeq() }));
      } else {
        for (const event of replay.events) {
          if (client.sessionFilter && event.sessionId !== "" && event.sessionId !== client.sessionFilter) continue;
          client.conn.sendText(JSON.stringify({ type: "event", event }));
        }
        client.conn.sendText(JSON.stringify({ type: "replay-complete", lastSeq, count: replay.events.length }));
      }
      return;
    }

    if (msg.type !== "command" || typeof msg.requestId !== "string" || !msg.requestId || typeof msg.command !== "string") {
      client.conn.sendText(JSON.stringify(this.result(typeof msg.requestId === "string" ? msg.requestId : "", false, undefined, { code: "bad-request", message: "expected {type:'command', requestId, command, payload}" })));
      return;
    }

    const requestId = msg.requestId;
    const dedupKey = `${client.deviceId}:${requestId}`;
    const stored = this.store.getProcessedRequest(dedupKey);
    if (stored) {
      const prev = JSON.parse(stored) as CommandResult;
      client.conn.sendText(JSON.stringify({ ...prev, deduped: true }));
      return;
    }

    const payload = msg.payload ?? {};
    let reply: CommandResult;
    try {
      const data = await this.dispatchCommand(client, msg.command, payload);
      reply = this.result(requestId, true, data);
    } catch (err) {
      const code = err instanceof ApprovalError ? err.code : err instanceof Error && err.message.startsWith("unknown ") ? "not-found" : "bad-request";
      reply = this.result(requestId, false, undefined, { code, message: err instanceof Error ? err.message : String(err) });
    }
    if (reply.ok) this.store.storeProcessedRequest(dedupKey, client.deviceId, JSON.stringify(reply));
    client.conn.sendText(JSON.stringify(reply));
  }

  private async dispatchCommand(
    client: WsClient,
    command: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (command) {
      case "session.create": {
        const projectId = String(payload.projectId ?? "");
        const cwd = String(payload.cwd ?? "");
        const title = typeof payload.title === "string" ? payload.title : undefined;
        const session = await this.sessions.createSession({ projectId, cwd, title });
        this.trackSession(client, session.sessionId);
        return { ...session };
      }
      case "session.resume": {
        const sessionId = String(payload.sessionId ?? "");
        const session = await this.sessions.resumeSession(sessionId);
        this.trackSession(client, sessionId);
        return { ...session };
      }
      case "message.send": {
        const sessionId = String(payload.sessionId ?? "");
        const text = String(payload.text ?? "");
        this.trackSession(client, sessionId);
        const { turnId } = await this.sessions.sendMessage(sessionId, text);
        return { sessionId, turnId };
      }
      case "session.cancel": {
        const sessionId = String(payload.sessionId ?? "");
        const { cancelledTurnId } = await this.sessions.cancelSession(sessionId);
        return { sessionId, cancelledTurnId };
      }
      case "approval.respond": {
        const sessionId = String(payload.sessionId ?? "");
        const itemId = String(payload.itemId ?? "");
        const decision = String(payload.decision ?? "");
        const row = this.store.getApproval(itemId);
        if (!row) throw new ApprovalError("approval-not-found", `unknown approval: ${itemId}`);
        if (row.session_id !== sessionId) {
          throw new ApprovalError("approval-not-found", `approval ${itemId} does not belong to session ${sessionId}`);
        }
        const resolved = this.approvals.respond(itemId, decision as never);
        this.bus.publish(sessionId, "approval.resolved", { ...resolved });
        await this.adapter.respondApproval(
          {
            itemId,
            threadId: row.thread_id,
            turnId: row.turn_id,
            kind: row.kind as "commandExecution" | "fileChange" | "permissions",
            availableDecisions: JSON.parse(row.available_decisions),
          },
          decision as never,
        );
        return { ...resolved };
      }
      default:
        throw new Error(`unknown command: ${command}`);
    }
  }

  // -- lifecycle ------------------------------------------------------------
  async start(): Promise<void> {
    await this.adapter.start();
    this.heartbeatTimer = setInterval(() => {
      this.bus.publish("", "connection.heartbeat", { serverTime: new Date().toISOString() });
    }, this.config.heartbeatIntervalMs);
    // Avoid an unref'd timer keeping the process alive in tests; the
    // companion run via `npm start` still stays alive on its HTTP server.
    this.heartbeatTimer.unref();
    this.reapTimer = setInterval(() => {
      this.approvals.reapExpired();
    }, 1000);
    this.reapTimer.unref();
    await new Promise<void>((resolve) => {
      this.httpServer.listen(this.config.port, this.config.host, () => {
        this.log.info("companion listening", { host: this.config.host, port: this.config.port });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reapTimer) clearInterval(this.reapTimer);
    for (const client of [...this.clients]) client.conn.close();
    this.clients.clear();
    await this.adapter.stop();
    this.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
    this.store.close();
  }

  address(): { host: string; port: number } {
    const addr = this.httpServer.address();
    if (addr && typeof addr === "object") return { host: addr.address, port: addr.port };
    return { host: this.config.host, port: this.config.port };
  }
}
