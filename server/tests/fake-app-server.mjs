#!/usr/bin/env node
/**
 * Fake `codex app-server` for RealCodexAdapter tests (Phase 2).
 *
 * Speaks the real wire shapes from the 0.164.0-alpha.9 generated schema —
 * newline-delimited JSON-RPC 2.0 over stdio — but answers everything
 * locally, with NO model call and NO login. It is a protocol double, not
 * a Codex replacement: nothing here proves anything about real Codex
 * behaviour (login, models, Windows sandbox, real approvals).
 *
 * Usage by the tests (never by hand):
 *   node fake-app-server.mjs --version     -> prints `codex-cli <FAKE_CODEX_VERSION>`
 *   node fake-app-server.mjs app-server    -> JSON-RPC loop on stdio
 *
 * Behaviour knobs (env):
 *   FAKE_CODEX_VERSION        version printed by --version (default "0.166.0")
 *   FAKE_APPROVAL             none | command | file | permissions (default "command")
 *   FAKE_INCLUDE_DECISIONS    "1" -> the approval request also carries availableDecisions
 *   FAKE_APPROVAL_DECISIONS   JSON array for availableDecisions (default ["accept","decline"])
 *   FAKE_TURN_DELAY_MS        delay between emitted events (default 30)
 *   FAKE_NEVER_COMPLETE       "1" -> start a turn, emit one delta, never finish it
 *   FAKE_HANG_METHOD          method name the stub never answers (RPC timeout tests)
 *   FAKE_CRASH_ONCE           "1" -> the first process instance exits(1) mid-turn
 *   FAKE_CRASH_AT             "delta" (default, after the first delta) | "approval"
 *   FAKE_CRASH_AFTER_MS       delay before the crash exit (default 150)
 *   FAKE_CRASH_MARKER_FILE    marker written by the crashing instance (2nd instance is healthy)
 *   FAKE_EXIT_IMMEDIATELY     "1" -> exit(3) at boot, before initialize
 *   FAKE_RECORD_FILE          JSON-lines log of received requests/responses
 *   FAKE_STATE_FILE           threads persist here across process restarts
 */

import fs from "node:fs";
import readline from "node:readline";

const env = process.env;
const VERSION = env.FAKE_CODEX_VERSION ?? "0.166.0";
const APPROVAL = env.FAKE_APPROVAL ?? "command";
const INCLUDE_DECISIONS = env.FAKE_INCLUDE_DECISIONS === "1";
const APPROVAL_DECISIONS = env.FAKE_APPROVAL_DECISIONS
  ? JSON.parse(env.FAKE_APPROVAL_DECISIONS)
  : ["accept", "decline"];
const TURN_DELAY_MS = Number(env.FAKE_TURN_DELAY_MS ?? 30);
const NEVER_COMPLETE = env.FAKE_NEVER_COMPLETE === "1";
const HANG_METHOD = env.FAKE_HANG_METHOD ?? "";
const CRASH_ONCE = env.FAKE_CRASH_ONCE === "1";
const CRASH_AT = env.FAKE_CRASH_AT ?? "delta";
const CRASH_AFTER_MS = Number(env.FAKE_CRASH_AFTER_MS ?? 150);
const CRASH_MARKER = env.FAKE_CRASH_MARKER_FILE ?? "";
const EXIT_IMMEDIATELY = env.FAKE_EXIT_IMMEDIATELY === "1";
const RECORD_FILE = env.FAKE_RECORD_FILE ?? "";
const STATE_FILE = env.FAKE_STATE_FILE ?? "";
const APPROVAL_WAIT_MS = 10_000;

function record(obj) {
  if (!RECORD_FILE) return;
  try {
    fs.appendFileSync(RECORD_FILE, `${JSON.stringify(obj)}\n`);
  } catch {
    // record file is best-effort diagnostics
  }
}

function summarizeParams(params) {
  if (!params || typeof params !== "object") return params;
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = typeof v === "string" ? (v.length > 200 ? `${v.slice(0, 200)}…` : v) : v;
  }
  return out;
}

if (process.argv.includes("--version")) {
  process.stdout.write(`codex-cli ${VERSION}\n`);
  process.exit(0);
}
if (process.argv[2] !== "app-server") {
  console.error("fake-app-server: expected 'app-server' argument");
  process.exit(2);
}
if (EXIT_IMMEDIATELY) process.exit(3);

