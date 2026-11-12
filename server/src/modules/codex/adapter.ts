import type { ApprovalDecision } from "../../../../packages/protocol/src/types.js";

/**
 * CodexAdapter contract (Phase 0 matrix §6), implemented by the mock in
 * this phase and by the real app-server adapter in Phase 2.
 *
 * Route: `codex app-server` over stdio (JSON-RPC 2.0). The TS SDK / `exec`
 * routes are deliberately NOT in this interface: they have no structured
 * approval events (matrix #12).
 *
 * Key constraints, from the matrix:
 * - Approval is a server-initiated JSON-RPC *request*, not a notification:
 *   the adapter pairs a response to the request's id, and the mobile
 *   client must never approve a request that has been cleared.
 * - Events are summaries only: no raw tool output, env vars or secrets
 *   in event payloads or logs.
 * - Never default to `--dangerously-bypass-approvals-and-sandbox`, and
 *   never expose app-server's own ws listener to the LAN (the companion
 *   is the only layer facing the phone).
 */

export interface ThreadSummary {
  threadId: string;
  cwd: string;
  title: string;
  status: string;
}

export interface TurnHandle {
  turnId: string;
  threadId: string;
}

export type CodexEventKind =
  | "thread.started"
  | "item.started"
  | "item.agentMessage/delta"
  | "item.completed"
  | "turn.completed"
  | "item.commandExecution/requestApproval"
  | "item.fileChange/requestApproval";

/** Raw app-server-shaped event, before mapping to the companion protocol. */
export interface CodexEvent {
  kind: CodexEventKind;
  threadId: string;
  turnId?: string;
  itemId?: string;
  /** agent_message | command_execution | file_change | todo_list */
  itemType?: string;
  /** Streaming assistant text (item.agentMessage/delta only). */
  delta?: string;
  /** completed | failed | declined | interrupted */
  status?: string;
  /** One-line summary only (tool events). */
  summary?: string;
  /** Approval request fields (requestApproval kinds only). */
  command?: string;
  cwd?: string;
  reason?: string;
  availableDecisions?: ApprovalDecision[];
  networkApprovalContext?: { host?: string; protocol?: string };
}

export interface ApprovalRequest {
  itemId: string;
  threadId: string;
  turnId: string;
  kind: "commandExecution" | "fileChange";
  availableDecisions: ApprovalDecision[];
  command?: string;
  cwd?: string;
  reason?: string;
  networkApprovalContext?: { host?: string; protocol?: string };
}

export interface CodexAdapter {
  /** Start the underlying Codex process and complete the initialize handshake. */
  start(): Promise<void>;
  stop(): Promise<void>;
  listThreads(opts?: { limit?: number; cursor?: string | null }): Promise<ThreadSummary[]>;
  createThread(opts: { cwd: string; model?: string; title?: string }): Promise<ThreadSummary>;
  resumeThread(threadId: string): Promise<ThreadSummary>;
  readThread(threadId: string): Promise<ThreadSummary & { turns: unknown[]; items: unknown[] }>;
  startTurn(threadId: string, input: string): Promise<TurnHandle>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  respondApproval(req: ApprovalRequest, decision: ApprovalDecision): Promise<void>;
  /** Called by the server when a pending approval expired / was cleared. */
  cancelPendingApproval(itemId: string, reason: string): void;
  on(event: "codex-event", cb: (e: CodexEvent) => void): void;
}
