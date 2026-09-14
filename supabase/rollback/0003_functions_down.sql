-- 0003_functions_down.sql — rollback 0003_functions.sql

drop function if exists public.bump_rate_limit(text, interval, int);
drop function if exists public.get_shared_report(text);
drop function if exists public.next_utterance_seq(uuid);
drop function if exists public.refund_free_session(uuid);
drop function if exists public.debit_free_session(uuid);
