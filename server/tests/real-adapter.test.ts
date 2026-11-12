import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RealCodexAdapter, type RealCodexAdapterOptions } from "../src/modules/codex/real-adapter.js";
import type { CodexEvent } from "../src/modules/codex/adapter.js";
import { CompanionServer } from "../src/server.js";
import { defaultConfig } from "../src/config.js";

/**
 * Real adapter tests against the fake app-server (server/tests/
 * fake-app-server.mjs). The stub speaks the real JSON-RPC shapes from
 * the 0.164.0-alpha.9 schema but answers locally — so these tests prove
 * the adapter's protocol handling (handshake, version gate, threads,
 * streaming, approval pairing, interrupt, idle timeout, crash +
 * reconnect), NOT real Codex behaviour. Real Codex verification
 * (login, models, Windows sandbox, a real turn) is still a Phase 2 gate
 * on the target machine (matrix §5).
 */

const STUB_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "tests",
  "fake-app-server.mjs",
);
assert.ok(fs.existsSync(STUB_PATH), `fake app-server stub missing: ${STUB_PATH}`);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readRecord(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000, what = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

interface Harness {
  adapter: RealCodexAdapter;
  events: CodexEvent[];
  recordFile: string;
  tmp: string;
}

async function bootHarness(opts: {
  env?: Record<string, string>;
  adapterOpts?: Partial<RealCodexAdapterOptions>;
  autoStart?: boolean;
} = {}): Promise<Harness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-real-adapter-"));
  const recordFile = path.join(tmp, "record.jsonl");
  const adapter = new RealCodexAdapter({
    bin: process.execPath,
    args: [STUB_PATH, "app-server"],
    versionArgs: [STUB_PATH, "--version"],
    env: {
      FAKE_RECORD_FILE: recordFile,
      FAKE_STATE_FILE: path.join(tmp, "state.json"),
      FAKE_CRASH_MARKER_FILE: path.join(tmp, "crashed"),
      ...(opts.env ?? {}),
    },
    rpcTimeoutMs: 2000,
    turnIdleTimeoutMs: 60_000,
    maxDeltaChars: 500,
    reconnectAttempts: 2,
    reconnectDelayMs: 50,
    minVersion: "0.166.0",
    ...(opts.adapterOpts ?? {}),
  });
  const events: CodexEvent[] = [];
  adapter.on("codex-event", (e) => events.push(e));
  if (opts.autoStart !== false) await adapter.start();
  return { adapter, events, recordFile, tmp };
}

function approvalEvent(events: CodexEvent[]): CodexEvent | undefined {
  return events.find((e) => e.kind.endsWith("/requestApproval"));
}

test("real adapter: version check, thread lifecycle, plain turn streams deltas", async () => {
  const h = await bootHarness({ env: { FAKE_APPROVAL: "none" } });
  try {
    const status = h.adapter.status();
    assert.equal(status.mode, "real");
    assert.equal(status.version, "0.166.0");
    assert.equal(status.connected, true);

    assert.deepEqual(await h.adapter.listThreads(), []);
    const thread = await h.adapter.createThread({ cwd: "/tmp/demo", title: "demo thread" });
    assert.ok(thread.threadId.startsWith("thr_"));
    assert.equal(thread.cwd, "/tmp/demo");
    assert.equal(thread.title, "demo thread");

    // thread/start was sent with the matrix §15 explicit policy.
    const reqs = readRecord(h.recordFile).filter((r) => r.t === "request");
    const startReq = reqs.find((r) => r.method === "thread/start");
    assert.equal((startReq?.params as Record<string, unknown>)?.approvalPolicy, "on-request");
    assert.equal((startReq?.params as Record<string, unknown>)?.sandbox, "workspace-write");

    const { turnId } = await h.adapter.startTurn(thread.threadId, "hello");
    const done = await waitFor(
      () => h.events.find((e) => e.kind === "turn.completed" && e.turnId === turnId),
      5000,
      "turn.completed",
    );
    assert.equal(done.status, "completed");
    const deltas = h.events.filter((e) => e.kind === "item.agentMessage/delta" && e.turnId === turnId);
    assert.ok(deltas.length >= 1, "expected at least one delta");
    assert.match(deltas.map((d) => d.delta).join(""), /Hello from the fake app-server/);
    const started = h.events.filter((e) => e.kind === "item.started" && e.turnId === turnId);
    assert.ok(started.some((e) => e.itemType === "agent_message"));

    const read = await h.adapter.readThread(thread.threadId);
    assert.equal(read.turns.length, 1);
    assert.ok((read.items as unknown[]).length >= 2, "turn items should be listed back");
  } finally {
    await h.adapter.stop();
  }
});

