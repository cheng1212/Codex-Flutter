/**
 * Shared protocol types for Codex Flutter, protocolVersion "1.0.0".
 *
 * Hand-maintained to match `schema/protocol.schema.json`; contract tests
 * validate every fixture in `fixtures/` against the schema, so a drift
 * between this file and the schema fails `npm test`.
 *
 * Event names are mapped from the real `codex app-server` shapes verified
 * in Phase 0 (docs/codex-capability-matrix.md §4/§6). No invented names.
 */

export const PROTOCOL_VERSION = "1.0.0" as const;

export type EventType =
  | "session.created"
  | "session.status"
  | "message.started"
  | "message.delta"
  | "message.completed"
  | "plan.updated"
  | "tool.started"
  | "tool.output"
  | "tool.completed"
  | "approval.requested"
  | "approval.resolved"
  | "session.error"
  | "connection.heartbeat";

export type CommandName =
  | "session.create"
  | "session.resume"
  | "message.send"
  | "session.cancel"
  | "approval.respond";

/** Decisions a real app-server approval request may carry (matrix #9/#10). */
export type ApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | "acceptWithExecpolicyAmendment"
  | "applyNetworkPolicyAmendment";

/**
 * Decisions the companion exposes to the mobile client by default.
 * `acceptForSession` and the policy-amendment decisions are persistent
 * grants: they stay server-blocked (403) unless an operator explicitly
 * enables them after review. See docs/protocol.md.
 */
export type ClientApprovalDecision = "accept" | "decline" | "cancel";

export interface EventEnvelope<P = Record<string, unknown>> {
  protocolVersion: typeof PROTOCOL_VERSION;
  eventId: string;
  /** Server-assigned global monotonic sequence (companion-implemented). */
  seq: number;
  /** Companion session id; empty string for connection-level events. */
  sessionId: string;
  timestamp: string;
  type: EventType;
  payload: P;
}

export interface ApprovalRequestedPayload {
  itemId: string;
  threadId: string;
  turnId: string;
  kind: "commandExecution" | "fileChange" | "permissions";
  /** Authoritative: the client may only offer exactly these decisions. */
  availableDecisions: ApprovalDecision[];
  reason?: string;
  command?: string;
  cwd?: string;
  networkApprovalContext?: { host?: string; protocol?: string };
  /** Permissions kind only: one-line summaries of the requested grants. */
  permissions?: string[];
  expiresAt?: string;
}

export type ApprovalResolvedStatus =
  | "accepted"
  | "declined"
  | "cancelled"
  | "expired"
  | "cleared";

export interface ApprovalResolvedPayload {
  itemId: string;
  threadId: string;
  turnId: string;
  status: ApprovalResolvedStatus;
  decision?: ApprovalDecision;
  /** Why the request was cleared without a user decision. */
  reason?: string;
}

export interface ClientCommand<P = Record<string, unknown>> {
  type: "command";
  /** Unique per side-effecting command; the server dedupes replays. */
  requestId: string;
  command: CommandName;
  payload: P;
}

export interface SessionCreatePayload {
  projectId: string;
  /** Working directory; must resolve inside an allow-listed workspace root. */
  cwd: string;
  title?: string;
}

export interface MessageSendPayload {
  sessionId: string;
  text: string;
}

export interface ApprovalRespondPayload {
  sessionId: string;
  itemId: string;
  decision: ClientApprovalDecision;
}

/** Wire shape of a server reply to a client command. */
export interface CommandResult {
  type: "command-result";
  requestId: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}
