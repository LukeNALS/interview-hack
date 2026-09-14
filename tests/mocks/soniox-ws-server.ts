import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { acceptUpgrade, OPCODE, readFrames, sendClose, sendJson } from "./ws-protocol";
import { FIXTURE_TURNS, finalTokens, partialTokens } from "./soniox-fixtures";

/**
 * Mock Soniox realtime WS. App trỏ vào đây qua `NEXT_PUBLIC_SONIOX_WS_URL` (P07),
 * dùng SDK @soniox/client THẬT nên phải nói đúng protocol thật:
 *  - client mở socket → gửi 1 text frame config `{api_key, model, translation, ...}`
 *  - client gửi audio dạng BINARY frame
 *  - `finish()` = text frame RỖNG → server phải trả `{finished:true}`
 *  - server chỉ được gửi TEXT frame (SDK bỏ qua mọi frame non-string)
 *
 * PHÁT THEO MỐC THỜI GIAN CỐ ĐỊNH kể từ FRAME AUDIO ĐẦU TIÊN — KHÔNG random (plan
 * §Risk: chống flaky). Mốc phải neo vào audio chứ không phải config: client chỉ gán
 * `epoch_conn` khi feed chunk PCM đầu tiên, và `use-live-session.ts` BỎ QUA mọi segment
 * emit lúc `epoch_conn` còn null. Neo theo config thì AudioWorklet khởi động chậm (dev
 * server, máy tải nặng) sẽ làm vài lượt đầu bị nuốt — transcript thiếu ngẫu nhiên.
 *
 * Cách ly test song song: spec truyền scenario qua chính `api_key` (stub route
 * `/soniox-key` ở browser trả `e2e:<scenario>:<runId>`), server đọc từ config frame.
 */

const PORT = Number(process.argv[process.argv.indexOf("--port") + 1] ?? 55391);

/** Mốc phát: lượt i final tại T0 + (i+1)*TURN_INTERVAL_MS; partial trước đó nửa nhịp. */
const TURN_INTERVAL_MS = 500;
const FIRST_TURN_DELAY_MS = 400;
/** Kịch bản `drop`: cắt socket sau khi phát xong ngần này lượt. */
const DROP_AFTER_TURNS = 3;

interface ParsedKey {
  scenario: string;
  runId: string;
}

function parseApiKey(apiKey: unknown): ParsedKey {
  if (typeof apiKey !== "string") return { scenario: "basic", runId: "anon" };
  const match = /^e2e:([a-z-]+):(.+)$/.exec(apiKey);
  return match ? { scenario: match[1], runId: match[2] } : { scenario: "basic", runId: "anon" };
}

/** Số connection canonical đã mở cho mỗi runId — kịch bản `drop` chỉ cắt lần ĐẦU. */
const connectionCounts = new Map<string, number>();

interface ConnState {
  socket: Duplex;
  channel: "canonical" | "en";
  timers: NodeJS.Timeout[];
  closed: boolean;
}

function scheduleTurns(state: ConnState, scenario: string, attempt: number): void {
  // Lần kết nối đầu của kịch bản drop chỉ phát DROP_AFTER_TURNS lượt rồi cắt;
  // lần kết nối sau (app tự reconnect) phát tiếp phần còn lại.
  const isDropRun = scenario === "drop" && attempt === 1;
  const startIndex = scenario === "drop" && attempt > 1 ? DROP_AFTER_TURNS : 0;
  const endIndex = isDropRun ? DROP_AFTER_TURNS : FIXTURE_TURNS.length;

  for (let i = startIndex; i < endIndex; i += 1) {
    const turn = FIXTURE_TURNS[i];
    const slot = i - startIndex;
    const finalAt = FIRST_TURN_DELAY_MS + (slot + 1) * TURN_INTERVAL_MS;

    state.timers.push(
      setTimeout(() => {
        if (state.closed) return;
        sendJson(state.socket, {
          tokens: partialTokens(turn, i),
          final_audio_proc_ms: 0,
          total_audio_proc_ms: i * 4000,
        });
      }, finalAt - TURN_INTERVAL_MS / 2),
    );

    state.timers.push(
      setTimeout(() => {
        if (state.closed) return;
        sendJson(state.socket, {
          tokens: finalTokens(turn, i, state.channel),
          final_audio_proc_ms: (i + 1) * 4000,
          total_audio_proc_ms: (i + 1) * 4000,
        });
      }, finalAt),
    );
  }

  if (isDropRun) {
    // Cắt phũ (destroy, không close frame) — mô phỏng mất mạng thật để SDK bắn
    // `disconnected` → app hiện banner vàng rồi tự reconnect.
    state.timers.push(
      setTimeout(() => {
        if (state.closed) return;
        state.closed = true;
        state.socket.destroy();
      }, FIRST_TURN_DELAY_MS + (DROP_AFTER_TURNS + 1) * TURN_INTERVAL_MS),
    );
  }
}

function handleConnection(socket: Duplex): void {
  const state: ConnState = { socket, channel: "canonical", timers: [], closed: false };
  let configured = false;
  /** Lịch phát, dựng sau config nhưng chỉ CHẠY khi có audio đầu tiên (xem docblock đầu file). */
  let startSchedule: (() => void) | null = null;

  const cleanup = () => {
    state.closed = true;
    for (const t of state.timers) clearTimeout(t);
    state.timers = [];
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);

  readFrames(socket, (frame) => {
    if (frame.opcode === OPCODE.CLOSE) {
      cleanup();
      sendClose(socket);
      socket.end();
      return;
    }
    // Audio: bỏ qua NỘI DUNG, nhưng chunk ĐẦU TIÊN là mốc khởi động lịch phát.
    if (frame.opcode === OPCODE.BINARY) {
      if (startSchedule) {
        const run = startSchedule;
        startSchedule = null;
        run();
      }
      return;
    }
    if (frame.opcode !== OPCODE.TEXT) return;

    const text = frame.payload.toString("utf8");

    // finish(): text frame RỖNG → trả finished:true để SDK resolve promise.
    if (text.length === 0) {
      cleanup();
      sendJson(socket, { tokens: [], final_audio_proc_ms: 0, total_audio_proc_ms: 0, finished: true });
      return;
    }

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.type === "keepalive" || message.type === "finalize") return;
    if (configured) return;

    configured = true;
    const translation = message.translation as { type?: string } | undefined;
    state.channel = translation?.type === "one_way" ? "en" : "canonical";

    const { scenario, runId } = parseApiKey(message.api_key);
    // Đếm theo runId+channel: mỗi lần reconnect app mở LẠI cả cặp canonical+en.
    const countKey = `${runId}:${state.channel}`;
    const attempt = (connectionCounts.get(countKey) ?? 0) + 1;
    connectionCounts.set(countKey, attempt);

    startSchedule = () => scheduleTurns(state, scenario, attempt);
  });
}

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mock: "soniox" }));
    return;
  }
  if (req.url === "/reset") {
    connectionCounts.clear();
    res.writeHead(200).end("{}");
    return;
  }
  res.writeHead(404).end();
});

server.on("upgrade", (req, socket) => {
  if (acceptUpgrade(req, socket)) handleConnection(socket);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-soniox] listening on ws://127.0.0.1:${PORT}`);
});