test("real adapter: command approval accept -> completed, decline -> declined", async () => {
  for (const decision of ["accept", "decline"] as const) {
    const h = await bootHarness({ env: { FAKE_APPROVAL: "command" } });
    try {
      const thread = await h.adapter.createThread({ cwd: "/tmp/demo" });
      const { turnId } = await h.adapter.startTurn(thread.threadId, "run tests");
      const appr = await waitFor(() => approvalEvent(h.events), 5000, "approval.requested");
      // The stub omits availableDecisions (like the 0.164 schema): the
      // adapter must default to the safe pair.
      assert.deepEqual(appr?.availableDecisions, ["accept", "decline"]);
      assert.equal(appr?.command, "npm test");
      assert.equal(appr?.kind, "item.commandExecution/requestApproval");
      await h.adapter.respondApproval(
        {
          itemId: appr?.itemId ?? "",
          threadId: appr?.threadId ?? "",
          turnId: appr?.turnId ?? "",
          kind: "commandExecution",
          availableDecisions: appr?.availableDecisions ?? [],
        },
        decision,
      );
      const done = await waitFor(
        () => h.events.find((e) => e.kind === "turn.completed" && e.turnId === turnId),
        5000,
        "turn.completed",
      );
      assert.equal(done.status, "completed");
      const completed = h.events.find(
        (e) => e.kind === "item.completed" && e.itemType === "command_execution" && e.turnId === turnId,
      );
      assert.equal(completed?.status, decision === "accept" ? "completed" : "declined");
      // The summary is metadata only: no raw tool output in the event.
      assert.equal(completed?.summary, decision === "accept" ? "exit 0 in 120ms" : "exit 1 in 120ms");
      const raw = readRecord(h.recordFile).find((r) => r.t === "approval-response-raw");
      assert.deepEqual((raw?.result as Record<string, unknown>) ?? {}, { decision });
    } finally {
      await h.adapter.stop();
    }
  }
});

test("real adapter: availableDecisions from the server are honoured", async () => {
  const h = await bootHarness({
    env: {
      FAKE_APPROVAL: "command",
      FAKE_INCLUDE_DECISIONS: "1",
      FAKE_APPROVAL_DECISIONS: JSON.stringify(["accept", "acceptForSession", "decline", "cancel"]),
    },
  });
  try {
    const thread = await h.adapter.createThread({ cwd: "/tmp/demo" });
    await h.adapter.startTurn(thread.threadId, "deploy it");
    const appr = await waitFor(() => approvalEvent(h.events), 5000, "approval.requested");
    // acceptForSession is offered by the server but blocked by the
    // companion (allowPersistentApprovals is off): the adapter must not
    // surface it as an offerable decision.
    assert.deepEqual(appr?.availableDecisions, ["accept", "decline", "cancel"]);
    await assert.rejects(
      h.adapter.respondApproval(
        {
          itemId: appr?.itemId ?? "",
          threadId: appr?.threadId ?? "",
          turnId: appr?.turnId ?? "",
          kind: "commandExecution",
          availableDecisions: appr?.availableDecisions ?? [],
        },
        "acceptForSession",
      ),
      /was not offered/,
    );
    await h.adapter.respondApproval(
      {
        itemId: appr?.itemId ?? "",
        threadId: appr?.threadId ?? "",
        turnId: appr?.turnId ?? "",
        kind: "commandExecution",
        availableDecisions: appr?.availableDecisions ?? [],
      },
      "accept",
    );
    const done = await waitFor(
      () => h.events.find((e) => e.kind === "turn.completed"),
      5000,
      "turn.completed",
    );
    assert.equal(done.status, "completed");
  } finally {
    await h.adapter.stop();
  }
});

