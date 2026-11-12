import crypto from "node:crypto";
import type {
  ApprovalRequest,
  CodexAdapter,
  CodexEvent,
  ThreadSummary,
  TurnHandle,
} from "./adapter.js";

/**
 * Mock CodexAdapter (Phase 1 only).
 *
 * Produces event streams in the *real* app-server shapes verified in
 * Phase 0 (matrix §4): `thread.started`, `item.started`,
 * `item/agentMessage/delta`, `item.completed`, `turn.completed`,
 * `item/commandExecution/requestApproval`. No real Codex process is ever
 * spawned; `start()`/`stop()` are no-ops that only flip state.
 *
 * Scripts (constructor option):
 * - "plain": no approval request; the turn just streams and completes.
 * - "approval-basic": one command-execution approval with
 *   availableDecisions ["accept", "decline"].
 * - "approval-extended": the same request, but with
 *   ["accept", "acceptForSession", "decline", "cancel"] so tests can prove
 *   the server blocks the persistent grant even when the request offers it.
 *
 * A turn that asks for approval pauses after emitting the request and
 * only continues once `respondApproval` (or `cancelPendingApproval`) is
 * called — mirroring the real app-server, where the turn waits for the
 * client's response to its server-initiated request.
 */

export type MockScript = "plain" | "approval-basic" | "approval-extended";

const DELAY_MS = 5;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function rid(prefix: string): string {
  return `${prefix}_mock_${crypto.randomBytes(6).toString("hex")}`;
}

interface PendingTurn {
  resolve: (decision: string) => void;
  turnId: string;
  threadId: string;
}

export class MockCodexAdapter implements CodexAdapter {
  private listeners: Array<(e: CodexEvent) => void> = [];
  private started = false;
  private stopping = false;
  private threads = new Map<string, ThreadSummary>();
  private pendingTurns = new Map<string, PendingTurn>();
  private cancelledTurns = new Set<string>();
  /** Turns still emitting events; stop() drains these before shutdown. */
  private activeTurns = new Set<Promise<void>>();

  constructor(private readonly script: MockScript = "approval-basic") {}

  on(_event: "codex-event", cb: (e: CodexEvent) => void): void {
    this.listeners.push(cb);
  }

  private emit(e: CodexEvent): void {
    for (const cb of this.listeners) cb(e);
  }

  async start(): Promise<void> {
    this.started = true;
    this.stopping = false;
  }

  async stop(): Promise<void> {
    this.started = false;
    // From here on, a turn that reaches an approval wait must not hang:
    // resolve it immediately as cancelled (see the wait site below).
    this.stopping = true;
    for (const [itemId, p] of this.pendingTurns) {
      this.pendingTurns.delete(itemId);
      p.resolve("cancelled");
    }
    // Drain in-flight turns (a turn paused on approval resumes and emits
    // its completion events first) so the caller's store is still open
    // while events are published. Bounded wait; shutdown must not hang.
    await Promise.race([
      Promise.allSettled([...this.activeTurns]),
      sleep(2000),
    ]);
  }

  private requireStarted(): void {
    if (!this.started) throw new Error("mock adapter not started");
  }

  async listThreads(): Promise<ThreadSummary[]> {
    this.requireStarted();
    return [...this.threads.values()];
  }

  async createThread(opts: { cwd: string; model?: string; title?: string }): Promise<ThreadSummary> {
    this.requireStarted();
    const thread: ThreadSummary = {
      threadId: rid("thr"),
      cwd: opts.cwd,
      title: opts.title ?? "mock session",
      status: "active",
    };
    this.threads.set(thread.threadId, thread);
    this.emit({ kind: "thread.started", threadId: thread.threadId });
    return thread;
  }

