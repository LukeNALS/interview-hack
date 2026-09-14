-- 0009_storage_orphan_cleanup.sql — nhận diện object Storage MỒ CÔI (không còn
-- session nào sở hữu) cho job dọn hằng tuần `/api/cron/storage-orphans`.
--
-- Contract (đọc kỹ trước khi wave sau đụng vào):
-- - list_orphan_storage_objects(p_older_than, p_limit): SELECT-only, KHÔNG xoá gì.
--   Trả (bucket_id, object_name); `object_name` là path ĐẦY ĐỦ trong bucket
--   (`<userId>/<sessionId>/<file>`) nên truyền thẳng vào storage.remove() được.
-- - XOÁ Ở ĐÂU: KHÔNG bao giờ xoá bằng SQL. `storage.objects` có trigger
--   BEFORE DELETE `protect_objects_delete`, và kể cả xoá được row thì file thật
--   trên storage backend vẫn nằm đó — đường xoá DUY NHẤT là Storage API, gọi từ
--   route Next.js bằng service-role (src/app/api/cron/storage-orphans/route.ts).
-- - VÌ SAO CẦN: DELETE /api/sessions/:id lẫn Edge Function purge-expired đều xoá
--   Storage TRƯỚC rồi mới xoá row. Bất kỳ lỗi nào ở giữa — hoặc bug phân trang
--   `.list()` (H4, vá cùng phase) — là file mất chủ VĨNH VIỄN, vì mọi đường dọn
--   khác (list_expired_sessions, purge_sessions) đều join từ `sessions` mà row
--   đó đã biến mất. Hàm này quét thẳng storage.objects nên không phụ thuộc
--   `sessions` — lưới an toàn cuối cho AC6 (APPI).
-- - p_older_than là LƯỚI CHỐNG RACE với upload đang diễn ra: /cv upload file lên
--   Storage rồi mới update sessions.cv_file_path, và session có thể vừa được tạo
--   ở tab khác. Object mới toanh KHÔNG chắc là mồ côi. Mặc định 24h; cron chạy
--   hằng tuần nên ngưỡng này rộng rãi thoải mái.
-- - SO SÁNH BẰNG TEXT (`s.id::text = o.path_tokens[2]`) — TUYỆT ĐỐI KHÔNG cast
--   `path_tokens[2]::uuid`: chỉ cần một path rác không phải uuid là CẢ query
--   raise 22P02 ⇒ job chết vĩnh viễn vì đúng loại rác mà nó sinh ra để dọn.
-- - `storage.objects.created_at` NULLABLE — `null < now() - interval` cho NULL
--   nên object thiếu created_at KHÔNG bao giờ bị liệt kê. Cố ý: thà sót còn hơn xoá nhầm.

create or replace function public.list_orphan_storage_objects(
  p_older_than interval default '24 hours',
  p_limit int default 1000
)
returns table(bucket_id text, object_name text)
language sql
security definer
set search_path = public
stable
as $$
  select o.bucket_id, o.name as object_name
  from storage.objects o
  where o.bucket_id in ('cv', 'exports')
    -- Layout hợp lệ là `<userId>/<sessionId>/<file>`; path ngắn hơn không suy ra
    -- được session nào nên không kết luận được là mồ côi -> bỏ qua.
    and array_length(o.path_tokens, 1) >= 3
    and o.created_at < now() - p_older_than
    and not exists (
      select 1 from public.sessions s where s.id::text = o.path_tokens[2]
    )
  order by o.created_at
  limit p_limit;
$$;

revoke all on function public.list_orphan_storage_objects(interval, int) from public;
revoke all on function public.list_orphan_storage_objects(interval, int) from anon;
revoke all on function public.list_orphan_storage_objects(interval, int) from authenticated;
grant execute on function public.list_orphan_storage_objects(interval, int) to service_role;
