import crypto from "node:crypto";
import { PROTOCOL_VERSION, type EventEnvelope, type EventType } from "../../../../packages/protocol/src/types.js";
import type { Store } from "../../db.js";

/**
 * Event bus: the companion's own event log.
 *
 * The app-server protocol has no global sequence number (matrix #22), so
 * the companion assigns one: `seq` is the SQLite row id of the event —
 * global, monotonic, durable across restarts. Clients reconnect with
 * `lastSeq` and get every event after it; if the client is behind the
 * retention window (`maxEvents`, default 5000) the bus answers
 * `snapshotRequired` and the client falls back to the REST history
 * snapshot instead of receiving a partial stream.
 *
 * Payloads are summaries only (matrix §6): never raw tool output, env
 * vars or secrets.
 */

export interface Replay {
  snapshotRequired: boolean;
  events: EventEnvelope[];
}

export class EventBus {
  private subscribers = new Set<(e: EventEnvelope) => void>();

  constructor(private readonly store: Store) {}

  subscribe(cb: (e: EventEnvelope) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /**
   * Publish an event. Returns null only when the store is already closed
   * (shutdown race): in that case nobody is listening any more, so the
   * event is dropped instead of crashing the process with an unhandled
   * rejection. Normal operation always returns the envelope.
   */
  publish(sessionId: string, type: EventType, payload: Record<string, unknown>): EventEnvelope | null {
    const eventId = `evt_${crypto.randomBytes(8).toString("hex")}`;
    let seq: number;
    try {
      seq = this.store.insertEvent(eventId, sessionId, type, JSON.stringify(payload));
    } catch {
      return null;
    }
    const envelope: EventEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      eventId,
      seq,
      sessionId,
      timestamp: new Date().toISOString(),
      type,
      payload,
    };
    for (const cb of this.subscribers) cb(envelope);
    return envelope;
  }

  replaySince(lastSeq: number, limit = 500): Replay {
    const floor = this.store.floorSeq();
    if (lastSeq < floor) {
      return { snapshotRequired: true, events: [] };
    }
    const rows = this.store.eventsSince(lastSeq, limit);
    return {
      snapshotRequired: false,
      events: rows.map((r) => ({
        protocolVersion: PROTOCOL_VERSION,
        eventId: r.event_id,
        seq: r.seq,
        sessionId: r.session_id,
        timestamp: r.created_at,
        type: r.type as EventType,
        payload: JSON.parse(r.payload) as Record<string, unknown>,
      })),
    };
  }

  historyForSession(sessionId: string, afterSeq: number, limit = 500): Replay {
    const floor = this.store.floorSeq();
    if (afterSeq < floor) {
      return { snapshotRequired: true, events: [] };
    }
    const rows = this.store.eventsForSession(sessionId, afterSeq, limit);
    return {
      snapshotRequired: false,
      events: rows.map((r) => ({
        protocolVersion: PROTOCOL_VERSION,
        eventId: r.event_id,
        seq: r.seq,
        sessionId: r.session_id,
        timestamp: r.created_at,
        type: r.type as EventType,
        payload: JSON.parse(r.payload) as Record<string, unknown>,
      })),
    };
  }
}
