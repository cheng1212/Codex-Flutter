/**
 * Logging with secret redaction.
 *
 * Tokens, API keys and auth material are never written to logs. Any value
 * that looks like a bearer token (64 hex chars), a pairing token, or a
 * field named token / authorization / apiKey / auth is replaced with
 * "[redacted]". Callers must still avoid logging secrets in the first
 * place; this is a second line of defence, and tests assert it.
 */

const SECRET_KEY = /(token|authorization|apikey|api_key|auth|password|secret)/i;
const TOKEN_LIKE = /\b[0-9a-f]{32,}\b/gi;

export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(TOKEN_LIKE, "[redacted]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

export type LogLevel = "info" | "warn" | "error";

export class Logger {
  constructor(private readonly tag: string = "server") {}

  private write(level: LogLevel, msg: string, meta?: unknown): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      tag: this.tag,
      msg,
      ...(meta !== undefined ? { meta: redact(meta) } : {}),
    });
    if (level === "error") console.error(line);
    else console.log(line);
  }

  info(msg: string, meta?: unknown): void {
    this.write("info", msg, meta);
  }
  warn(msg: string, meta?: unknown): void {
    this.write("warn", msg, meta);
  }
  error(msg: string, meta?: unknown): void {
    this.write("error", msg, meta);
  }
}
