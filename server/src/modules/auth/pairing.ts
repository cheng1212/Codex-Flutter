import crypto from "node:crypto";
import type { Store } from "../../db.js";

/**
 * Pairing & device auth.
 *
 * - One-time pairing code (6 digits, 5 min by default, single use). The
 *   code is only *created* from a loopback connection (see http.ts): the
 *   desktop operator reads it on their own machine, the phone claims it.
 * - On claim the server issues a high-entropy access token (32 random
 *   bytes). Only the SHA-256 hash is stored; the raw token is shown once
 *   and never logged. Revoking a device invalidates its token.
 * - Tokens are bearer credentials equivalent to Codex control on this
 *   machine: treat them as high-sensitivity, like the README requires.
 */

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function newDeviceId(): string {
  return `dev_${crypto.randomBytes(8).toString("hex")}`;
}

export function newToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export class PairingService {
  constructor(
    private readonly store: Store,
    private readonly codeTtlMs: number,
  ) {}

  /** Create a one-time pairing code. Returns the plain code (loopback only). */
  createCode(): { code: string; expiresAt: string } {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(Date.now() + this.codeTtlMs).toISOString();
    this.store.addPairingCode(sha256(code), expiresAt);
    return { code, expiresAt };
  }

  /**
   * Claim a code and issue a device token. Returns null when the code is
   * wrong, expired, or already used.
   */
  claim(code: string, deviceName: string): { deviceId: string; token: string } | null {
    if (!this.store.claimPairingCode(sha256(code))) return null;
    const deviceId = newDeviceId();
    const token = newToken();
    this.store.addDevice(deviceId, sha256(token), deviceName);
    return { deviceId, token };
  }

  /** Resolve a bearer token to a (non-revoked) device id, or null. */
  verifyToken(token: string): string | null {
    const row = this.store.findDeviceByTokenHash(sha256(token));
    if (!row || row.revoked_at) return null;
    return row.device_id;
  }

  revoke(deviceId: string): void {
    this.store.revokeDevice(deviceId);
  }
}
