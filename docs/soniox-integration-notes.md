# Soniox Integration Notes (operational facts)

Nguồn: POC 2-connections chạy 2026-08-04 (live Soniox API, mạng VN thật),
fixture audio = synthetic TTS (không phải giọng người thật). Chi tiết đầy đủ:
PoC Soniox nội bộ (không kèm trong repo này).
Đọc report trước khi implement phase-05/07 nếu cần số liệu/context sâu hơn.

## Endpoint & model
- WS: `wss://stt-rt.soniox.com/transcribe-websocket`
- Model: `stt-rt-v5` (fallback `stt-rt-preview` nếu model chính lỗi connect)
- Production dùng SDK `@soniox/client` (`client.realtime.stt()`, low-level),
  KHÔNG tự viết WS client. Lý do: DIY sai 3 lần trong POC (field
  `sample_rate` không phải `sample_rate_hz`; kết thúc stream = text-frame
  rỗng `ws.send("")` không phải binary rỗng; tín hiệu kết thúc là
  `finished:true` không phải `{"type":"finished"}`) — SDK xử lý đúng sẵn.
  Mỗi `RealtimeSttSession` độc lập, tự `api_key`/`translation`; fan-out audio
  thủ công: gọi `sendAudio(chunk)` trên cả 2 session với cùng 1 chunk.

## Temp key (single-use theo connection — đo thật 2026-09-29, thử nghiệm E0–E7)
- Mỗi connection mở bằng 1 temp key SINGLE-USE riêng (POST `/v1/auth/temporary-api-key`,
  `single_use: true`). Dùng lại key ⇒ Soniox trả `401 "Invalid or expired temporary API key"` qua
  event `error` SAU khi `connect()` đã resolve (~230 ms, E1). Mở lỗi cấu hình (400) KHÔNG đốt key (E2).
  Trước đây app dùng 1 key `single_use:false` cho mọi connection (mở được 5 stream đồng thời, E0) nên
  ai trích được key từ DevTools đều mở thêm stream tuỳ ý — cách đó đã bỏ.
- Route cấp 1 CẶP (canonical + en) mỗi request: `expires_in_seconds: 60`, `single_use: true`,
  `max_session_duration_seconds = min(cap − elapsed, 18000)`, `client_reference_id = session id`
  (đối soát chi phí theo phiên qua `GET /v1/usage-logs`). Online: 2 request lúc start (mic, tab);
  direct: 1; mỗi lượt reconnect: 1 cặp MỚI. Client xin key SAU khi user đã cấp quyền mic/chọn tab
  (TTL chỉ 60 s).
- TTL chỉ chặn MỞ stream mới; stream đang chạy sống tiếp qua expiry (E3). Nên KHÔNG còn renew định kỳ:
  stream chạy trên key đã dùng lúc mở, tới `max_session_duration`. Renew cũ đã gỡ vì hết lý do tồn tại và là
  nơi mất câu (E6). ⚠️ Giới hạn bằng chứng: E3 đo stream sống thêm ~40 s sau expiry (TTL 20 s, 461 final); E8S
  (2026-09-29) đo 1 stream 210 s (key TTL 5 s, `max_session_duration` 300): không lỗi, mọi bucket 30 s đều có
  final. Phạm vi chỉ 210 s trên 1 stream (TTL 60 s, cặp 2 connection); CHƯA đo soak ≥ 10 phút hay buổi 90
  phút — nếu Soniox cắt stream định kỳ thì mỗi lần là 1 reconnect (mất câu chưa finalize + 1 lượt tính vào
  60/giờ). Log `[soniox] stream error` / `reconnect bỏ cuộc` là log trình duyệt, không phải log server.
- `max_session_duration_seconds` tính PER STREAM từ lúc connect (đồng hồ chạy từ kết nối, không từ lúc
  có audio). Hết ⇒ server cắt cứng bằng event `error` 403 với `raw.error_type =
  "temp_api_key_session_expired"`, KHÔNG flush câu đang nói dở (E4/E5). Đặt bằng thời gian còn lại của
  cap ⇒ vượt cap tối đa = TTL (key mint lúc T, mở trễ nhất T+60 s, bị cắt lúc T+60 s+còn lại). Phân
  biệt với 403 khác (thiếu quyền) bằng `raw.error_type`, KHÔNG so text `message`.