// Crash-once: only the first process instance (no marker yet) crashes.
let willCrash = false;
if (CRASH_ONCE && CRASH_MARKER && !fs.existsSync(CRASH_MARKER)) {
  willCrash = true;
  fs.writeFileSync(CRASH_MARKER, "crashed\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- persistent thread state (so a respawned stub still knows threads) ---
const threads = new Map();
const activeTurnByThread = new Map(); // threadId -> in-flight turn (so turn/interrupt can stop the driver)
function loadState() {
  if (!STATE_FILE || !fs.existsSync(STATE_FILE)) return;
  try {
    for (const t of JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))) threads.set(t.id, t);
  } catch {
    // corrupt state file: start empty
  }
}
function saveState() {
  if (!STATE_FILE) return;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify([...threads.values()]));
  } catch {
    // best effort
  }
}
loadState();
const loaded = new Set(); // threads loaded in THIS process instance

let seq = 0;
let nextRpcId = 1000;
const pendingApprovals = new Map(); // rpcId -> resolve(result)
const approvalTurn = new Map(); // rpcId -> turn (so interrupt can unblock the driver)

function rid(prefix) {
  return `${prefix}_${++seq}_${Date.now().toString(36)}`;
}
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`, (err) => {
    if (err) process.exit(0);
  });
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
function result(id, res) {
  send({ jsonrpc: "2.0", id, result: res });
}
function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function threadSummary(t) {
  return {
    id: t.id,
    cwd: t.cwd,
    name: t.name,
    preview: t.preview ?? "",
    sessionId: t.id,
    projectId: "demo",
    cliVersion: VERSION,
    createdAt: t.createdAt,
    updatedAt: Date.now(),
    ephemeral: false,
    modelProvider: "openai",
    model: t.model ?? "gpt-5",
    source: "appServer",
    status: { type: "idle" },
    turns: t.turns,
  };
}

function startResult(t) {
  return {
    thread: threadSummary(t),
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    cwd: t.cwd,
    model: t.model ?? "gpt-5",
    modelProvider: "openai",
    sandbox: "workspace-write",
  };
}

async function driveTurn(thread, turn) {
  const tid = thread.id;
  const nid = turn.id;
  await sleep(TURN_DELAY_MS);
  if (turn.interrupted) return;
  notify("turn/started", { threadId: tid, turn: { id: nid, status: "inProgress", items: [] } });
  const msgItem = { id: rid("itm"), type: "agentMessage", text: "" };
  const msgText = "Hello from the fake app-server. Second delta.";
  notify("item/started", { threadId: tid, turnId: nid, startedAtMs: Date.now(), item: msgItem });
  await sleep(TURN_DELAY_MS);
  if (turn.interrupted) return;
  notify("item/agentMessage/delta", { threadId: tid, turnId: nid, itemId: msgItem.id, delta: "Hello from the fake app-server. " });
  if (willCrash && CRASH_AT === "delta") {
    await sleep(CRASH_AFTER_MS);
    process.exit(1);
  }
  if (NEVER_COMPLETE) return; // adapter must interrupt or time out
  await sleep(TURN_DELAY_MS);
  if (turn.interrupted) return;
  notify("item/agentMessage/delta", { threadId: tid, turnId: nid, itemId: msgItem.id, delta: "Second delta." });
  await sleep(TURN_DELAY_MS);
  if (turn.interrupted) return;

  if (APPROVAL === "none") {
    completeItem(thread, turn, { ...msgItem, text: msgText }, "completed");
    completeTurn(thread, turn, "completed");
    return;
  }

  // Approval flow: one server-initiated request, wait for the answer.
  const apprItem = rid("itm");
  const rpcId = nextRpcId++;
  let method;
  let params;
  let wireItem;
  if (APPROVAL === "file") {
    method = "item/fileChange/requestApproval";
    params = {
      itemId: apprItem,
      threadId: tid,
      turnId: nid,
      startedAtMs: Date.now(),
      reason: "The agent wants to write files.",
      grantRoot: "/tmp/demo",
    };
    wireItem = { id: apprItem, type: "fileChange", status: "inProgress", changes: [{ path: "/tmp/demo/a.txt" }, { path: "/tmp/demo/b.txt" }] };
  } else if (APPROVAL === "permissions") {
    method = "item/permissions/requestApproval";
    params = {
      itemId: apprItem,
      threadId: tid,
      turnId: nid,
      startedAtMs: Date.now(),
      cwd: thread.cwd,
      permissions: {
        fileSystem: { entries: [{ path: "/tmp/demo/file.txt", access: "write" }] },
        network: { enabled: true },
      },
      reason: "The agent requests additional permissions.",
    };
    wireItem = { id: apprItem, type: "agentMessage", text: "" };
  } else {
    method = "item/commandExecution/requestApproval";
    params = {
      itemId: apprItem,
      threadId: tid,
      turnId: nid,
      startedAtMs: Date.now(),
      command: "npm test",
      cwd: thread.cwd,
      reason: "Running tests requires approval.",
    };
    wireItem = { id: apprItem, type: "commandExecution", command: "npm test", cwd: thread.cwd, status: "inProgress" };
  }
  if (INCLUDE_DECISIONS) params.availableDecisions = APPROVAL_DECISIONS;
  if (APPROVAL !== "permissions") {
    notify("item/started", { threadId: tid, turnId: nid, startedAtMs: Date.now(), item: wireItem });
    await sleep(TURN_DELAY_MS);
    if (turn.interrupted) return;
  }
  if (willCrash && CRASH_AT === "approval") {
    send({ jsonrpc: "2.0", id: rpcId, method, params });
    await sleep(CRASH_AFTER_MS);
    process.exit(1);
  }
  const answer = await new Promise((resolve) => {
    pendingApprovals.set(rpcId, resolve);
    approvalTurn.set(rpcId, turn);
    send({ jsonrpc: "2.0", id: rpcId, method, params });
    setTimeout(() => {
      if (pendingApprovals.has(rpcId)) {
        pendingApprovals.delete(rpcId);
        approvalTurn.delete(rpcId);
        record({ t: "approval-timeout", rpcId, method });
        resolve({ decision: "decline" });
      }
    }, APPROVAL_WAIT_MS);
  });
  approvalTurn.delete(rpcId);
  record({ t: "approval-response", method, rpcId, answer });
  notify("serverRequest/resolved", { requestId: rpcId, threadId: tid });
  if (turn.interrupted) return;
  await sleep(TURN_DELAY_MS);

  let status = "declined";
  if (APPROVAL === "permissions") {
    const perms = answer && typeof answer === "object" ? answer.permissions : undefined;
    status = perms && Object.keys(perms).length > 0 ? "completed" : "declined";
    completeItem(thread, turn, { ...msgItem, text: msgText }, "completed");
    completeTurn(thread, turn, "completed");
    return;
  }
  const decision = answer && typeof answer === "object" ? answer.decision : undefined;
  if (decision === "accept" || decision === "acceptForSession") status = "completed";
  else if (decision === "decline") status = "declined";
  else status = "failed"; // cancel / anything else
  completeItem(thread, turn, { ...wireItem, status, exitCode: status === "completed" ? 0 : 1, durationMs: 120 }, status);
  completeItem(thread, turn, { ...msgItem, text: msgText }, "completed");
  completeTurn(thread, turn, "completed");
}

function completeItem(thread, turn, item, status) {
  const stored = { ...item, status };
  turn.items.push(stored);
  thread.items.push(stored);
  notify("item/completed", { threadId: thread.id, turnId: turn.id, completedAtMs: Date.now(), item: stored });
}

function completeTurn(thread, turn, status) {
  turn.status = status;
  thread.turns.push({ id: turn.id, status, items: turn.items });
  saveState();
  notify("turn/completed", { threadId: thread.id, turn: { id: turn.id, status, items: turn.items } });
}

// --- RPC dispatch ---------------------------------------------------------

async function handle(msg) {
  if (msg.method === "initialized") return; // client notification
  if (typeof msg.method === "string") {
    if (HANG_METHOD === msg.method) {
      record({ t: "hang", method: msg.method });
      return; // never answer: exercises the adapter's RPC timeout
    }
    record({ t: "request", method: msg.method, params: summarizeParams(msg.params) });
    const params = msg.params ?? {};
    switch (msg.method) {
      case "initialize":
        return result(msg.id, {
          codexHome: "/tmp/fake-codex-home",
          platformFamily: "unix",
          platformOs: "linux",
          userAgent: `codex-cli ${VERSION} (fake app-server)`,
        });
      case "thread/list": {
        const data = [...threads.values()].map(threadSummary);
        return result(msg.id, { data: typeof params.limit === "number" ? data.slice(0, params.limit) : data, nextCursor: null, backwardsCursor: null });
      }
      case "thread/start": {
        const t = {
          id: rid("thr"),
          cwd: params.cwd ?? "/tmp/demo",
          name: null,
          preview: "",
          model: params.model ?? "gpt-5",
          createdAt: Date.now(),
          turns: [],
          items: [],
        };
        threads.set(t.id, t);
        loaded.add(t.id);
        saveState();
        return result(msg.id, startResult(t));
      }
      case "thread/name/set": {
        const t = threads.get(params.threadId);
        if (t) {
          t.name = params.name;
          saveState();
        }
        return result(msg.id, {});
      }
      case "thread/resume": {
        let t = threads.get(params.threadId);
        if (!t) {
          t = {
            id: params.threadId,
            cwd: "/tmp/demo",
            name: null,
            preview: "resumed",
            model: "gpt-5",
            createdAt: Date.now(),
            turns: [],
            items: [],
          };
          threads.set(t.id, t);
          saveState();
        }
        loaded.add(t.id);
        return result(msg.id, { ...startResult(t), itemsBackwardsCursor: null, turnsBackwardsCursor: null });
      }
      case "thread/read": {
        const t = threads.get(params.threadId);
        if (!t) return error(msg.id, -32602, `unknown thread: ${params.threadId}`);
        return result(msg.id, { thread: threadSummary(t), turns: t.turns, items: t.items });
      }
      case "thread/turns/list": {
        const t = threads.get(params.threadId);
        if (!t) return error(msg.id, -32602, `unknown thread: ${params.threadId}`);
        return result(msg.id, { data: t.turns, nextCursor: null, backwardsCursor: null });
      }
      case "thread/items/list": {
        const t = threads.get(params.threadId);
        if (!t) return error(msg.id, -32602, `unknown thread: ${params.threadId}`);
        return result(msg.id, { data: t.items, nextCursor: null, backwardsCursor: null });
      }
      case "thread/loaded/list":
        return result(msg.id, { data: [...loaded], nextCursor: null });
      case "turn/start": {
        const t = threads.get(params.threadId);
        if (!t) return error(msg.id, -32602, `unknown thread: ${params.threadId}`);
        const turn = { id: rid("trn"), status: "inProgress", items: [] };
        t.items.push({ id: rid("itm"), type: "userMessage", content: params.input ?? [] });
        activeTurnByThread.set(t.id, turn);
        saveState();
        result(msg.id, { turn: { id: turn.id, status: "inProgress", items: [] } });
        void driveTurn(t, turn).finally(() => {
          if (activeTurnByThread.get(t.id) === turn) activeTurnByThread.delete(t.id);
        });
        return;
      }
      case "turn/interrupt": {
        const t = threads.get(params.threadId);
        if (!t) return error(msg.id, -32602, `unknown thread: ${params.threadId}`);
        result(msg.id, {});
        const active = activeTurnByThread.get(t.id);
        if (active) {
          active.interrupted = true;
          // Unblock the driver if it is waiting on an approval answer for
          // this turn; the driver checks `interrupted` right after the wait
          // and stops without emitting further completions.
          for (const [rpcId, turn] of [...approvalTurn]) {
            if (turn === active) {
              const resolve = pendingApprovals.get(rpcId);
              pendingApprovals.delete(rpcId);
              approvalTurn.delete(rpcId);
              if (resolve) resolve({ decision: "decline" });
            }
          }
        }
        // Emit completion for the interrupted turn.
        notify("turn/completed", { threadId: t.id, turn: { id: params.turnId, status: "interrupted", items: [] } });
        return;
      }
      case "model/list":
        return result(msg.id, { data: [], nextCursor: null });
      default:
        return error(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }
  if (msg.id !== undefined && pendingApprovals.has(msg.id)) {
    const resolve = pendingApprovals.get(msg.id);
    pendingApprovals.delete(msg.id);
    record({ t: "approval-response-raw", id: msg.id, result: msg.result ?? null, error: msg.error ?? null });
    resolve(msg.result ?? { decision: "decline" });
    return;
  }
  if (msg.id !== undefined) {
    record({ t: "late-or-unknown-response", id: msg.id, error: msg.error ?? null });
  }
}

// The turn driver needs to see interrupts: turn/interrupt sets
// `interrupted` on the turn object via activeTurnByThread, and driveTurn
// checks that flag before every further emit.
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  void handle(msg).catch((err) => {
    record({ t: "handler-error", message: String(err) });
  });
});
process.stdin.on("end", () => process.exit(0));
