-- 0010_share_rpc_column_allowlist.sql — M14: RPC share chỉ trả ĐÚNG cột UI render.
--
-- VÌ SAO (code review P07, M14): 0003_functions.sql:138,140 dùng `to_jsonb(r.*)` /
-- `to_jsonb(u.*)` nên MỌI cột của `reports`/`utterances` đi vào payload. Trang
-- `/r/[token]` là `"use client"` → props serialize vào flight payload, người ẩn danh
-- **view-source đọc được** cột UI không hề render: `reports.edited_by_user` (lộ việc
-- interviewer đã sửa tay report), `utterances.client_utt_id`, `question_id`,
-- `session_id`, `en_pending`, `created_at`. Nhánh `session` (:130-137) đã whitelist
-- đúng từ đầu → đây là sót lẻ, không phải quyết định thiết kế.
--
-- Contract (wave sau đụng vào phải đọc):
-- - Tập cột dưới đây PHẢI khớp `ReportRenderFields` + `ApiReportUtterance`
--   (src/hooks/use-report.ts). Thêm cột vào UI ⇒ thêm ở ĐÂY, không có đường tắt.
-- - `translations` GIỮ nguyên cả 3 ngôn ngữ: trang share có toggle vi/ja/en chạy
--   hoàn toàn client-side (SharedReportView), cắt bớt là gãy toggle chứ không phải
--   siết bảo mật — nội dung 3 bản dịch cùng mức nhạy cảm với `text_orig` vốn đã hiện.
-- - `utterances.id` BẮT BUỘC có: `buildSeqLookup` map `evidence.utterance_id` → `seq`
--   để nút "nhảy tới transcript" hoạt động. Bỏ id là gãy toàn bộ evidence jump.
-- - Nhánh `report` phải trả NULL (không phải object toàn null) khi session chưa có
--   report — `src/app/r/[token]/page.tsx` phân biệt bằng `if (!payload.report)` để
--   hiện "Báo cáo đang được tạo". `jsonb_build_object` trên left-join rỗng sẽ sinh
--   object có key với value null ⇒ truthy ở JS ⇒ render report rỗng. Do đó bọc
--   `case when r.id is null then null else ... end`.

create or replace function public.get_shared_report(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_result jsonb;
begin
  select id into v_session_id from public.sessions where share_token = p_token;
  if v_session_id is null then
    raise exception 'share link không hợp lệ' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'session', jsonb_build_object(
      'id', s.id,
      'candidate_name', s.candidate_name,
      'position', s.position,
      'started_at', s.started_at,
      'ended_at', s.ended_at,
      'duration_sec', s.duration_sec
    ),
    'report', case
      when r.id is null then null
      else jsonb_build_object(
        'scorecard', r.scorecard,
        'strengths', r.strengths,
        'cautions', r.cautions,
        'evidence', r.evidence
      )
    end,
    'utterances', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', u.id,
          'seq', u.seq,
          'speaker', u.speaker,
          'lang', u.lang,
          'text_orig', u.text_orig,
          'translations', u.translations,
          't_start_ms', u.t_start_ms
        )
        order by u.seq
      )
      from public.utterances u where u.session_id = s.id
    ), '[]'::jsonb)
  )
  into v_result
  from public.sessions s
  left join public.reports r on r.session_id = s.id
  where s.id = v_session_id;

  return v_result;
end;
$$;

-- Re-grant tường minh: `create or replace` giữ nguyên privilege, nhưng 0007/0008
-- tồn tại chính vì grant từng bị mất im lặng — rà lại theo runbook §7, rẻ và vô hại.
revoke all on function public.get_shared_report(text) from public;
grant execute on function public.get_shared_report(text) to anon, authenticated;
