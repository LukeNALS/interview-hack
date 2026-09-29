-- 0020 — Realtime Authorization cho kênh `session:{id}` (audit 2026-09-28 #4).
--
-- VÌ SAO: transcript/gợi ý phát trên Broadcast PUBLIC — ai biết UUID phiên cũng subscribe
-- được `session:<uuid>` (nghe lén lời thoại) hoặc gửi event giả lên đó mà client tin. RLS
-- của `utterances` KHÔNG bảo vệ Broadcast. UUID khó đoán không thay kiểm quyền.
--
-- CÁCH: server (broadcast-server.ts) + browser (subscribe-client.ts) cùng chuyển sang
-- private channel (`private: true`). Với private channel, Realtime kiểm RLS trên
-- `realtime.messages`: SELECT = được nhận (join), INSERT = được gửi.
--   - SELECT: CHỈ chủ phiên (sessions.user_id = auth.uid()) nhận broadcast của phiên mình.
--   - INSERT: KHÔNG tạo policy nào ⇒ authenticated/anon KHÔNG gửi được broadcast/presence
--     lên kênh private. Server gửi bằng service_role (bỏ qua RLS) qua REST/fallback.
-- So khớp `id::text` (không cast topic sang uuid) ⇒ topic rác không làm lỗi policy.
--
-- AN TOÀN KHI ÁP TRƯỚC CODE: policy chỉ có hiệu lực với private channel — code hiện tại
-- (public) chạy y nguyên sau migration này. Thứ tự rollout: migration → deploy code private
-- (lúc 0 phiên live) → tắt "Allow public access" ở dashboard Realtime Settings.
-- Rollback: bật lại public access rồi promote deployment public trước đó; policy giữ nguyên.

create policy "session_owner_receives_session_broadcast"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) like 'session:%'
    and exists (
      select 1
      from public.sessions s
      where s.id::text = split_part((select realtime.topic()), ':', 2)
        and s.user_id = (select auth.uid())
    )
  );