- SDK 2.3.0 gặp lỗi server (401/403/408/5xx) chỉ bắn `error` rồi `cleanup()` gỡ listener — KHÔNG bắn
  `disconnected`. Controller phân loại `error` (`classifySonioxRealtimeError`): 401/408/5xx/
  ConnectionError và 429 ⇒ reconnect với cặp key mới; 403 hết duration ⇒ dừng luồng đó, không toast;
  403 khác/402/400 ⇒ dừng luồng đó + toast. Theo [Soniox Errors](https://soniox.com/docs/api-reference/errors):
  429 = `limit_exceeded` (requests/phút hoặc concurrency của org/project, thử lại được sau một lúc);
  402 = hết số dư hoặc budget tháng (`organization_balance_exhausted`, `*_monthly_budget_exhausted`, thử lại
  vô ích); 403 = `permission_denied` hoặc `temp_api_key_session_expired`; 401 gồm cả key single-use đã dùng.
  400 có `error_type` `max_concurrent_streams_reached` — CHƯA rõ áp cho STT hay chỉ TTS, hiện vẫn coi 400
  là fatal (hiện lỗi cho user). Sau lỗi, `sendAudio`/`finish` trên session đã chết ném `StateError` nên
  controller chuyển `feed()` sang buffer và `closeAll` dùng `allSettled`.
- Vòng degrade→reconnect được chặn bởi `reconnect-streak-guard`, KHÔNG dựa vào rate limit của route mint:
  degrade < 10 s sau lúc (re)connect xong là "thất bại nhanh"; liên tiếp thì lần 1 reconnect ngay, lần 2 chờ
  1 s, lần 3 chờ 2 s, lần 4 bỏ cuộc (dừng luồng đó + toast "liên tục bị ngắt hoặc từ chối"). Sống ≥ 10 s rồi
  mới rớt thì reset. Lý do: giới hạn 3 lượt của `reconnectWithBackoff` chỉ sống trong một lần gọi, còn lỗi
  đến SAU khi connection mở được (401 ~230 ms sau connect, 429, 5xx) mở vòng mới với bộ đếm về 0.
- Route fail-CLOSED khi rate limit (60 request/giờ/phiên) không kiểm được (lỗi quyền lẫn lỗi hạ tầng):
  503 `rate_limit_unavailable`, không gọi Soniox. Client báo lỗi rõ và reconnect tối đa 3 lượt (chờ 1 s rồi 2 s giữa các lượt; không chờ sau lượt cuối) — cửa sổ ~3 s + thời gian request, nên RPC chớp lâu hơn thế giữa buổi thì luồng đó dừng thu tới khi tải lại trang.

## Thế hệ connection, drain khi kết thúc, replay khi reconnect (plan B — audit #6/#7, 2026-09-30)
- **Thế hệ (`ConnectionGeneration`)**: mỗi lần start/reconnect dựng 1 thế hệ = cặp canonical + en cùng 2 accumulator RIÊNG
  (`connection-generation.ts`). Event của thế hệ đã bị swap ra bị BỎ (handler kiểm `gen === this.current`), pair cũ đóng
  NGAY (không còn overlap 1 s). Trước đây 1 cặp accumulator sống qua mọi swap nên token cũ đến muộn dính vào câu mới.
- **Mốc thời gian segment = đồng hồ audio tuyệt đối** (`epoch_conn + start_ms/end_ms` của token; `epoch_conn` = mốc audio của
  chunk đầu được gửi cho connection đó). Mốc audio của chunk = `captureTs` chunk ĐẦU + tổng độ dài audio đã nhận (byte / 32 ở
  PCM16 mono 16 kHz), KHÔNG phải `captureTs` từng chunk: `captureTs` là lúc chunk tới main thread nên lệch thất thường tới
  ~200 ms, làm epoch của connection đầu buổi và connection replay lệch nhau ⇒ cổng token lọt đuôi câu trước. Controller phát
  `startAbsMs/endAbsMs`; trục phiên = `abs − t0Local` (`absToSessionAxis`).
- **Kết thúc êm (drain)**: bấm Kết thúc ⇒ dừng mọi PCM → `finish()` từng connection song song, tối đa `END_DRAIN_TIMEOUT_MS`
  = 2 s (`Connection.drain()` không ném, không treo) → chốt phần final còn tích luỹ (cả khi hết timeout) → `disposeLivePipeline`
  → flush queue → `POST /end`. Thứ tự **drain → dispose → flush** bắt buộc (xem `security-notes.md` §7). `stop()` vẫn là
  đường đóng NGAY cho unmount/lỗi; `stop({ flushPending: true })` chỉ dùng khi reconnect bỏ cuộc.
- **Replay từ mốc cuối đã emit**: `ReconnectBuffer` LUÔN ghi (RAM, 120 s; xoá khi stop/fatal). Reconnect replay từ
  `min(mốc cuối canonical, en) − 300 ms` (`replay-window.ts`). Trần look-back 30 s tính từ LÚC RỚT (captureTs chunk cuối đã
  gửi cho pair cũ), KHÔNG từ lúc nối lại: audio thu sau lúc rớt (outage dài) chưa từng được phiên âm nên luôn replay hết.
  Mốc cách lúc rớt > 30 s hoặc buffer không phủ tới mốc ⇒ chốt final của pair cũ trước (câu có thể bị tách đôi, phần đã nói
  không mất) rồi kẹp lại. Replay ném lỗi ⇒ pair mới bị đóng, pair cũ giữ nguyên, backoff thử lại.
- **Cổng token thế hệ mới** (chặn phát lần hai phần đã emit): token gốc so ĐIỂM GIỮA với mốc đã emit của loại đó (hai phiên
  Soniox độc lập gán mốc cho cùng từ lệch nhau; so mốc kết thúc thì lọt đuôi từ thành mảnh lặp; điểm giữa chịu lệch tới nửa
  độ dài token). Lớp thứ hai: token FINAL sát sau cổng (≤ 400 ms) mà chữ của nó nằm trong 8 ký tự CUỐI của câu đã emit thì vẫn coi là đuôi đã
  emit (đo trên prod 2026-10-01: đuôi "す。" / " phút." lệch +80..+200 ms và về thành NHIỀU token riêng "す", "。" nên so mốc điểm giữa
  và so khớp "chuỗi chữ là hậu tố của câu" đều không đủ — hậu tố đúng của "ます。" chỉ khớp khi đã có đủ token; luật hậu tố ở bản
  trước đó vì vậy vẫn để lọt đuôi trên prod); chữ khác hoặc trùng chữ ở xa cuối câu ⇒ lời mới, qua. Chỉ xét khi chưa có token gốc
  final nào vượt cổng; token provisional (Soniox gửi lại liên tục) chỉ bị kiểm mốc, không đổi trạng thái cổng. Token dịch không có `start_ms/end_ms` nên
  đi theo trạng thái: bỏ tới khi token gốc final đầu tiên của loại đó vượt cổng.
- ⚠️ Chưa đo: độ lệch mốc thật giữa hai phiên (cần E8 có phí ~$0,035), thời gian xử lý burst replay dài (tối đa 120 s audio),
  soak ≥ 10 phút. Giới hạn đã biết, không đổi ở plan này: `PcmWorkletCapture.stop()` bỏ phần chưa đủ chunk (≤ 100 ms cuối);
  `stop()`/nhánh `stopped` của `reconnect()` vẫn `await finish()` không timeout trước khi `close()`.
- **Direct mode gộp câu (P04)**: số đo offline E6/E7 cho thấy đoạn bị gộp có cùng `spk` nên tách theo người nói không giúp;
  không đổi code, chưa có mẫu giọng thật — xem `plans/20260929-1830-soniox-connection-handoff-drain/reports/direct-endpoint-findings-260930.md`.

## Endpoint detection (`<end>` token) — bắt buộc
Phải bật `enable_endpoint_detection: true` và dùng token `<end>` do Soniox
emit làm boundary cắt utterance chính thức. KHÔNG dùng heuristic tự chế
(đổi speaker/lang/gap im lặng) — heuristic bỏ sót utterance khi 1 người nói
liên tục nhiều câu (verified: không có `<end>` chỉ cắt được 7/16 utterance
vs 16/16 khi dùng `<end>`). Đây là thay đổi kiến trúc quan trọng nhất từ POC.

## Translation `two_way(ja,vi)` gặp tiếng Anh
No-op hoàn toàn: text tiếng Anh vẫn transcribe đúng (`lang:"en"`,
speaker/timestamp đúng) nhưng KHÔNG dịch — `translated: null`. Verified 3/3
run en-only + 2/2 đoạn en xen giữa ja/vi. Không mất dữ liệu, chỉ thiếu bản
dịch cho đoạn tiếng Anh.

## Lỗi `408 request_timeout` khi audio ngừng chảy
Nếu ngừng feed audio cho 1 connection mà KHÔNG đóng nó, server có thể trả
`error_code: 408, error_type: "request_timeout"` và đóng connection. Ngưỡng
chính xác (bao nhiêu giây im lặng) CHƯA xác định (2 phép đo POC mâu thuẫn:
~55s active-rồi-dừng bị lỗi gần như ngay; 5s-feed-rồi-dừng 20s không lỗi).
**Bắt buộc cho phase-05:** không để connection treo khi mic im lặng dài
(suy nghĩ câu trả lời, break). Chọn 1 trong 2:
1. Gửi silence frame (PCM zero) đều đặn để giữ connection sống, hoặc
2. Chủ động đóng + mở lại connection khi phát hiện im lặng > X giây (khớp
   sẵn pattern reconnect với cặp key mới ở mục Temp key) — khuyến nghị, đơn giản hơn.

## Latency (đo từ VN, ja-vi-mixed fixture)
- Partial đầu tiên: P50 = **1256ms**, P95 = 1585ms (n=285) — VƯỢT ngưỡng
  800ms P50, ghi nhận risk, chưa kết luận là vấn đề kiến trúc (chỉ 1 lần đo,
  1 điều kiện mạng).
- Final + bản dịch: P50 = **1334ms**, P95 = 3086ms (n=16) — đạt ngưỡng
  2500ms P50.

## Giới hạn & chi phí
- Giới hạn **10 concurrent session/project**. Online mode (2 luồng tách vai,
  4 connection/buổi): tối đa 2 buổi đồng thời. Direct mode (1 luồng chung,
  2 connection/buổi): tối đa 5 buổi đồng thời. Cần xin nâng limit trước demo
  đông người.
- Chi phí ước tính buổi 90 phút ($0.12/hr/stream): Online (4 conn) =
  **$0.72/buổi**; Direct (2 conn) = **$0.36/buổi**.

## Phase-05 learnings (production code, không phải POC)
- SDK dùng thẳng `new RealtimeSttSession(apiKey, SONIOX_WS_URL, config)`
  (export trực tiếp từ `@soniox/client`), KHÔNG qua `client.realtime.stt()`
  factory — factory cần `SonioxClient` instance + config resolver đồng bộ,
  thêm tầng gián tiếp không cần cho use-case low-level 2-connection.
- Từng có mô hình "1 temp key mở 4 connection đồng thời" với 1 lease dùng chung cho cả 2
  `SonioxStreamController` (mic+tab); mô hình đó đã thay bằng key single-use theo connection (xem mục
  Temp key): mỗi luồng audio một cặp riêng, reconnect 1 luồng xin cặp MỚI cho đúng luồng đó và không
  đụng luồng kia đang chạy.
- Chống `408`: production chọn **phương án 2** (đóng + mở lại connection
  khi rớt, qua `reconnect()`), KHÔNG gửi silence frame giữ sống — xác nhận
  đây là hướng đúng, xem pattern đầy đủ ở
  `docs/live-flow-architecture-phase-05-notes.md`.
- Guard `stopped` bắt buộc kiểm tra SAU `await openAllReady(...)` trong
  `reconnect()` — thiếu guard này gây leak WebSocket thật (đốt quota 10
  concurrent/project) khi `stop()` xảy ra đúng lúc đang mở pair mới. Phát
  hiện qua code review round 2, có test thực nghiệm xác nhận. Cùng chỗ đó còn
  kiểm `conn.error` của pair mới (lỗi server đến trước khi swap thì handler bỏ
  qua vì chưa phải connection hiện tại).

## Phase-07 learnings (2 bug production, phát hiện qua E2E thật)

### 1. SDK KHÔNG bao giờ emit token `<end>` — chốt segment qua event `endpoint`
`@soniox/client` **lọc bỏ** `<end>`/`<fin>` khỏi stream token
(`filterSpecialTokens`, `dist/index.mjs:962`) và bắn `endpoint` thành **event
RIÊNG** (`:973`). Code chờ `token.text === "<end>"` để chốt utterance
**KHÔNG BAO GIỜ chạy** → không utterance nào được lưu, và **im lặng hoàn
toàn** (không exception, không log, WS vẫn khoẻ, partial vẫn hiện trên UI).

Đường chốt đúng ở production: đăng ký `onEndpoint` → gọi `flush()` trực tiếp
(`src/lib/soniox/connection.ts:90` → `src/hooks/use-soniox.ts:173`). Nhánh
`<end>` trong `feed()` chỉ còn giữ cho transport thô (POC/mock).

Mục "Endpoint detection (`<end>` token)" ở trên vẫn đúng về mặt **cấu hình**
(`enable_endpoint_detection: true` bắt buộc) — chỉ sai về **cách nhận tín
hiệu** khi đi qua SDK.

### 2. Phải lọc `is_final === true` trước khi gộp token vào segment
Soniox bắn token provisional (`is_final: false`) rồi **PHÁT LẠI đúng đoạn đó**
trong bản final đầy đủ hơn. Gộp cả hai → transcript **lặp phần đầu câu**.
Dữ liệu thật trong DB:
`"こんにちは、自己紹介をお" + "こんにちは、自己紹介をお願いします"`.
SDK tự làm đúng cách này cho utterance collector của nó
(`final_only: true`, `dist/index.mjs:1568`). Provisional chỉ dùng vẽ bubble mờ,
KHÔNG bao giờ vào segment (`src/hooks/use-soniox.ts:45-63`).

### Vì sao POC không bắt được
Fixture POC cũ chỉ chứa message toàn final (và có token `<end>` thô) → chưa
bao giờ chạm 2 ca này → **test xanh giả** suốt P05-P06. Fixture mới phải có
cặp provisional-rồi-final và KHÔNG có `<end>` trong stream token.
