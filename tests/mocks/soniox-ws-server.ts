import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { acceptUpgrade, OPCODE, readFrames, sendClose, sendJson } from "./ws-protocol";
import { DEFAULT_TIMING, FIXTURE_TURNS, REALTIME_TIMING, finalTokens, partialTokens, type TokenTiming } from "./soniox-fixtures";

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
/** Kịch bản `drop`/`drop-mid`: cắt socket sau khi phát xong ngần này lượt. */
const DROP_AFTER_TURNS = 3;
/**
 * `drop-mid`, connection nối lại: app replay audio từ (mốc câu cuối đã emit − 300 ms) nhưng bắt đầu ở ranh giới chunk 100 ms nên mốc 0
 * của connection mới nằm trong [mốc − 300, mốc − 200]. Mock chọn mốc token của lượt bị cắt ở ~340 ms (giữa khoảng đó, mọi sai số
 * lượng tử hoá đều cho kết quả như nhau) và đuôi lượt trước ở 120–250 ms (luôn kết thúc trước mốc đã emit, giữ dung sai của cổng).
 */
const REPLAY_INTERRUPTED_TURN_START_MS = 340;
const REPLAY_TAIL_START_MS = 120;
const REPLAY_TAIL_END_MS = 250;

interface ParsedKey {
  scenario: string;
  runId: string;
}

/** Key dạng `e2e:<scenario>:<runId>[:<nonce>…]` — runId KHÔNG chứa `:`; phần sau là nonce riêng từng key
 *  single-use nên bộ đếm reconnect vẫn gom theo runId. Key khác định dạng ⇒ `basic` + runId `anon`. */
function parseApiKey(apiKey: unknown): ParsedKey {
  if (typeof apiKey !== "string") return { scenario: "basic", runId: "anon" };
  const match = /^e2e:([a-z-]+):([^:]+)(?::.+)?$/.exec(apiKey);
  return match ? { scenario: match[1], runId: match[2] } : { scenario: "basic", runId: "anon" };
}

/** Key single-use như Soniox thật: dùng lại ⇒ `401 Invalid or expired temporary API key` (E1). */
const usedKeys = new Set<string>();
/** Số lần từ chối key đã dùng THEO runId — spec đọc qua `/stats?run=<runId>` để chứng minh app KHÔNG tái dùng key
 *  khi reconnect. Đếm theo runId (không global): spec chạy song song/mock được giữ giữa các lần chạy không được
 *  đọc nhầm số của nhau. */
const reusedKeyRejections = new Map<string, number>();

/** Số connection canonical đã mở cho mỗi runId — kịch bản `drop` chỉ cắt lần ĐẦU. */
const connectionCounts = new Map<string, number>();

interface ConnState {
  socket: Duplex;
  channel: "canonical" | "en";
  timers: NodeJS.Timeout[];
  closed: boolean;
}

/** `drop-mid`, connection nối lại: phiên âm lại ~300 ms cuối của lượt trước (đã emit — app phải bỏ) kèm bản dịch và `<end>`. */
function scheduleReplayedTail(state: ConnState): void {
  const tail = FIXTURE_TURNS[DROP_AFTER_TURNS - 1];
  const speaker = tail.lang === "ja" ? "1" : "2";
  state.timers.push(
    setTimeout(() => {
      if (state.closed) return;
      const translated = state.channel === "canonical" ? tail.counterpart : tail.en;
      sendJson(state.socket, {
        tokens: [
          { text: tail.orig.slice(-4), confidence: 0.9, is_final: true, language: tail.lang, speaker, start_ms: REPLAY_TAIL_START_MS, end_ms: REPLAY_TAIL_END_MS, translation_status: "original" },
          { text: translated.slice(-6), confidence: 0.9, is_final: true, language: tail.lang, speaker, translation_status: "translation" },
          { text: "<end>", confidence: 1, is_final: true },
        ],
        final_audio_proc_ms: 0,
        total_audio_proc_ms: 0,
      });
    }, 150),
  );
}

