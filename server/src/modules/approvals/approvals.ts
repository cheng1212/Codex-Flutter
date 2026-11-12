import type { ApprovalDecision, ApprovalResolvedPayload } from "../../../../packages/protocol/src/types.js";
import type { Store } from "../../db.js";

/**
 * Approval registry — the enforcement point for Issue #1.
 *
 * - The ONLY valid decisions for a request are the ones in its own
 *   `availableDecisions`. The server checks the decision against that list
 *   on every response; a request that only offers ["accept","decline"]
 *   can never be answered with "acceptForSession" or anything else.
 * - Persistent grants (`acceptForSession` and the execpolicy / network
 *   policy amendments) are blocked by default (`allowPersistentApprovals`
 *   is false) even when the request lists them — they need a separate
 *   review before they are exposed to a phone.
 * - A request stops being answerable the moment it is resolved, expired,
 *   cancelled, or its turn ends / the client disconnects. Answering a
 *   dead request returns a 410 ("approval-no-longer-pending") and the
 *   adapter is never called — the phone must never approve a request
 *   that no longer exists on the server.
 */

export type ApprovalErrorCode =
  | "approval-not-found"
  | "approval-no-longer-pending"
  | "decision-not-offered"
  | "decision-not-allowed";

export class ApprovalError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Decisions that grant something beyond the single request. */
export const RESTRICTED_DECISIONS: ApprovalDecision[] = [
  "acceptForSession",
  "acceptWithExecpolicyAmendment",
  "applyNetworkPolicyAmendment",
];

export interface PendingApproval {
  itemId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  kind: "commandExecution" | "fileChange";
  availableDecisions: ApprovalDecision[];
}

export class ApprovalStore {
  constructor(
    private readonly store: Store,
    private readonly ttlMs: number,
    private readonly allowPersistentApprovals: boolean,
    private readonly onCleared: (itemId: string, reason: string) => void,
  ) {}

  register(a: PendingApproval & { command?: string; cwd?: string; reason?: string }): void {
    const now = new Date();
    this.store.upsertApproval({
      item_id: a.itemId,
      session_id: a.sessionId,
      thread_id: a.threadId,
      turn_id: a.turnId,
      kind: a.kind,
      available_decisions: JSON.stringify(a.availableDecisions),
      status: "pending",
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.ttlMs).toISOString(),
    });
  }

  private rowToPending(row: NonNullable<ReturnType<Store["getApproval"]>>): PendingApproval {
    return {
      itemId: row.item_id,
      sessionId: row.session_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      kind: row.kind as PendingApproval["kind"],
      availableDecisions: JSON.parse(row.available_decisions) as ApprovalDecision[],
    };
  }

  /** Reap expired approvals; callers should run this on a timer. */
  reapExpired(now = Date.now()): string[] {
    const cleared: string[] = [];
    for (const row of this.store.listPendingApprovals()) {
      if (new Date(row.expires_at).getTime() <= now) {
        this.store.resolveApproval(row.item_id, "expired", "expired");
        cleared.push(row.item_id);
        this.onCleared(row.item_id, "expired");
      }
    }
    return cleared;
  }

  /** Clear all pending approvals for a turn (turn ended / interrupted). */
  clearForTurn(threadId: string, turnId: string, reason: string): string[] {
    const cleared: string[] = [];
    for (const row of this.store.listPendingApprovals()) {
      if (row.thread_id === threadId && row.turn_id === turnId) {
        this.store.resolveApproval(row.item_id, "cleared", reason);
        cleared.push(row.item_id);
        this.onCleared(row.item_id, reason);
      }
    }
    return cleared;
  }

  /** Clear all pending approvals for a session (client disconnected). */
  clearForSession(sessionId: string, reason: string): string[] {
    const cleared: string[] = [];
    for (const row of this.store.listPendingApprovals()) {
      if (row.session_id === sessionId) {
        this.store.resolveApproval(row.item_id, "cleared", reason);
        cleared.push(row.item_id);
        this.onCleared(row.item_id, reason);
      }
    }
    return cleared;
  }

  /**
   * Validate and record a user decision. Returns the resolved payload
   * for the `approval.resolved` event. Throws ApprovalError on any
   * invalid attempt; the adapter is never called for those.
   */
  respond(
    itemId: string,
    decision: ApprovalDecision,
  ): ApprovalResolvedPayload {
    const row = this.store.getApproval(itemId);
    if (!row) throw new ApprovalError("approval-not-found", `unknown approval: ${itemId}`);
    if (row.status !== "pending") {
      throw new ApprovalError(
        "approval-no-longer-pending",
        `approval ${itemId} is ${row.status} and can no longer be answered`,
      );
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      this.store.resolveApproval(itemId, "expired", "expired");
      this.onCleared(itemId, "expired");
      throw new ApprovalError("approval-no-longer-pending", `approval ${itemId} has expired`);
    }
    const offered: ApprovalDecision[] = JSON.parse(row.available_decisions);
    if (!offered.includes(decision)) {
      throw new ApprovalError(
        "decision-not-offered",
        `decision "${decision}" was not offered by this request (offered: ${offered.join(", ")})`,
      );
    }
    if (RESTRICTED_DECISIONS.includes(decision) && !this.allowPersistentApprovals) {
      throw new ApprovalError(
        "decision-not-allowed",
        `decision "${decision}" is a persistent grant and is not enabled on this server`,
      );
    }
    const status = decision === "accept" || decision === "acceptForSession" ? "accepted" : decision === "decline" ? "declined" : "cancelled";
    this.store.resolveApproval(itemId, status);
    const pending = this.rowToPending({ ...row, status });
    return {
      itemId: pending.itemId,
      threadId: pending.threadId,
      turnId: pending.turnId,
      status,
      decision,
    };
  }
}