test("real adapter: fileChange approval accept -> completed", async () => {
  const h = await bootHarness({ env: { FAKE_APPROVAL: "file" } });
  try {
    const thread = await h.adapter.createThread({ cwd: "/tmp/demo" });
    const { turnId } = await h.adapter.startTurn(thread.threadId, "write the files");
    const appr = await waitFor(() => approvalEvent(h.events), 5000, "approval.requested");
    assert.equal(appr?.kind, "item.fileChange/requestApproval");
    await h.adapter.respondApproval(
      {
        itemId: appr?.itemId ?? "",
        threadId: appr?.threadId ?? "",
        turnId: appr?.turnId ?? "",
        kind: "fileChange",
        availableDecisions: appr?.availableDecisions ?? [],
      },
      "accept",
    );
    const completed = await waitFor(
      () =>
        h.events.find((e) => e.kind === "item.completed" && e.itemType === "file_change" && e.turnId === turnId),
      5000,
      "fileChange item.completed",
    );
    assert.equal(completed.status, "completed");
    assert.equal(completed.summary, "2 file(s) completed");
  } finally {
    await h.adapter.stop();
  }
});

test("real adapter: permissions approval grants the requested profile for the turn only", async () => {
  for (const decision of ["accept", "decline"] as const) {
    const h = await bootHarness({ env: { FAKE_APPROVAL: "permissions" } });
    try {
      const thread = await h.adapter.createThread({ cwd: "/tmp/demo" });
      const { turnId } = await h.adapter.startTurn(thread.threadId, "needs more access");
      const appr = await waitFor(() => approvalEvent(h.events), 5000, "approval.requested");
      assert.equal(appr?.kind, "item.permissions/requestApproval");
      assert.ok(Array.isArray(appr?.permissions) && (appr?.permissions?.length ?? 0) >= 2);
      assert.ok((appr?.permissions ?? []).some((p) => p.includes("/tmp/demo/file.txt")));
      assert.ok((appr?.permissions ?? []).some((p) => p.includes("network enabled")));
      await h.adapter.respondApproval(
        {
          itemId: appr?.itemId ?? "",
          threadId: appr?.threadId ?? "",
          turnId: appr?.turnId ?? "",
          kind: "permissions",
          availableDecisions: appr?.availableDecisions ?? [],
        },
        decision,
      );
      const done = await waitFor(
        () => h.events.find((e) => e.kind === "turn.completed" && e.turnId === turnId),
        5000,
        "turn.completed",
      );
      assert.equal(done.status, "completed");
      const raw = readRecord(h.recordFile).find((r) => r.t === "approval-response-raw");
      const result = raw?.result as Record<string, unknown>;
      // Scope is always "turn" by default: never a session-scoped grant.
      assert.equal(result.scope, "turn");
      if (decision === "accept") {
        assert.deepEqual(result.permissions, {
          fileSystem: { entries: [{ path: "/tmp/demo/file.txt", access: "write" }] },
          network: { enabled: true },
        });
      } else {
        assert.deepEqual(result.permissions, {});
      }
    } finally {
      await h.adapter.stop();
    }
  }
});

test("real adapter: cancelPendingApproval answers decline so the turn is not left hanging", async () => {
  const h = await bootHarness({ env: { FAKE_APPROVAL: "command" } });
  try {
    const thread = await h.adapter.createThread({ cwd: "/tmp/demo" });
    const { turnId } = await h.adapter.startTurn(thread.threadId, "run tests");
    const appr = await waitFor(() => approvalEvent(h.events), 5000, "approval.requested");
    h.adapter.cancelPendingApproval(appr?.itemId ?? "", "expired");
    const done = await waitFor(
      () => h.events.find((e) => e.kind === "turn.completed" && e.turnId === turnId),
      5000,
      "turn.completed",
    );
    assert.equal(done.status, "completed");
    const raw = readRecord(h.recordFile).find((r) => r.t === "approval-response-raw");
    assert.deepEqual((raw?.result as Record<string, unknown>) ?? {}, { decision: "decline" });
    // A later answer to the same (now cleared) request is a no-op.
    await h.adapter.respondApproval(
      {
        itemId: appr?.itemId ?? "",
        threadId: appr?.threadId ?? "",
        turnId: appr?.turnId ?? "",
        kind: "commandExecution",
        availableDecisions: appr?.availableDecisions ?? [],
      },
      "accept",
    );
  } finally {
    await h.adapter.stop();
  }
});

