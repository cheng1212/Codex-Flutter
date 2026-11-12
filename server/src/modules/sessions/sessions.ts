import crypto from "node:crypto";
import type { Store } from "../../db.js";
import type { ProjectsService } from "../projects/projects.js";
import type { ApprovalStore } from "../approvals/approvals.js";
import type { CodexAdapter, CodexEvent } from "../codex/adapter.js";
import type { EventBus } from "../events/event-bus.js";

/**
 * Session service: the seam between the client-facing protocol and the
 * CodexAdapter. It owns the threadId <-> sessionId mapping and maps raw
 * app-server-shaped adapter events to companion protocol events.
 *
 * Mapping (matrix §4/§6, no invented names):
 * - thread.started            -> session.status {status:"active"} (resume path;
 *                                create path publishes session.created itself)
 * - item.started agent_message -> message.started
 * - item.started command_execution / file_change / todo_list -> tool.started
 * - item.agentMessage/delta   -> message.delta
 * - item.completed agent_message -> message.completed
 * - item.completed command_execution / file_change -> tool.completed
 * - item.completed todo_list  -> plan.updated
 * - turn.completed            -> session.status {status}
 * - item/commandExecution|fileChange|permissions/requestApproval
 *   -> approval.requested (registered in ApprovalStore first, so a
 *   response can only arrive after the request exists server-side)
 * - plan.updated              -> plan.updated {summary}
 * - session.error             -> session.error {message}
 * - approval.cleared          -> the app-server resolved an approval
 *   request itself; the store clears it so the phone can never answer it
 */

export interface SessionInfo {
  sessionId: string;
  threadId: string;
  projectId: string;
  cwd: string;
  title: string;
  status: string;
}

