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

## Temp key
- 1 temp key (POST `/v1/auth/temporary-api-key`) mở được NHIỀU connection
  đồng thời (verified 6/6 lần) — không cần cấp N key lúc start phiên.
- TTL tối đa `expires_in_seconds: 3600` (60 phút). Buổi phỏng vấn 90 phút >
  TTL → BẮT BUỘC renew ít nhất 1 lần/phiên (không tùy chọn).
- Pattern renew: mở key + connection MỚI trước khi key cũ hết hạn (~5-10s
  lead time), chạy chồng lấn, rồi chủ động đóng connection cũ ngay (đừng để
  treo — xem mục 408 bên dưới). Gap audio đo được khi renew: **724ms**
  (dưới ngưỡng <1s).
- `max_session_duration_seconds`: hiệu lực thật của tham số này CHƯA xác
  định được (confound bởi lỗi 408) — xem Unresolved trong report.

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
   sẵn pattern renew-key ở trên) — khuyến nghị, đơn giản hơn.

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
- 1 temp key mở **4 connection đồng thời** (mic canonical+en, tab
  canonical+en) xác nhận lại trong code thật (không chỉ POC) —
  `TempKeyClient` dùng CHUNG 1 lease cho cả 2 `SonioxStreamController`
  (mic+tab); reconnect khi 1 luồng rớt dùng lại lease hiện có, KHÔNG ép
  renew toàn cục (tránh ảnh hưởng luồng kia đang chạy bình thường).
- Chống `408`: production chọn **phương án 2** (đóng + mở lại connection
  khi rớt, qua `reconnect()`), KHÔNG gửi silence frame giữ sống — xác nhận
  đây là hướng đúng, xem pattern đầy đủ ở
  `docs/live-flow-architecture-phase-05-notes.md`.
- Guard `stopped` bắt buộc kiểm tra SAU `await openAllReady(...)` ở cả
  `reconnect()`/`renew()` — thiếu guard này gây leak WebSocket thật (đốt
  quota 10 concurrent/project) khi `stop()` xảy ra đúng lúc đang mở pair
  mới. Phát hiện qua code review round 2, có test thực nghiệm xác nhận.

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