test("real adapter: interrupt ends a running turn", async () => {
  const h = await bootHarness({ env: { FAKE_APPROVAL: "none", FAKE_NEVER_COMPLETE: "1" } });
  try {
    const thread = await h.adapter.createThread({ cwd: "/tmp/demo" });
    const { turnId } = await h.adapter.startTurn(thread.threadId, "keep going forever");
    await waitFor(
      () => h.events.find((e) => e.kind === "item.agentMessage/delta" && e.turnId === turnId),
      5000,
      "first delta",
    );
    await h.adapter.interruptTurn(thread.threadId, turnId);
    const done = await waitFor(
      () => h.events.find((e) => e.kind === "turn.completed" && e.turnId === turnId),
      5000,
      "turn.completed interrupted",
    );
    assert.equal(done.status, "interrupted");
    const reqs = readRecord(h.recordFile).filter((r) => r.t === "request");
    assert.ok(reqs.some((r) => r.method === "turn/interrupt"));
  } finally {
    await h.adapter.stop();
  }
});

test("real adapter: an idle turn is interrupted by the adapter", async () => {
  const h = await bootHarness({
    env: { FAKE_APPROVAL: "none", FAKE_NEVER_COMPLETE: "1" },
    adapterOpts: { turnIdleTimeoutMs: 300 },
  });
  try {
    const thread = await h.adapter.createThread({ cwd: "/tmp/demo" });
    const { turnId } = await h.adapter.startTurn(thread.threadId, "keep going forever");
    const done = await waitFor(
      () => h.events.find((e) => e.kind === "turn.completed" && e.turnId === turnId),
      5000,
      "idle turn interrupted",
    );
    assert.equal(done.status, "interrupted");
    const reqs = readRecord(h.recordFile).filter((r) => r.t === "request");
    assert.ok(reqs.some((r) => r.method === "turn/interrupt"), "the adapter must send turn/interrupt itself");
  } finally {
    await h.adapter.stop();
  }
});

test("real adapter: RPC timeout rejects instead of hanging", async () => {
  const h = await bootHarness({
    env: { FAKE_HANG_METHOD: "thread/list" },
    adapterOpts: { rpcTimeoutMs: 300 },
  });
  try {
    await assert.rejects(h.adapter.listThreads(), /timed out after 300ms/);
    assert.equal(h.adapter.status().connected, true, "a timed-out request must not kill the process");
    await h.adapter.createThread({ cwd: "/tmp/demo" });
  } finally {
    await h.adapter.stop();
  }
});

test("real adapter: version below the minimum refuses to start", async () => {
  const h = await bootHarness({
    env: { FAKE_CODEX_VERSION: "0.164.0-alpha.9" },
    autoStart: false,
  });
  try {
    await assert.rejects(h.adapter.start(), /0\.164\.0-alpha\.9 is below the minimum supported 0\.166\.0/);
  } finally {
    await h.adapter.stop();
  }
});

test("real adapter: missing binary fails with a clear error, no silent mock fallback", async () => {
  const adapter = new RealCodexAdapter({ bin: "/nonexistent/codex-xyz", minVersion: "0.166.0" });
  try {
    await assert.rejects(adapter.start(), /codex binary not found: "\/nonexistent\/codex-xyz"/);
  } finally {
    await adapter.stop();
  }
});