function scheduleTurns(state: ConnState, scenario: string, attempt: number): void {
  // Lần kết nối đầu của kịch bản drop chỉ phát DROP_AFTER_TURNS lượt rồi cắt;
  // lần kết nối sau (app tự reconnect) phát tiếp phần còn lại.
  const isDropRun = scenario === "drop" && attempt === 1;
  // `drop-mid`: như `drop` nhưng cắt GIỮA lượt tiếp theo (đã có partial, chưa có final) — pair mới phải phiên âm lại trọn lượt đó.
  const isDropMidRun = scenario === "drop-mid" && attempt === 1;
  const isReplayRun = (scenario === "drop" || scenario === "drop-mid") && attempt > 1;
  const startIndex = isReplayRun ? DROP_AFTER_TURNS : 0;
  const endIndex = isDropRun || isDropMidRun ? DROP_AFTER_TURNS : FIXTURE_TURNS.length;
  const timing: TokenTiming =
    scenario !== "drop-mid"
      ? DEFAULT_TIMING
      : { ...REALTIME_TIMING, baseMs: isReplayRun ? DROP_AFTER_TURNS * REALTIME_TIMING.stepMs - REPLAY_INTERRUPTED_TURN_START_MS : 0 };
  if (scenario === "drop-mid" && isReplayRun) scheduleReplayedTail(state);

  for (let i = startIndex; i < endIndex; i += 1) {
    const turn = FIXTURE_TURNS[i];
    const slot = i - startIndex;
    const finalAt = FIRST_TURN_DELAY_MS + (slot + 1) * TURN_INTERVAL_MS;

    state.timers.push(
      setTimeout(() => {
        if (state.closed) return;
        sendJson(state.socket, {
          tokens: partialTokens(turn, i, timing),
          final_audio_proc_ms: 0,
          total_audio_proc_ms: i * 4000,
        });
      }, finalAt - TURN_INTERVAL_MS / 2),
    );

    state.timers.push(
      setTimeout(() => {
        if (state.closed) return;
        sendJson(state.socket, {
          tokens: finalTokens(turn, i, state.channel, timing),
          final_audio_proc_ms: (i + 1) * 4000,
          total_audio_proc_ms: (i + 1) * 4000,
        });
      }, finalAt),
    );
  }

  if (isDropMidRun) {
    // Lượt dở: chỉ partial, final không bao giờ tới trên connection này.
    const interrupted = FIXTURE_TURNS[DROP_AFTER_TURNS];
    const interruptedFinalAt = FIRST_TURN_DELAY_MS + (DROP_AFTER_TURNS + 1) * TURN_INTERVAL_MS;
    state.timers.push(
      setTimeout(() => {
        if (state.closed) return;
        sendJson(state.socket, {
          tokens: partialTokens(interrupted, DROP_AFTER_TURNS, timing),
          final_audio_proc_ms: 0,
          total_audio_proc_ms: DROP_AFTER_TURNS * 4000,
        });
      }, interruptedFinalAt - TURN_INTERVAL_MS / 2),
    );
  }

  if (isDropRun || isDropMidRun) {
    // Cắt phũ (destroy, không close frame) — mô phỏng mất mạng thật để SDK bắn
    // `disconnected` → app hiện banner vàng rồi tự reconnect. `drop-mid` cắt sau partial của lượt dở, trước final của nó.
    const dropAt = FIRST_TURN_DELAY_MS + (DROP_AFTER_TURNS + 1) * TURN_INTERVAL_MS - (isDropMidRun ? 100 : 0);
    state.timers.push(
      setTimeout(() => {
        if (state.closed) return;
        state.closed = true;
        state.socket.destroy();
      }, dropAt),
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
    if (typeof message.api_key === "string") {
      if (usedKeys.has(message.api_key)) {
        const { runId } = parseApiKey(message.api_key);
        reusedKeyRejections.set(runId, (reusedKeyRejections.get(runId) ?? 0) + 1);
        sendJson(socket, { error_code: 401, error_message: "Invalid or expired temporary API key" });
        cleanup();
        sendClose(socket);
        socket.end();
        return;
      }
      usedKeys.add(message.api_key);
    }
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
    usedKeys.clear();
    reusedKeyRejections.clear();
    res.writeHead(200).end("{}");
    return;
  }
  if (req.url?.startsWith("/stats")) {
    const run = new URL(req.url, "http://127.0.0.1").searchParams.get("run") ?? "anon";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ reusedKeyRejections: reusedKeyRejections.get(run) ?? 0 }));
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
