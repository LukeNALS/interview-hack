import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";

/**
 * WebSocket server tối thiểu (RFC 6455) — TỰ VIẾT, không thêm dependency.
 *
 * Lý do không dùng `ws`: package.json phase này chỉ được THÊM script `test:e2e`.
 * `ws` tuy resolve được (dep bắc cầu của @supabase/realtime-js) nhưng là dependency
 * KHÔNG khai báo — pnpm layout chặt, `pnpm install` sạch hoặc CI runner khác có thể
 * không resolve ra → suite E2E vỡ vì lý do không liên quan gì tới sản phẩm.
 *
 * Phạm vi vừa đủ cho mock Soniox: text + binary frame, client masking, close.
 * KHÔNG hỗ trợ: compression (permessage-deflate — không advertise nên browser không dùng).
 */

/**
 * Magic string RFC 6455 §1.3. CHỈ ĐƯỢC ĐỔI khi đối chiếu với implementation thật —
 * giá trị trước đây ở đây (`...-95CA-5AB0DC85B39A`) sai 2 nhóm cuối nên MỌI handshake
 * đều bị client từ chối ("Incorrect 'Sec-WebSocket-Accept' header value") và mock
 * Soniox chưa từng nhận được connection nào. Giá trị dưới đây đã đối chiếu với
 * `ws@8.21.2` (lib/constants.js) và verify bằng client WebSocket thật của Node.
 */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODE = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa } as const;

export interface WsFrame {
  opcode: number;
  payload: Buffer;
}

/** Trả lời handshake HTTP Upgrade. Gọi trong listener `upgrade` của http.Server. */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex): boolean {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return false;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  // Socket của sự kiện `upgrade` thực chất là net.Socket; @types/node khai là Duplex.
  if ("setNoDelay" in socket) (socket as unknown as { setNoDelay(v: boolean): void }).setNoDelay(true);
  return true;
}

/** Đóng gói 1 frame server→client (server KHÔNG mask theo RFC). */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Parser tích luỹ byte → frame hoàn chỉnh. Trả về số byte đã tiêu thụ và frame
 * (null nếu chưa đủ dữ liệu). Client LUÔN mask (RFC bắt buộc) nên có unmask.
 */
function decodeFrame(buf: Buffer): { frame: WsFrame; consumed: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }

  let mask: Buffer | undefined;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }
  return { frame: { opcode, payload }, consumed: offset + len };
}

/** Gắn parser vào socket; gọi `onFrame` cho mỗi frame nhận được. */
export function readFrames(socket: Duplex, onFrame: (frame: WsFrame) => void): void {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const decoded = decodeFrame(buffer);
      if (!decoded) break;
      buffer = buffer.subarray(decoded.consumed);
      onFrame(decoded.frame);
    }
  });
}

export function sendText(socket: Duplex, text: string): void {
  if (socket.writable) socket.write(encodeFrame(OPCODE.TEXT, Buffer.from(text, "utf8")));
}

export function sendJson(socket: Duplex, value: unknown): void {
  sendText(socket, JSON.stringify(value));
}

export function sendClose(socket: Duplex): void {
  if (socket.writable) socket.write(encodeFrame(OPCODE.CLOSE, Buffer.alloc(0)));
}