test("real adapter: process exit before initialize fails start()", async () => {
  const h = await bootHarness({ env: { FAKE_EXIT_IMMEDIATELY: "1" }, autoStart: false });
  try {
    await assert.rejects(h.adapter.start(), /codex app-server exited \(code 3, signal/);
  } finally {
    await h.adapter.stop();
  }
});

test("real adapter: crash mid-approval interrupts the turn, reconnects, resumes the thread", async () => {
  const h = await bootHarness({
    env: { FAKE_APPROVAL: "command", FAKE_CRASH_ONCE: "1", FAKE_CRASH_AT: "approval", FAKE_CRASH_AFTER_MS: "150" },
  });
  try {
    const thread = await h.adapter.createThread({ cwd: "/tmp/demo" });
    const { turnId } = await h.adapter.startTurn(thread.threadId, "run tests");
    const appr = await waitFor(() => approvalEvent(h.events), 5000, "approval.requested");
    assert.ok(appr, "approval must arrive before the crash");
    // The crash happens while the approval is unanswered.
    const cleared = await waitFor(
      () => h.events.find((e) => e.kind === "approval.cleared" && e.itemId === appr?.itemId),
      5000,
      "approval.cleared after crash",
    );
    assert.equal(cleared.threadId, thread.threadId);
    const interrupted = await waitFor(
      () => h.events.find((e) => e.kind === "turn.completed" && e.turnId === turnId),
      5000,
      "turn.completed interrupted after crash",
    );
    assert.equal(interrupted.status, "interrupted");
    assert.ok(
      h.events.some((e) => e.kind === "session.error" && e.turnId === turnId),
      "a session.error must surface the crash",
    );
    await waitFor(() => (h.adapter.status().connected ? true : undefined), 5000, "reconnected");
    assert.equal(h.adapter.status().version, "0.166.0");
    // Recovery: thread/loaded/list was consulted and the thread resumed.
    const reqs = readRecord(h.recordFile).filter((r) => r.t === "request");
    assert.ok(reqs.some((r) => r.method === "thread/loaded/list"), "recovery must consult thread/loaded/list");
    assert.ok(
      reqs.some((r) => r.method === "thread/resume" && (r.params as Record<string, unknown>)?.threadId === thread.threadId),
      "recovery must resume the thread that had a turn in flight",
    );
    // The adapter is usable again after recovery.
    assert.ok((await h.adapter.listThreads()).some((t) => t.threadId === thread.threadId));
  } finally {
    await h.adapter.stop();
  }
});

test("real adapter: over-long deltas are truncated, never passed through whole", async () => {
  const h = await bootHarness({ env: { FAKE_APPROVAL: "none" }, adapterOpts: { maxDeltaChars: 10 } });
  try {
    const thread = await h.adapter.createThread({ cwd: "/tmp/demo" });
    const { turnId } = await h.adapter.startTurn(thread.threadId, "hello");
    const done = await waitFor(
      () => h.events.find((e) => e.kind === "turn.completed" && e.turnId === turnId),
      5000,
      "turn.completed",
    );
    assert.equal(done.status, "completed");
    for (const d of h.events.filter((e) => e.kind === "item.agentMessage/delta")) {
      assert.ok((d.delta ?? "").length <= 10 + "…[truncated]".length, `delta must be truncated, got ${(d.delta ?? "").length} chars`);
    }
  } finally {
    await h.adapter.stop();
  }
});

// ---------------------------------------------------------------------------
// Server-level wiring: the companion in real mode reports healthz honestly
// and runs a full turn + approval over WS against the fake app-server.
// ---------------------------------------------------------------------------

async function bootRealServer(): Promise<{
  server: CompanionServer;
  base: string;
  wsRoot: string;
  token: string;
  tmp: string;
}> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-real-server-"));
  const wsRoot = path.join(tmp, "ws");
  const projectDir = path.join(wsRoot, "demo");
  fs.mkdirSync(projectDir, { recursive: true });
  const server = new CompanionServer(
    defaultConfig({
      port: 0,
      host: "127.0.0.1",
      dataDir: path.join(tmp, "data"),
      workspaces: [{ id: "demo", name: "demo", path: wsRoot }],
      heartbeatIntervalMs: 1000,
      approvalTtlMs: 60_000,
      codexMode: "real",
      codexBin: process.execPath,
      codexArgs: [STUB_PATH, "app-server"],
      codexVersionArgs: [STUB_PATH, "--version"],
    }),
  );
  await server.start();
  const { host, port } = server.address();
  const base = `http://${host}:${port}`;
  const codeRes = await fetch(`${base}/api/v1/pairing/code`, { method: "POST", headers: { connection: "close" } });
  assert.equal(codeRes.status, 200);
  const { code } = (await codeRes.json()) as { code: string };
  const claimRes = await fetch(`${base}/api/v1/pairing/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", connection: "close" },
    body: JSON.stringify({ code, deviceName: "test-phone" }),
  });
  assert.equal(claimRes.status, 200);
  const { token } = (await claimRes.json()) as { token: string };
  return { server, base, wsRoot, token, tmp };
}

test("server in real mode: healthz reports real + version, end-to-end turn over WS", async () => {
  const recordFile = path.join(os.tmpdir(), `codex-real-server-record-${Date.now()}.jsonl`);
  const stateFile = path.join(os.tmpdir(), `codex-real-server-state-${Date.now()}.json`);
  const prev = { ...process.env };
  process.env.FAKE_RECORD_FILE = recordFile;
  process.env.FAKE_STATE_FILE = stateFile;
  process.env.FAKE_APPROVAL = "command";
  try {
    const { server, base, token } = await bootRealServer();
    try {
      const res = await fetch(`${base}/healthz`, { headers: { connection: "close" } });
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      const codex = body.codex as Record<string, unknown>;
      assert.equal(codex.mode, "real");
      assert.equal(codex.version, "0.166.0");
      assert.equal(codex.connected, true);

      const ws = new WebSocket(`${base.replace("http", "ws")}/ws?token=${token}`);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("ws connect failed"));
      });
      const seen: Array<Record<string, unknown>> = [];
      const waitEvent = (
        pred: (e: Record<string, unknown>) => boolean,
        what = "event",
        timeoutMs = 5000,
      ): Promise<Record<string, unknown>> => {
        const found = seen.find(pred);
        if (found) return Promise.resolve(found);
        return new Promise((resolve, reject) => {
          const deadline = Date.now() + timeoutMs;
          const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs);
          const check = () => {
            const f = seen.find(pred);
            if (f) {
              clearTimeout(timer);
              resolve(f);
            } else if (Date.now() > deadline) {
              clearTimeout(timer);
              reject(new Error(`timed out waiting for ${what}`));
            } else {
              setTimeout(check, 10);
            }
          };
          check();
        });
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (msg.type === "event") seen.push(msg.event as Record<string, unknown>);
      };
      const command = (requestId: string, name: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timed out waiting for ${requestId}`)), 5000);
          const onMsg = (ev: MessageEvent) => {
            const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
            if (msg.type === "command-result" && msg.requestId === requestId) {
              clearTimeout(timer);
              ws.removeEventListener("message", onMsg);
              resolve(msg);
            }
          };
          ws.addEventListener("message", onMsg);
          ws.send(JSON.stringify({ type: "command", requestId, command: name, payload }));
        });
      ws.send(JSON.stringify({ type: "subscribe", lastSeq: 0 }));
      const created = await command("req-create-1", "session.create", { projectId: "demo", cwd: "demo", title: "demo" });
      assert.equal(created.ok, true, JSON.stringify(created));
      const sessionId = (created.data as Record<string, unknown>).sessionId as string;
      const sent = await command("req-send-1", "message.send", { sessionId, text: "run tests" });
      assert.equal(sent.ok, true, JSON.stringify(sent));
      const appr = await waitEvent((e) => e.type === "approval.requested", "approval.requested");
      const payload = appr.payload as Record<string, unknown>;
      assert.deepEqual(payload.availableDecisions, ["accept", "decline"]);
      const resp = await command("req-appr-1", "approval.respond", { sessionId, itemId: payload.itemId, decision: "accept" });
      assert.equal(resp.ok, true, JSON.stringify(resp));
      const done = await waitEvent(
        (e) => e.type === "session.status" && (e.payload as Record<string, unknown>).status === "completed",
        "session.status completed",
      );
      assert.equal((done.payload as Record<string, unknown>).status, "completed");
      ws.close();
    } finally {
      await server.stop();
    }
  } finally {
    // Restore process.env: remove keys we added, restore overwritten ones.
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
    if (fs.existsSync(recordFile)) fs.unlinkSync(recordFile);
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  }
});
