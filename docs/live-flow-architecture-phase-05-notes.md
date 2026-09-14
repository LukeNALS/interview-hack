# Live Flow Architecture — Phase 05 Notes

Nguồn: BE (5 route + broadcast, p05-be), client lib audio/soniox/transcript (p05-client,
49 test), FE wiring hooks live (p05-fe). Code review 2 vòng — round 1: 1 CRITICAL (reconnect
build ở lib nhưng KHÔNG wire) + 4 MAJOR, đã fix; round 2: 1 MAJOR mới (NEW-1, leak race), đã
fix → **APPROVED**. User approved 2026-08-12. Đọc trước khi động vào
`src/lib/{audio,soniox,transcript}/`, `src/hooks/use-{live-session,soniox,backfill,
cap-countdown,connection-banner}.ts`, hoặc route `start`/`soniox-key`/`utterances`/
`questions/select`.

## Kiến trúc luồng

1. **Capture**: `startOnlineCapture`/`startDirectCapture` (mic+tab hoặc mic đơn) →
   `PcmWorkletCapture` (`worklet-processor.js` gom Float32 ~100ms ở native sample rate, KHÔNG
   resample) → `downsampleToPcm16` chạy main thread (16kHz PCM16, test thuần vì jsdom không có
   `AudioWorkletGlobalScope`).
2. **Fan-out 2 connection**: mỗi luồng audio (mic/tab) → 1 `SonioxStreamController` giữ **2**
   `SonioxConnection` (canonical `two_way ja↔vi`, en `one_way→en`), cùng 1 chunk feed cả 2 qua
   `fanOutChunk`. `enable_endpoint_detection:true` bắt buộc cả 2 (xem
   `docs/soniox-integration-notes.md`).
3. **Token→segment**: `TokenSegmentAccumulator` (sống trong `use-soniox.ts`, KHÔNG có ở lib
   Wave A — `align.ts` chỉ nhận input đã gộp) gộp token thô tới `<end>` → `CanonicalSegment`/
   `EnSegment` (raw Soniox-ms).
