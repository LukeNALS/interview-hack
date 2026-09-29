-- Rollback for 0020_realtime_private_session_channels.sql (manual, not a migration).
-- Only needed if the policy itself must go; code rollback does not require it
-- (the policy has no effect on public channels). Re-enable "Allow public access"
-- in Dashboard → Realtime → Settings BEFORE promoting a public-mode deployment.
begin;
drop policy if exists "session_owner_receives_session_broadcast" on realtime.messages;
commit;