  async resumeThread(threadId: string): Promise<ThreadSummary> {
    this.requireStarted();
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown thread: ${threadId}`);
    this.emit({ kind: "thread.started", threadId });
    return thread;
  }

  async readThread(threadId: string): Promise<ThreadSummary & { turns: unknown[]; items: unknown[] }> {
    this.requireStarted();
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown thread: ${threadId}`);
    return { ...thread, turns: [], items: [] };
  }

  private approvalDecisions(): ("accept" | "acceptForSession" | "decline" | "cancel")[] {
    if (this.script === "approval-extended") {
      return ["accept", "acceptForSession", "decline", "cancel"];
    }
    return ["accept", "decline"];
  }

  async startTurn(threadId: string, input: string): Promise<TurnHandle> {
    this.requireStarted();
    if (!this.threads.has(threadId)) throw new Error(`unknown thread: ${threadId}`);
    const turnId = rid("trn");
    // Fire-and-forget: the caller gets the handle immediately; events
    // stream through the listener, exactly like the real app-server.
    // A failure must never vanish silently: surface it as a failed turn.
    const done = this.runTurn(threadId, turnId, input).catch((err: unknown) => {
      console.error(`mock adapter turn ${turnId} failed:`, err);
      this.emit({ kind: "turn.completed", threadId, turnId, status: "failed" });
    });
    this.activeTurns.add(done);
    void done.finally(() => this.activeTurns.delete(done));
    return { turnId, threadId };
  }

  private async runTurn(threadId: string, turnId: string, input: string): Promise<void> {
    const msgItem = rid("itm");
    this.emit({ kind: "item.started", threadId, turnId, itemId: msgItem, itemType: "agent_message" });
    await sleep(DELAY_MS);
    const preview = input.slice(0, 40);
    this.emit({ kind: "item.agentMessage/delta", threadId, turnId, itemId: msgItem, delta: `Mock reply to: ${preview}` });
    await sleep(DELAY_MS);
    this.emit({ kind: "item.agentMessage/delta", threadId, turnId, itemId: msgItem, delta: " (mock adapter — no real Codex call)" });
    await sleep(DELAY_MS);

    const cmdItem = rid("itm");
    this.emit({ kind: "item.started", threadId, turnId, itemId: cmdItem, itemType: "command_execution" });
    await sleep(DELAY_MS);

    if (this.script !== "plain") {
      const approvalItem = rid("itm");
      const decisions = this.approvalDecisions();
      const decision = await new Promise<string>((resolve) => {
        // If shutdown began while this turn was still streaming, the
        // stop() call above already resolved the then-pending waiters —
        // but this wait did not exist yet. Resolve at once instead of
        // hanging the drain until its timeout.
        if (this.stopping) {
          resolve("cancelled");
          return;
        }
        this.pendingTurns.set(approvalItem, { resolve, turnId, threadId });
        this.emit({
          kind: "item.commandExecution/requestApproval",
          threadId,
          turnId,
          itemId: approvalItem,
          command: "npm test",
          cwd: this.threads.get(threadId)?.cwd,
          reason: "Running tests requires approval.",
          availableDecisions: decisions,
        });
      });
      if (this.cancelledTurns.has(turnId)) {
        this.emit({ kind: "turn.completed", threadId, turnId, status: "interrupted" });
        return;
      }
      if (decision === "accept" || decision === "acceptForSession") {
        this.emit({ kind: "item.completed", threadId, turnId, itemId: cmdItem, itemType: "command_execution", status: "completed", summary: "npm test exited 0" });
      } else if (decision === "expired" || decision === "cancelled") {
        this.emit({ kind: "item.completed", threadId, turnId, itemId: cmdItem, itemType: "command_execution", status: "failed", summary: `approval ${decision}` });
      } else {
        // decline / cancel
        this.emit({ kind: "item.completed", threadId, turnId, itemId: cmdItem, itemType: "command_execution", status: "declined", summary: "command declined by user" });
      }
    } else {
      this.emit({ kind: "item.completed", threadId, turnId, itemId: cmdItem, itemType: "command_execution", status: "completed", summary: "npm test exited 0" });
    }

    await sleep(DELAY_MS);
    this.emit({ kind: "item.completed", threadId, turnId, itemId: msgItem, itemType: "agent_message", status: "completed" });
    this.emit({ kind: "turn.completed", threadId, turnId, status: "completed" });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.requireStarted();
    this.cancelledTurns.add(turnId);
    for (const [itemId, p] of [...this.pendingTurns]) {
      if (p.turnId === turnId) {
        this.pendingTurns.delete(itemId);
        p.resolve("cancelled");
      }
    }
    this.emit({ kind: "turn.completed", threadId, turnId, status: "interrupted" });
  }

  async respondApproval(req: ApprovalRequest, decision: string): Promise<void> {
    const pending = this.pendingTurns.get(req.itemId);
    if (!pending) return; // Already resolved / cleared: nothing to resume.
    this.pendingTurns.delete(req.itemId);
    pending.resolve(decision);
  }

  cancelPendingApproval(itemId: string, reason: string): void {
    const pending = this.pendingTurns.get(itemId);
    if (!pending) return;
    this.pendingTurns.delete(itemId);
    pending.resolve(reason === "expired" ? "expired" : "cancelled");
  }
}