4. **Align**: `AlignBuffer` (1 instance/luồng) ghép canonical+en theo **IoU≥0.5**
   (`computeIou`), `enWaitMs=1200` chờ bản dịch en tới muộn → `onEmit(utterance, isUpdate)`.
   `isUpdate` hiện bị FE bỏ qua (MINOR #11, không phải bug — TS contravariance cho phép).
5. **utterance-builder**: `normalizeToSessionAxis` = `epoch_conn + t_soniox - t0_local` —
   **trục session thuần client**, KHÔNG bao giờ dùng đồng hồ server. Xem mục Trục thời gian.
6. **ingest-queue**: `IngestQueue` debounce 300ms, batch ≤5, POST `/utterances`, backoff
   exponential cho lỗi mạng, dừng hẳn khi 409 `session_ended`.
   **Cập nhật WAVE A (2026-08-18):** retry 429 nay có TRẦN (`maxRetryAttempts`, default 6 ≈ 61s)
   và queue có `dispose()` — `disposeLivePipeline` gọi nó nên queue không còn chạy nền suốt
   vòng đời SPA sau khi rời màn live. `dispose()` CỐ Ý không khoá `flushNow()` (xem `endInterview()`
   dispose TRƯỚC rồi mới flush); sau dispose là best-effort 1 lượt/batch. Chi tiết +
   3 tính chất phải giữ cùng lúc: `security-notes.md` §7 (WAVE A / CRITICAL-1).
7. **API → DB → Realtime**: insert/update idempotent theo `client_utt_id` → broadcast
   `utterance.final` qua channel `session:{id}` → mọi client (kể cả người vừa POST) nhận qua
   `subscribe-client.ts`, không có short-circuit local — 1 nguồn sự thật duy nhất.

## API contract (tóm tắt — chi tiết đủ trong `phase-05-be-report.md`)

- `GET /api/sessions/:id` — 200 full session row (rộng hơn `ApiSession` cũ; FE đã tự mở rộng
  type ở P05, không còn unresolved).
- `POST /api/sessions/:id/start` — 200 `{started_at, cap_seconds}`. 409
  `invalid_session_status`/`no_free_sessions`/`session_already_started`.
- `POST /api/sessions/:id/soniox-key` (`requireEmailConfirmed`) — 200 `{keys:[key],
  expires_at}` **LUÔN 1 phần tử** dù là mảng — caller PHẢI `keys[0]`. 403 `cap_reached`
  (elapsed≥cap_seconds), 429 (60/giờ/session), 502 `soniox_key_failed`.
- `POST /api/sessions/:id/utterances` (batch 1-5, ≤8KB/item) — 200
  `{results:[{client_utt_id,seq}]}`. Idempotent theo `(session_id, client_utt_id)`: trùng →
  **overwrite toàn bộ** `translations`/`en_pending` (KHÔNG deep-merge, client phải gửi lại
  full mong muốn). 409 `session_ended` (session không `live` HOẶC elapsed>cap_seconds — case
  cap tự set `status='processing', ended_reason='cap'`). 429 2 cửa sổ lồng nhau (60/phút +
  20/10s/session).
- `GET /api/sessions/:id/utterances?after_seq=N` — backfill, ≤500/lần, `next_after_seq:null`
  = hết.
- `POST /api/sessions/:id/questions/select` — response trả trực tiếp `question` (active) +
  `previous` (done/pending) — FE dùng response này ngay, **KHÔNG đợi broadcast**.

### Broadcast payload (channel `session:{id}`, public — xem Operational)

- `utterance.final`: bắn mỗi lần insert HOẶC update (en bù sau). `time` = tính từ `t_start_ms`
  **client gửi**, không phải elapsed server — field optional ở schema, thiếu → mặc định 0 →
  hiển thị "00:00".
- `question.status`: **CHỈ bắn khi previous → `'done'`**. KHÔNG bắn `'pending'`/`'active'` —
  contract `QuestionEventStatus` (P02) chỉ có `"done"|"weak"`. FE lấy 2 trạng thái kia trực
  tiếp từ response POST `/questions/select`.

## Trục thời gian (t0_local / epoch_conn / capture_ts / clock_offset)

- `t0_local` — mốc đồng hồ client lúc bắt đầu capture; sau reload được phục dựng qua
  `clock_offset` persist trong `localStorage` (key theo `session_id`, ghi NGAY sau `/start` =
  `t0_local - started_at_server`) — **fix B14**.
- `epoch_conn` — set ở LẦN FEED ĐẦU TIÊN của mỗi `SonioxConnection`, cố định tới khi
  reconnect/renew swap connection mới.
- `capture_ts` — `Date.now()` lúc audio chunk được capture (client); khi replay sau reconnect,
  `epoch_conn` connection mới = `capture_ts` của **chunk đầu tiên** trong `ReconnectBuffer` —
  **fix B13** (`epochConnForReplay`).
- Công thức duy nhất toàn hệ thống: `epoch_conn + t_soniox - t0_local`. Server KHÔNG tự tính
  lại bằng đồng hồ mình ở bất kỳ layer nào (kể cả cap-check dùng `computeElapsedSeconds`, đó
  là layer khác — enforce cap, không phải trục hiển thị).

## Pattern reconnect / renew Soniox WS

- `SonioxStreamController.stop()` set `this.stopped = true` **trước** khi đóng connection —
  mọi guard khác dựa vào cờ này.
- `reconnect()`/`renew()` đều: mở pair mới → `await openAllReady(...)` → **guard
  `if (this.stopped)`** → nếu true, `closeAll([newCanonical, newEn])` rồi return ngay, KHÔNG
  swap/KHÔNG `onRestored()`. Guard này fix leak race NEW-1 (round 2): nếu `stop()` xảy ra
  đúng lúc `reconnect()`/`renew()` đang `await` mở pair mới, pair mới đó không còn ai giữ
  reference để đóng — leak WebSocket, đốt quota 10 concurrent/project. Xem `use-soniox.ts`
  (`reconnect()`/`renew()`) cho code thật + comment tại chỗ.
- `reconnect()` chỉ `drain()` `ReconnectBuffer` **sau** khi pair mới ready (không phải trước —
  bug thứ cấp round 1 đã fix, tránh mất chunk feed trong lúc await).
- `handleDisconnected` có guard 2 lớp: `stopped` (chặn đóng chủ động tự trigger reconnect) +
  `conn !== this.canonical && conn !== this.en` (chặn disconnect trễ từ connection đã bị swap
  ra bởi renew/reconnect trước đó).
- Retry: `reconnectWithBackoff` (`use-live-session.ts`) tối đa **3 lần**, backoff 1s/2s/4s, hết
  lượt → `onGiveUp` dừng capture luồng đó + toast, banner giữ nguyên degraded (không tự phục
  hồi).
- Renew theo lịch TTL−120s (lease dùng chung mic+tab qua `TempKeyClient`), overlap 1s trước
  khi đóng pair cũ (`swapConnections` dùng `setTimeout(1000)`).
- **KHÔNG để connection treo khi mic im lặng dài** (dẫn tới `408 request_timeout`, xem
  `soniox-integration-notes.md`) — MVP chọn phương án 2 (đóng+mở lại qua reconnect khi rớt),
  KHÔNG gửi silence frame giữ sống.
- Quan sát chưa fix (không blocking): `renew()`/`reconnect()` có thể race NHAU (không phải với
  `stop()`) nếu trigger trùng lúc — chưa có mutex, tần suất cực hiếm, để ticket P07 chung với
  smoke-test SDK thật.
- **WAVE A (2026-08-18) — N2:** chuỗi renew đi qua `renewKeyWithRetry`
  (`src/lib/soniox/renew-with-retry.ts`): retry trần 4 lượt, backoff 2/4/8s, banner vàng khi
  trục trặc → xanh khi hồi → banner+toast khi bỏ cuộc. Lượt renew kế tiếp CHỈ được hẹn khi
  lượt hiện tại thật sự xong. Trước đó `renew()` gọi trần trong `void (async…)()` không catch,
  ném 1 lần là chuỗi dừng CÂM (key hết hạn → stream tắt giữa buổi, không banner nào).

## Quy ước test liên quan

- Test đặt tên `test_<hệ_thống>_<tình_huống>_<kết_quả>` (theo `test-standards.md`), ví dụ
  `test_soniox_stream_controller_stop_during_reconnect_await_closes_new_pair_without_swap`.
- `SonioxConnection`/`SonioxStreamController` nhận `sessionFactory?` DI — test luôn inject
  fake session factory (`SonioxSessionLike`), KHÔNG mở WebSocket thật, mặc định `undefined`
  nên không đổi hành vi prod.
- Logic phức tạp trong hook orchestrator được tách ra hàm pure top-level để test độc lập
  không cần mount toàn bộ hook: `resolveT0LocalMs`, `resyncAfterReconnect`, `handleSeqGap`,
  `closeAllStreamsOnce`, `flushIngestQueueBeforeEnd`, `reconnectWithBackoff` — đều nằm trong
  `use-live-session.ts`, xuất riêng cho test.
- Race/leak (`stop()` giữa lúc `reconnect()`/`renew()` await) verify bằng test thực nghiệm
  (gate `connect()` treo thủ công rồi resolve trễ) — không phải suy đoán từ đọc code, xem
  `tests/unit/use-soniox.test.ts`.

## Operational

- **Migration `0004` + `0005` CHƯA apply remote** — dán nguyên nội dung 2 file
  (`supabase/migrations/0004_cv_fields.sql`, `0005_live_fields.sql`) vào Supabase Dashboard
  SQL Editor (không chạy `psql`/MCP theo đúng lý do đã ghi ở `backend-llm-cv-architecture-
  phase-04-notes.md`). `0005` chỉ thêm 1 cột `sessions.cap_seconds` — các phần khác (enum,
  unique, index) đã có sẵn từ `0001_init.sql`, KHÔNG lặp lại.
- **Smoke test Soniox thật bắt buộc trước demo** — toàn bộ 20+ test reconnect/renew/stop dùng
  fake session factory, CHƯA verify timing thật với SDK. Kịch bản bắt buộc: chủ động ngắt
  mạng/rớt Soniox WS giữa buổi (không chỉ happy-path), xác nhận banner vàng→xanh + transcript
  không mất đoạn.
- **Realtime channel `session:{id}` public** — không `private:true`, không RLS Authorization
  cho `realtime.messages`. UUID khó đoán là lớp bảo vệ duy nhất hiện tại. Hardening (RLS +
  `private:true` cả `broadcast-server.ts` lẫn `subscribe-client.ts`) dời sang **P07** — nội
  dung là transcript phỏng vấn thật (PII), cân nhắc ưu tiên sớm hơn nếu có user thật trước P07.
- **`POST /api/sessions/:id/end` đã implement ở P06** (idempotent, hoàn quota nếu
  `duration_sec<300`, tạo `report_jobs(step=0)` marker) — xem
  `docs/report-pdf-share-architecture-phase-06-notes.md`. `endInterview()` (mọi đường: nút
  "Kết thúc", cap 90' auto-stop, 409 `session_ended`) try/catch quanh `/end`, luôn navigate
  `/wait` bất kể lỗi — luồng cap 90' không bao giờ kẹt.
- File-size deviation chấp nhận cho merge: `use-live-session.ts` 528 dòng, `use-soniox.ts` 217
  dòng (vượt rule 200 dòng/file) — do ràng buộc ownership Wave song song, không phải kiến
  trúc. Ticket fast-follow: tách `use-live-capture.ts` + `use-live-realtime.ts` khỏi
  `use-live-session.ts`.
- MINOR deferred (chấp nhận cho MVP, không block): race insert `client_utt_id` trùng giữa 2
  request → 500 tạm (tự phục hồi ở retry sau); `align.ts`'s `unmatchedEn` không cap/evict;
  `ingest-queue` không có dead-letter cho lỗi 400 vĩnh viễn.
