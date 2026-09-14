# Retention + Quota + Test Hardening — Phase 07 Notes

Nguồn: retention/sweeper (0006), grant fix (0007/0008), hạ tầng test 3 tầng,
fix live UX + quota. User approved 2026-08-17. Đọc trước khi động vào
`supabase/{migrations/0006..0008,functions/purge-expired}`,
`src/hooks/{live-pipeline.ts,use-session.ts}`, `scripts/run-db-tests.mjs`,
`.github/workflows/ci.yml`. Thao tác vận hành (lệnh cụ thể, bật DELETE thật,
giám sát cron) nằm ở `docs/ops-runbook.md` §1-§2 — file này chỉ ghi kiến trúc
+ lý do, KHÔNG lặp lệnh.

## Retention — đường xoá DUY NHẤT

```
cron 'purge-expired' (0 17 * * * UTC = 02:00 JST)
  └─ pg_net http_post  (Authorization đọc Vault `purge-fn-key` LÚC CHẠY)
       └─ Edge Function purge-expired  (service role)
            ├─ pha 1: RPC list_expired_sessions()   [SELECT-only, theo
            │          profiles.retention_days] → storage.remove()
            └─ pha 2: RPC purge_sessions(ids)  ← CHỈ session đã xoá Storage OK
                       → DELETE sessions → cascade bảng con
```

- **SQL/RPC không bao giờ tự DELETE theo lịch.** Quyết định xoá nằm ở Edge
  Function; RPC chỉ là 2 nửa (liệt kê / xoá theo id đã cho). Storage lỗi ở
  session nào thì giữ nguyên row đó, lần chạy sau retry.
- Bearer token KHÔNG hardcode trong cron statement — đọc
  `vault.decrypted_secrets` ngay lúc pg_net chạy → rotate key không cần
  reschedule cron.
- `PURGE_MODE` mặc định `dry_run` (chỉ set `sessions.purge_scheduled_at`),
  giá trị lạ → **fallback `dry_run`** (fail-safe, không fail-open sang delete).
- Verify thật 2026-08-14: `status_code` 200,
  `{"mode":"dry_run","listed":0,"storage_deleted":0,"purged":0,"errors":[]}`.

## Sweeper — session bỏ rơi

`sweep_abandoned_sessions()` chạy `*/15 * * * *`, auto-end session `status='live'`
quá `cap_seconds + 600s` (user đóng tab, không bấm Kết thúc).

- `duration_sec` **ưu tiên `max(utterances.t_end_ms)/1000`**, fallback elapsed.
  Lý do: buổi bỏ rơi lúc phút 3 nhưng sweeper chạy sau 100' — lấy elapsed thì
  `duration_sec` ~6000s → mất quyền hoàn quota. Lấy mốc utterance cuối mới ra
  đúng độ dài buổi thật.
- Hoàn quota nếu `duration_sec < 300` (gọi `refund_free_session` bên trong,
  RPC tự guard double-refund).
- Đã có **4 lần chạy `succeeded` thật trên prod** (`cron.job_run_details`).

## Hạ tầng test 3 tầng (điểm quan trọng nhất của phase)

| Lệnh | Số test | Đối tượng | Phụ thuộc ngoài |
|---|---|---|---|
| `pnpm test` | 421 | unit + integration, mock toàn bộ | không |
| `pnpm test:db` | 24 | LOCAL Supabase stack thật (retention · sweeper · RLS matrix) | `supabase start` |
| `pnpm test:e2e` | 13 | Playwright + mock Soniox WS + mock Claude | local stack + Chromium |

- `test:db` đọc key **tại runtime** từ `supabase status -o json` (không key nào
  trong repo) và **từ chối chạy nếu API URL không phải localhost/127.0.0.1**
  (`scripts/run-db-tests.mjs:42`) — suite này ghi/xoá dữ liệu, không được lỡ
  tay trỏ prod.
- CI dựng DB **thuần từ `supabase/migrations`** (không dùng snapshot dump) —
  chính vì vậy nó bắt được lỗi GRANT mà prod không lộ (xem
  `docs/supabase-vercel-operational-notes.md`). Đừng thay bằng dump.
