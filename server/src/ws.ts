import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";

/**
 * Minimal WebSocket server (RFC 6455) built on Node's `http` module.
 *
 * Deliberately dependency-free: the companion has zero runtime npm
 * dependencies, so a broken or compromised registry cannot change what
 * runs on the user's desktop. Only text frames are used; binary frames
 * are rejected. Handles masked client frames, ping/pong and close.
 */

export interface WsConnection {
  socket: net.Socket;
  sendText(text: string): void;
  close(code?: number): void;
  onMessage: ((text: string) => void) | null;
  onClose: (() => void) | null;
  remoteAddress: string;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(key: string): string {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

function encodeFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeControl(opcode: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export function handleWsUpgrade(
  req: http.IncomingMessage,
  socket: net.Socket,
  onConnection: (conn: WsConnection) => void,
): boolean {
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  if (upgrade !== "websocket" || typeof key !== "string") return false;
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  let buffer = Buffer.alloc(0);
  let closed = false;
  const conn: WsConnection = {
    socket,
    sendText(text: string) {
      if (!closed) socket.write(encodeFrame(text));
    },
    close(code = 1000) {
      if (closed) return;
      closed = true;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      socket.write(encodeControl(8, payload));
      socket.end();
    },
    onMessage: null,
    onClose: null,
    remoteAddress: socket.remoteAddress ?? "",
  };
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = masked ? 4 : 0;
      if (buffer.length < offset + maskOffset + len) return;
      let payload = buffer.subarray(offset + maskOffset, offset + maskOffset + len);
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      }
      buffer = buffer.subarray(offset + maskOffset + len);
      if (!fin) {
        // Fragmented messages are not used by this protocol; drop them.
        continue;
      }
      if (opcode === 9) {
        socket.write(encodeControl(10, Buffer.from(payload)));
      } else if (opcode === 8) {
        if (!closed) {
          closed = true;
          socket.end();
        }
        conn.onClose?.();
      } else if (opcode === 1) {
        conn.onMessage?.(payload.toString("utf8"));
      } else {
        // Binary / continuation / unknown: ignore.
      }
    }
  });
  socket.on("error", () => {
    if (!closed) {
      closed = true;
      conn.onClose?.();
    }
  });
  socket.on("close", () => {
    if (!closed) {
      closed = true;
      conn.onClose?.();
    }
  });
  onConnection(conn);
  return true;
}
