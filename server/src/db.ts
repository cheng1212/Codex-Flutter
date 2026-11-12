import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * SQLite persistence (Node built-in `node:sqlite`, no native dependency).
 * Stores: paired devices (token hashes only), pairing codes (hashes only),
 * session index, protocol events with the global seq, processed requestIds
 * for idempotent replays, and pending approvals.
 *
 * No Codex credentials are stored here: Codex auth stays in the user's
 * own `~/.codex/auth.json` / env on the desktop and is never sent to a
 * client (Phase 2 adapter must keep that boundary too).
 */

export interface DbSessionRow {
  session_id: string;
  thread_id: string;
  project_id: string;
  cwd: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface DbEventRow {
  seq: number;
  event_id: string;
  session_id: string;
  type: string;
  payload: string;
  created_at: string;
}

export interface DbApprovalRow {
  item_id: string;
  session_id: string;
  thread_id: string;
  turn_id: string;
  kind: string;
  available_decisions: string;
  status: string;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolved_reason: string | null;
}

export class Store {
  private readonly db: DatabaseSync;
  readonly maxEvents: number;

  constructor(dataDir: string, maxEvents = 5000) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "companion.db"));
    this.maxEvents = maxEvents;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL,
        name TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
        project_id TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL,
        session_id TEXT NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processed_requests (
        request_id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
        response TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (
        item_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, kind TEXT NOT NULL,
        available_decisions TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        resolved_at TEXT, resolved_reason TEXT);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id, status);
    `);
    this.db.prepare(
      `INSERT OR IGNORE INTO meta(key, value) VALUES ('floor_seq', '0')`,
    ).run();
  }

  close(): void {
    this.db.close();
  }

  // -- meta / retention -------------------------------------------------
  floorSeq(): number {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key='floor_seq'`)
      .get() as { value: string } | undefined;
    return Number(row?.value ?? 0);
  }

  private pruneEvents(): void {
    const { count } = this.db
      .prepare(`SELECT COUNT(*) AS count FROM events`)
      .get() as { count: number };
    if (count <= this.maxEvents) return;
    const excess = count - this.maxEvents;
    const oldest = this.db
      .prepare(`SELECT seq FROM events ORDER BY seq ASC LIMIT 1 OFFSET ?`)
      .get(excess - 1) as { seq: number } | undefined;
    if (!oldest) return;
    this.db.prepare(`DELETE FROM events WHERE seq <= ?`).run(oldest.seq);
    this.db
      .prepare(`UPDATE meta SET value=? WHERE key='floor_seq'`)
      .run(String(oldest.seq));
  }

  // -- devices ----------------------------------------------------------
  addDevice(deviceId: string, tokenHash: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO devices(device_id, token_hash, name, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(deviceId, tokenHash, name, new Date().toISOString());
  }

  findDeviceByTokenHash(tokenHash: string): { device_id: string; revoked_at: string | null } | undefined {
    return this.db
      .prepare(
        `SELECT device_id, revoked_at FROM devices WHERE token_hash = ?`,
      )
      .get(tokenHash) as
      | { device_id: string; revoked_at: string | null }
      | undefined;
  }

  revokeDevice(deviceId: string): void {
    this.db
      .prepare(`UPDATE devices SET revoked_at=? WHERE device_id=?`)
      .run(new Date().toISOString(), deviceId);
  }

  // -- pairing codes ----------------------------------------------------
  addPairingCode(codeHash: string, expiresAt: string): void {
    this.db
      .prepare(`INSERT INTO pairing_codes(code_hash, expires_at) VALUES (?, ?)`)
      .run(codeHash, expiresAt);
  }

  claimPairingCode(codeHash: string): boolean {
    const row = this.db
      .prepare(`SELECT expires_at, used_at FROM pairing_codes WHERE code_hash = ?`)
      .get(codeHash) as { expires_at: string; used_at: string | null } | undefined;
    if (!row || row.used_at) return false;
    if (new Date(row.expires_at).getTime() < Date.now()) return false;
    this.db
      .prepare(`UPDATE pairing_codes SET used_at=? WHERE code_hash=?`)
      .run(new Date().toISOString(), codeHash);
    return true;
  }

  // -- sessions ---------------------------------------------------------
  insertSession(row: Omit<DbSessionRow, "created_at" | "updated_at">): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions(session_id, thread_id, project_id, cwd, title, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.session_id, row.thread_id, row.project_id, row.cwd, row.title, row.status, now, now);
  }

  listSessions(): DbSessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions ORDER BY created_at DESC`)
      .all() as unknown as DbSessionRow[];
  }

  getSession(sessionId: string): DbSessionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE session_id = ?`)
      .get(sessionId) as DbSessionRow | undefined;
  }

  updateSessionStatus(sessionId: string, status: string): void {
    this.db
      .prepare(`UPDATE sessions SET status=?, updated_at=? WHERE session_id=?`)
      .run(status, new Date().toISOString(), sessionId);
  }

  // -- events -----------------------------------------------------------
  insertEvent(eventId: string, sessionId: string, type: string, payload: string): number {
    const info = this.db
      .prepare(
        `INSERT INTO events(event_id, session_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(eventId, sessionId, type, payload, new Date().toISOString());
    const seq = Number(info.lastInsertRowid);
    this.pruneEvents();
    return seq;
  }

  eventsSince(lastSeq: number, limit = 500): DbEventRow[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`)
      .all(lastSeq, limit) as unknown as DbEventRow[];
  }

  eventsForSession(sessionId: string, afterSeq: number, limit = 500): DbEventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(sessionId, afterSeq, limit) as unknown as DbEventRow[];
  }

  // -- idempotent requests ----------------------------------------------
  getProcessedRequest(requestId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT response FROM processed_requests WHERE request_id = ?`)
      .get(requestId) as { response: string } | undefined;
    return row?.response;
  }

  storeProcessedRequest(requestId: string, deviceId: string, response: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_requests(request_id, device_id, response, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(requestId, deviceId, response, new Date().toISOString());
  }

  // -- approvals ----------------------------------------------------------
  upsertApproval(row: Omit<DbApprovalRow, "resolved_at" | "resolved_reason">): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO approvals
           (item_id, session_id, thread_id, turn_id, kind, available_decisions, status, created_at, expires_at, resolved_at, resolved_reason)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)`,
      )
      .run(
        row.item_id, row.session_id, row.thread_id, row.turn_id, row.kind,
        row.available_decisions, row.created_at, row.expires_at,
      );
  }

  getApproval(itemId: string): DbApprovalRow | undefined {
    return this.db
      .prepare(`SELECT * FROM approvals WHERE item_id = ?`)
      .get(itemId) as DbApprovalRow | undefined;
  }

  listPendingApprovals(): DbApprovalRow[] {
    return this.db
      .prepare(`SELECT * FROM approvals WHERE status='pending' ORDER BY created_at ASC`)
      .all() as unknown as DbApprovalRow[];
  }

  resolveApproval(itemId: string, status: string, reason?: string): void {
    this.db
      .prepare(
        `UPDATE approvals SET status=?, resolved_at=?, resolved_reason=? WHERE item_id=?`,
      )
      .run(status, new Date().toISOString(), reason ?? null, itemId);
  }
}