- E2E mock Soniox + Claude → **không đốt phút Soniox thật**, không gọi
  Anthropic thật. Chạy nightly (`0 18 * * *` UTC), không chặn PR.

**Bài học đắt nhất của phase: 421 test mock xanh mượt vẫn để lọt 7 bug
production** — vì test nào cũng mock đúng ngay ranh giới bị hỏng (SDK Soniox,
router, React Query cache, production build). E2E thật mới lôi ra. Test mock
đo được logic của mình, KHÔNG đo được giả định của mình về hệ thống ngoài.

## Mount kép — bẫy React Query + Next router

Chuỗi thật (BUG #3):

1. `useStartSession.onSuccess` chỉ `invalidateQueries` → cache bị **mark
   stale**, KHÔNG cập nhật ngay.
2. `router.push('/live')` chạy trước khi refetch về.
3. `/live` render lần đầu với cache cũ `status='prep'` → guard
   `replace('/prep')`.
4. Refetch xong → `status='live'` → đá ngược sang `/live`.
5. → **`LiveScreen` mount 2 lần** → 2 pipeline, 2 bộ WS Soniox.

Full page reload KHÔNG dính (QueryClient trống → không có cache cũ để đọc sai)
— nên bug chỉ hiện khi điều hướng SPA, đúng đường user thật đi.

Fix 2 tầng:
- `setQueryData` seed thẳng kết quả `/start` vào cache trước khi push
  (`src/hooks/use-session.ts:104`) — guard thấy `'live'` ngay ở render đầu.
- Vòng đời capture chuyển sang **capture theo SESSION**, không theo instance
  component: registry module-scope `src/hooks/live-pipeline.ts:81`
  (`acquireLivePipeline`/`releaseLivePipeline`, refcount — instance cuối rời
  màn mới đóng pipeline). Mount kép còn tái diễn vì lý do khác vẫn chỉ ra 1
  pipeline.

## Migration 0007/0008 — vì sao tồn tại

`0007` (GRANT bảng + sequence cho `service_role`) và `0008` (GRANT EXECUTE
function) sinh ra do DB dựng thuần từ migration KHÔNG có GRANT ngầm mà project
prod (tạo thời auto-expose legacy) đang có. **Cả 2 no-op trên prod hiện tại**,
nhưng bắt buộc cho CI/local — và bắt buộc cho mọi bảng/function mới sau
2026-10-30. Chi tiết + cột mốc: `docs/supabase-vercel-operational-notes.md`.

`0008` cần vì `sweep_abandoned_sessions()` gọi `refund_free_session()` bên
trong bằng service-role client — thiếu EXECUTE thì sweeper chạy nhưng quota
không hoàn, và **không báo lỗi ở tầng cron**.

## Giới hạn đã biết / còn treo

- **Registry module-scope KHÔNG chặn được 2 TAB.** Mỗi tab = 1 JS context =
  1 registry riêng → 2 tab vẫn mở được 2 pipeline cho cùng session (đốt
  concurrency Soniox 10/project). Điểm chặn đúng là **server**, lúc cấp temp
  key (`POST /soniox-key`): từ chối cấp nếu session đã có lease sống. **Chưa
  làm.**
- `PURGE_MODE` vẫn `dry_run` — chưa có dữ liệu nào bị xoá thật. Quy trình bật
  `delete` ở `docs/ops-runbook.md` §1.
- `listed: 0` ở lần verify nghĩa là **chưa từng có session hết hạn thật đi qua
  nhánh xoá** — pha 1 verified, nhánh `storage.remove()` + `purge_sessions()`
  mới chỉ verified qua `test:db`, chưa qua prod.
- Concurrency guard `step_status='running'` của report job (nêu ở P06) **vẫn
  chưa fix** — 2 tab/double-click vẫn chạy LLM kép.
- Realtime channel `session:{id}` vẫn public (kế thừa P05) — chưa hardening.