export class SessionsService {
  private currentTurn = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private readonly projects: ProjectsService,
    private readonly adapter: CodexAdapter,
    private readonly bus: EventBus,
    private readonly approvals: ApprovalStore,
  ) {
    adapter.on("codex-event", (e) => this.onCodexEvent(e));
  }

  private sessionIdForThread(threadId: string): string | undefined {
    return this.store.listSessions().find((s) => s.thread_id === threadId)?.session_id;
  }

  private onCodexEvent(e: CodexEvent): void {
    const sessionId = this.sessionIdForThread(e.threadId);
    if (!sessionId && e.kind !== "thread.started") return;
    switch (e.kind) {
      case "thread.started": {
        if (sessionId) this.bus.publish(sessionId, "session.status", { status: "active", threadId: e.threadId });
        break;
      }
      case "item.started": {
        if (!sessionId) break;
        if (e.itemType === "agent_message") {
          this.bus.publish(sessionId, "message.started", { itemId: e.itemId, turnId: e.turnId });
        } else {
          this.bus.publish(sessionId, "tool.started", { itemId: e.itemId, kind: e.itemType, turnId: e.turnId });
        }
        break;
      }
      case "item.agentMessage/delta": {
        if (!sessionId) break;
        this.bus.publish(sessionId, "message.delta", { itemId: e.itemId, turnId: e.turnId, delta: e.delta ?? "" });
        break;
      }
      case "item.completed": {
        if (!sessionId) break;
        if (e.itemType === "agent_message") {
          this.bus.publish(sessionId, "message.completed", { itemId: e.itemId, turnId: e.turnId, status: e.status ?? "completed" });
        } else if (e.itemType === "todo_list") {
          this.bus.publish(sessionId, "plan.updated", { itemId: e.itemId, turnId: e.turnId, summary: e.summary ?? "" });
        } else {
          this.bus.publish(sessionId, "tool.completed", { itemId: e.itemId, kind: e.itemType, turnId: e.turnId, status: e.status ?? "completed", summary: e.summary ?? "" });
        }
        break;
      }
      case "turn.completed": {
        if (!sessionId) break;
        this.currentTurn.delete(sessionId);
        this.store.updateSessionStatus(sessionId, "active");
        this.bus.publish(sessionId, "session.status", { status: e.status ?? "completed", turnId: e.turnId, threadId: e.threadId });
        // Any approval still pending for this turn is dead: clear it so
        // the phone can never approve a request from a finished turn.
        if (e.turnId) this.approvals.clearForTurn(e.threadId, e.turnId, "turn ended");
        break;
      }
      case "item.commandExecution/requestApproval":
      case "item.fileChange/requestApproval":
      case "item.permissions/requestApproval": {
        if (!sessionId) break;
        const kind =
          e.kind === "item.commandExecution/requestApproval"
            ? "commandExecution"
            : e.kind === "item.fileChange/requestApproval"
              ? "fileChange"
              : "permissions";
        this.approvals.register({
          itemId: e.itemId ?? "",
          sessionId,
          threadId: e.threadId,
          turnId: e.turnId ?? "",
          kind,
          availableDecisions: e.availableDecisions ?? ["accept", "decline"],
          command: e.command,
          cwd: e.cwd,
          reason: e.reason,
        });
        this.bus.publish(sessionId, "approval.requested", {
          itemId: e.itemId,
          threadId: e.threadId,
          turnId: e.turnId,
          kind,
          availableDecisions: e.availableDecisions ?? ["accept", "decline"],
          ...(e.reason ? { reason: e.reason } : {}),
          ...(e.command ? { command: e.command } : {}),
          ...(e.cwd ? { cwd: e.cwd } : {}),
          ...(e.networkApprovalContext ? { networkApprovalContext: e.networkApprovalContext } : {}),
          ...(e.permissions ? { permissions: e.permissions } : {}),
        });
        break;
      }
      case "plan.updated": {
        if (!sessionId) break;
        this.bus.publish(sessionId, "plan.updated", { turnId: e.turnId, summary: e.summary ?? "plan updated" });
        break;
      }
      case "session.error": {
        if (!sessionId) break;
        this.bus.publish(sessionId, "session.error", { turnId: e.turnId, message: e.summary ?? "codex error" });
        break;
      }
      case "approval.cleared": {
        if (!sessionId) break;
        this.approvals.clearOne(e.itemId ?? "", e.reason ?? "cleared by codex");
        break;
      }
    }
  }

  async createSession(opts: { projectId: string; cwd: string; title?: string }): Promise<SessionInfo> {
    const checked = this.projects.validateCwd(opts.projectId, opts.cwd);
    if (!checked.ok) throw new Error(checked.reason);
    const thread = await this.adapter.createThread({ cwd: checked.path, title: opts.title });
    const sessionId = `ses_${crypto.randomBytes(8).toString("hex")}`;
    this.store.insertSession({
      session_id: sessionId,
      thread_id: thread.threadId,
      project_id: opts.projectId,
      cwd: checked.path,
      title: opts.title ?? "session",
      status: "active",
    });
    this.bus.publish(sessionId, "session.created", {
      threadId: thread.threadId,
      projectId: opts.projectId,
      cwd: checked.path,
      title: opts.title ?? "session",
    });
    return { sessionId, threadId: thread.threadId, projectId: opts.projectId, cwd: checked.path, title: opts.title ?? "session", status: "active" };
  }

  async resumeSession(sessionId: string): Promise<SessionInfo> {
    const row = this.store.getSession(sessionId);
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    const thread = await this.adapter.resumeThread(row.thread_id);
    this.store.updateSessionStatus(sessionId, "active");
    return { sessionId, threadId: thread.threadId, projectId: row.project_id, cwd: row.cwd, title: row.title, status: "active" };
  }

  async sendMessage(sessionId: string, text: string): Promise<{ turnId: string }> {
    const row = this.store.getSession(sessionId);
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    if (!text.trim()) throw new Error("message text is empty");
    const handle = await this.adapter.startTurn(row.thread_id, text);
    this.currentTurn.set(sessionId, handle.turnId);
    this.store.updateSessionStatus(sessionId, "running");
    return { turnId: handle.turnId };
  }

  async cancelSession(sessionId: string): Promise<{ cancelledTurnId: string | null }> {
    const row = this.store.getSession(sessionId);
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    const turnId = this.currentTurn.get(sessionId) ?? null;
    if (turnId) {
      this.approvals.clearForTurn(row.thread_id, turnId, "turn cancelled");
      await this.adapter.interruptTurn(row.thread_id, turnId);
      this.currentTurn.delete(sessionId);
    }
    this.store.updateSessionStatus(sessionId, "active");
    return { cancelledTurnId: turnId };
  }

  listSessions(): SessionInfo[] {
    return this.store.listSessions().map((r) => ({
      sessionId: r.session_id,
      threadId: r.thread_id,
      projectId: r.project_id,
      cwd: r.cwd,
      title: r.title,
      status: r.status,
    }));
  }
}
