import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { CompanionServer } from "../src/server.js";
import { defaultConfig, type ServerConfig } from "../src/config.js";
import { redact } from "../src/logging.js";

const PROTOCOL_DIR = path.resolve(process.cwd(), "..", "packages", "protocol");

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface TestEnv {
  server: CompanionServer;
  base: string;
  wsRoot: string;
  token: string;
}

async function boot(overrides: Partial<ServerConfig> = {}): Promise<TestEnv> {
  const wsRoot = tmpDir("codex-flutter-ws-");
  const projectDir = path.join(wsRoot, "demo");
  fs.mkdirSync(projectDir, { recursive: true });
  const server = new CompanionServer(
    defaultConfig({
      port: 0,
      host: "127.0.0.1",
      dataDir: tmpDir("codex-flutter-data-"),
      workspaces: [{ id: "demo", name: "demo", path: wsRoot }],
      heartbeatIntervalMs: 1000,
      approvalTtlMs: 60_000,
      ...overrides,
    }),
  );
  await server.start();
  const { host, port } = server.address();
  const base = `http://${host}:${port}`;
  const codeRes = await fetch(`${base}/api/v1/pairing/code`, { method: "POST", headers: { connection: "close" } });
  assert.equal(codeRes.status, 200, "pairing code must be issuable on loopback");
  const { code } = (await codeRes.json()) as { code: string };
  const claimRes = await fetch(`${base}/api/v1/pairing/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", connection: "close" },
    body: JSON.stringify({ code, deviceName: "test-phone" }),
  });
  assert.equal(claimRes.status, 200, "pairing claim must succeed");
  const { token } = (await claimRes.json()) as { token: string };
  assert.equal(typeof token, "string");
  assert.ok(token.length >= 32, "token must be high-entropy");
  return { server, base, wsRoot, token };
}

interface WsMsg {
  type: string;
  [k: string]: unknown;
}

class WsClient {
  private ws: WebSocket;
  readonly events: Array<Record<string, unknown>> = [];
  readonly results = new Map<string, Record<string, unknown>>();
  readonly raw: WsMsg[] = [];
  private waiters: Array<{ pred: (m: WsMsg) => boolean; resolve: (m: WsMsg) => void }> = [];
  readonly opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("ws connect failed"));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as WsMsg;
      this.raw.push(msg);
      if (msg.type === "event") this.events.push((msg.event ?? {}) as Record<string, unknown>);
      if (msg.type === "command-result" && typeof msg.requestId === "string") {
        this.results.set(msg.requestId as string, msg);
      }
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    };
  }

  waitFor(pred: (m: WsMsg) => boolean, timeoutMs = 5000): Promise<WsMsg> {
    for (const m of this.raw) if (pred(m)) return Promise.resolve(m);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ws message after ${timeoutMs}ms`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  async command(requestId: string, command: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.opened;
    this.results.delete(requestId);
    const p = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for command-result ${requestId}`)), 5000);
      const check = () => {
        const r = this.results.get(requestId);
        if (r) {
          clearTimeout(timer);
          resolve(r);
        } else {
          setTimeout(check, 5);
        }
      };
      check();
    });
    this.ws.send(JSON.stringify({ type: "command", requestId, command, payload }));
    return p;
  }

  subscribe(lastSeq = 0, sessionId?: string): void {
    this.ws.send(JSON.stringify({ type: "subscribe", lastSeq, ...(sessionId ? { sessionId } : {}) }));
  }

  close(): void {
    this.ws.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Protocol schema + fixtures
// ---------------------------------------------------------------------------

test("protocol schema: every fixture validates, invented event names fail", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(PROTOCOL_DIR, "schema", "protocol.schema.json"), "utf8"));
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(schema);
  const fixturesDir = path.join(PROTOCOL_DIR, "fixtures");
  const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 6, `expected fixtures, got ${files.length}`);
  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), "utf8"));
    assert.equal(validate(fixture), true, `${file} must validate: ${JSON.stringify(validate.errors)}`);
  }
  const bad = {
    protocolVersion: "1.0.0",
    eventId: "evt_bad",
    seq: 1,
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "session.teleported",
    payload: {},
  };
  assert.equal(validate(bad), false, "an invented event name must not validate");
});

test("logging redaction: tokens and secrets never reach logs", () => {
  const token = "a".repeat(64);
  const redacted = redact({ token, nested: { authorization: `Bearer ${token}`, note: `saw ${token} here` } }) as Record<string, unknown>;
  assert.equal(redacted.token, "[redacted]");
  assert.equal((redacted.nested as Record<string, unknown>).authorization, "[redacted]");
  assert.match(String((redacted.nested as Record<string, unknown>).note), /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(token));
});

// ---------------------------------------------------------------------------
// Pairing + auth
// ---------------------------------------------------------------------------

test("pairing: wrong code rejected, code is single-use, REST requires token", async () => {
  const { server, base } = await boot();
  try {
    const bad = await fetch(`${base}/api/v1/pairing/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", connection: "close" },
      body: JSON.stringify({ code: "000000", deviceName: "intruder" }),
    });
    assert.equal(bad.status, 401);
    const codeRes = await fetch(`${base}/api/v1/pairing/code`, { method: "POST", headers: { connection: "close" } });
    const { code } = (await codeRes.json()) as { code: string };
    const first = await fetch(`${base}/api/v1/pairing/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", connection: "close" },
      body: JSON.stringify({ code, deviceName: "second-phone" }),
    });
    assert.equal(first.status, 200);
    const second = await fetch(`${base}/api/v1/pairing/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", connection: "close" },
      body: JSON.stringify({ code, deviceName: "second-phone" }),
    });
    assert.equal(second.status, 401, "a pairing code must be single-use");
    const noAuth = await fetch(`${base}/api/v1/projects`, { headers: { connection: "close" } });
    assert.equal(noAuth.status, 401);
  } finally {
    await server.stop();
  }
});

test("healthz reports protocol version and mock adapter", async () => {
  const { server, base } = await boot();
  try {
    const res = await fetch(`${base}/healthz`, { headers: { connection: "close" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "ok");
    assert.equal(body.protocolVersion, "1.0.0");
    assert.equal((body.codex as Record<string, unknown>).mode, "mock");
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// End-to-end mock turn with approval
// ---------------------------------------------------------------------------

test("mock turn: session create, streaming deltas, approval accept, completion, seq monotonic", async () => {
  const { server, base, token } = await boot();
  try {
    const ws = new WsClient(`${base.replace("http", "ws")}/ws?token=${token}`);
    await ws.opened;
    ws.subscribe(0);
    const created = await ws.command("req-create-1", "session.create", { projectId: "demo", cwd: "demo", title: "demo" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const sessionId = (created.data as Record<string, unknown>).sessionId as string;
    assert.ok(sessionId.startsWith("ses_"));
    const createdEv = await ws.waitFor((m) => m.type === "event" && (m.event as Record<string, unknown>).type === "session.created");
    assert.equal((createdEv.event as Record<string, unknown>).sessionId, sessionId);

    const sent = await ws.command("req-send-1", "message.send", { sessionId, text: "please run the tests" });
    assert.equal(sent.ok, true, JSON.stringify(sent));

    // Approval arrives with exactly the decisions the mock offered.
    const appr = await ws.waitFor(
      (m) => m.type === "event" && (m.event as Record<string, unknown>).type === "approval.requested",
    );
    const apprPayload = (appr.event as Record<string, unknown>).payload as Record<string, unknown>;
    assert.deepEqual(apprPayload.availableDecisions, ["accept", "decline"]);
    assert.equal(apprPayload.command, "npm test");

    const resp = await ws.command("req-appr-1", "approval.respond", {
      sessionId,
      itemId: apprPayload.itemId,
      decision: "accept",
    });
    assert.equal(resp.ok, true, JSON.stringify(resp));
    assert.equal((resp.data as Record<string, unknown>).status, "accepted");

    const done = await ws.waitFor(
      (m) =>
        m.type === "event" &&
        (m.event as Record<string, unknown>).type === "session.status" &&
        (((m.event as Record<string, unknown>).payload as Record<string, unknown>).status === "completed"),
    );
    assert.equal((done.event as Record<string, unknown>).sessionId, sessionId);

    // Sequence numbers are strictly increasing across the whole stream.
    const seqs = ws.events.map((e) => e.seq as number);
    assert.ok(seqs.length >= 6, `expected several events, got ${seqs.length}`);
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], "seq must be strictly increasing");
    ws.close();
  } finally {
    await server.stop();
  }
});

test("reconnect replay: a late client gets every missed event in order", async () => {
  const { server, base, token } = await boot({ mockScript: "plain" });
  try {
    const ws = new WsClient(`${base.replace("http", "ws")}/ws?token=${token}`);
    await ws.opened;
    ws.subscribe(0);
    const created = await ws.command("req-create-1", "session.create", { projectId: "demo", cwd: "demo" });
    const sessionId = (created.data as Record<string, unknown>).sessionId as string;
    await ws.command("req-send-1", "message.send", { sessionId, text: "hello" });
    await ws.waitFor(
      (m) =>
        m.type === "event" &&
        (m.event as Record<string, unknown>).type === "session.status" &&
        (((m.event as Record<string, unknown>).payload as Record<string, unknown>).status === "completed"),
    );
    ws.close();
    await sleep(50);

    const late = new WsClient(`${base.replace("http", "ws")}/ws?token=${token}`);
    await late.opened;
    late.subscribe(0);
    await late.waitFor((m) => m.type === "replay-complete");
    const types = late.events.map((e) => e.type as string);
    assert.ok(types.includes("session.created"));
    assert.ok(types.includes("message.delta"));
    assert.ok(types.includes("session.status"));
    const seqs = late.events.map((e) => e.seq as number);
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1]);
    late.close();

    // REST history snapshot agrees with the replayed stream.
    const hist = await fetch(`${base}/api/v1/sessions/${sessionId}/history?afterSeq=0`, {
      headers: { Authorization: `Bearer ${token}`, connection: "close" },
    });
    assert.equal(hist.status, 200);
    const body = (await hist.json()) as { snapshotRequired: boolean; events: Array<Record<string, unknown>> };
    assert.equal(body.snapshotRequired, false);
    assert.deepEqual(body.events.map((e) => e.type), types.filter((t) => t !== "connection.heartbeat"));
  } finally {
    await server.stop();
  }
});

test("duplicate requestId: the command runs once, the replay returns the stored result", async () => {
  const { server, base, token } = await boot();
  try {
    const ws = new WsClient(`${base.replace("http", "ws")}/ws?token=${token}`);
    await ws.opened;
    ws.subscribe(0);
    const created = await ws.command("req-create-1", "session.create", { projectId: "demo", cwd: "demo" });
    const sessionId = (created.data as Record<string, unknown>).sessionId as string;
    const first = await ws.command("req-dup-1", "message.send", { sessionId, text: "run tests" });
    const second = await ws.command("req-dup-1", "message.send", { sessionId, text: "run tests" });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal((second as Record<string, unknown>).deduped, true);
    assert.equal(
      (first.data as Record<string, unknown>).turnId,
      (second.data as Record<string, unknown>).turnId,
      "replay must return the original turn, not start a second one",
    );
    const started = ws.events.filter((e) => e.type === "message.started");
    assert.equal(started.length, 1, "the turn must have started exactly once");
    ws.close();
  } finally {
    await server.stop();
  }
});

test("workspace allow-list: cwd outside the root is rejected", async () => {
  const { server, base, token } = await boot();
  try {
    const ws = new WsClient(`${base.replace("http", "ws")}/ws?token=${token}`);
    await ws.opened;
    const res = await ws.command("req-evil-1", "session.create", { projectId: "demo", cwd: "../outside" });
    assert.equal(res.ok, false);
    assert.match(String((res.error as Record<string, unknown>).message), /outside the workspace root/);
    const sessionsRes = await fetch(`${base}/api/v1/sessions`, {
      headers: { Authorization: `Bearer ${token}`, connection: "close" },
    });
    const { sessions } = (await sessionsRes.json()) as { sessions: unknown[] };
    assert.equal(sessions.length, 0);
    ws.close();
  } finally {
    await server.stop();
  }
});

test("approval is driven by availableDecisions: unlisted and persistent decisions are rejected", async () => {
  const { server, base, token } = await boot();
  try {
    const ws = new WsClient(`${base.replace("http", "ws")}/ws?token=${token}`);
    await ws.opened;
    ws.subscribe(0);
    const created = await ws.command("req-create-1", "session.create", { projectId: "demo", cwd: "demo" });
    const sessionId = (created.data as Record<string, unknown>).sessionId as string;
    await ws.command("req-send-1", "message.send", { sessionId, text: "run tests" });
    const appr = await ws.waitFor(
      (m) => m.type === "event" && (m.event as Record<string, unknown>).type === "approval.requested",
    );
    const itemId = ((appr.event as Record<string, unknown>).payload as Record<string, unknown>).itemId as string;

    // "cancel" was not offered by this request -> rejected, request stays pending.
    const notOffered = await ws.command("req-appr-1", "approval.respond", { sessionId, itemId, decision: "cancel" });
    assert.equal(notOffered.ok, false);
    assert.equal((notOffered.error as Record<string, unknown>).code, "decision-not-offered");

    // "acceptForSession" was not offered either -> same rejection, not a silent grant.
    const persistent = await ws.command("req-appr-2", "approval.respond", { sessionId, itemId, decision: "acceptForSession" });
    assert.equal(persistent.ok, false);
    assert.equal((persistent.error as Record<string, unknown>).code, "decision-not-offered");

    // A listed decision still works afterwards.
    const ok = await ws.command("req-appr-3", "approval.respond", { sessionId, itemId, decision: "decline" });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    ws.close();
  } finally {
    await server.stop();
  }
});

test("extended approval: acceptForSession is offered but server-blocked by default", async () => {
  const { server, base, token } = await boot({ mockScript: "approval-extended" });
  try {
    const ws = new WsClient(`${base.replace("http", "ws")}/ws?token=${token}`);
    await ws.opened;
    ws.subscribe(0);
    const created = await ws.command("req-create-1", "session.create", { projectId: "demo", cwd: "demo" });
    const sessionId = (created.data as Record<string, unknown>).sessionId as string;
    await ws.command("req-send-1", "message.send", { sessionId, text: "deploy it" });
    const appr = await ws.waitFor(
      (m) => m.type === "event" && (m.event as Record<string, unknown>).type === "approval.requested",
    );
    const payload = (appr.event as Record<string, unknown>).payload as Record<string, unknown>;
    assert.deepEqual(payload.availableDecisions, ["accept", "acceptForSession", "decline", "cancel"]);
    const itemId = payload.itemId as string;

    const blocked = await ws.command("req-appr-1", "approval.respond", { sessionId, itemId, decision: "acceptForSession" });
    assert.equal(blocked.ok, false);
    assert.equal((blocked.error as Record<string, unknown>).code, "decision-not-allowed");

    const ok = await ws.command("req-appr-2", "approval.respond", { sessionId, itemId, decision: "accept" });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    ws.close();
  } finally {
    await server.stop();
  }
});

test("expired approval: cleared as expired, and can no longer be answered", async () => {
  const { server, base, token } = await boot({ approvalTtlMs: 500 });
  try {
    const ws = new WsClient(`${base.replace("http", "ws")}/ws?token=${token}`);
    await ws.opened;
    ws.subscribe(0);
    const created = await ws.command("req-create-1", "session.create", { projectId: "demo", cwd: "demo" });
    const sessionId = (created.data as Record<string, unknown>).sessionId as string;
    await ws.command("req-send-1", "message.send", { sessionId, text: "run tests" });
    const appr = await ws.waitFor(
      (m) => m.type === "event" && (m.event as Record<string, unknown>).type === "approval.requested",
    );
    const itemId = ((appr.event as Record<string, unknown>).payload as Record<string, unknown>).itemId as string;

    const cleared = await ws.waitFor(
      (m) =>
        m.type === "event" &&
        (m.event as Record<string, unknown>).type === "approval.resolved" &&
        (((m.event as Record<string, unknown>).payload as Record<string, unknown>).itemId === itemId) &&
        (((m.event as Record<string, unknown>).payload as Record<string, unknown>).status === "expired"),
      5000,
    );
    assert.ok(cleared, "an approval.resolved event with status expired must be emitted");

    const late = await ws.command("req-appr-1", "approval.respond", { sessionId, itemId, decision: "accept" });
    assert.equal(late.ok, false);
    assert.equal((late.error as Record<string, unknown>).code, "approval-no-longer-pending");
    ws.close();
  } finally {
    await server.stop();
  }
});

test("snapshot fallback: a client behind the retention window gets snapshot-required", async () => {
  const { server, base, token } = await boot({ mockScript: "plain", maxEvents: 5 });
  try {
    const ws = new WsClient(`${base.replace("http", "ws")}/ws?token=${token}`);
    await ws.opened;
    ws.subscribe(0);
    const created = await ws.command("req-create-1", "session.create", { projectId: "demo", cwd: "demo" });
    const sessionId = (created.data as Record<string, unknown>).sessionId as string;
    await ws.command("req-send-1", "message.send", { sessionId, text: "hello" });
    await ws.waitFor(
      (m) =>
        m.type === "event" &&
        (m.event as Record<string, unknown>).type === "session.status" &&
        (((m.event as Record<string, unknown>).payload as Record<string, unknown>).status === "completed"),
    );
    ws.close();
    await sleep(50);
    const late = new WsClient(`${base.replace("http", "ws")}/ws?token=${token}`);
    await late.opened;
    late.subscribe(0);
    const snap = await late.waitFor((m) => m.type === "snapshot-required", 5000);
    assert.equal(typeof (snap as Record<string, unknown>).floorSeq, "number");
    late.close();
  } finally {
    await server.stop();
  }
});

test("heartbeat: the server emits connection.heartbeat events", async () => {
  const { server, base, token } = await boot();
  try {
    const ws = new WsClient(`${base.replace("http", "ws")}/ws?token=${token}`);
    await ws.opened;
    ws.subscribe(0);
    const beat = await ws.waitFor(
      (m) => m.type === "event" && (m.event as Record<string, unknown>).type === "connection.heartbeat",
      5000,
    );
    assert.ok(beat);
    ws.close();
  } finally {
    await server.stop();
  }
});
