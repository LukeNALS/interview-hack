// purge-expired — Edge Function DUY NHẤT được phép xoá dữ liệu khách quá hạn
// lưu trữ (retention_days của profiles). Gọi bởi cron "purge-expired" (migration
// 0006_retention_cron.sql, 17:00 UTC = 02:00 JST hàng ngày) qua pg_net, có thể
// trigger thủ công bằng curl (xem README/report phase-07).
//
// Auth: chỉ chấp nhận Bearer token == SUPABASE_SERVICE_ROLE_KEY (service_role
// thật của project — cùng giá trị được seed vào Vault dưới tên "purge-fn-key",
// xem migration 0006). Không phải giá trị này → 401, không làm gì thêm.
//
// PURGE_MODE (secret, mặc định "dry_run" nếu không set):
// - "dry_run": liệt kê session hết hạn (list_expired_sessions RPC), CHỈ đánh dấu
//   sessions.purge_scheduled_at = now() — KHÔNG xoá Storage, KHÔNG xoá DB row.
//   Đây là mitigation cho risk "xoá nhầm data khách" — giai đoạn đầu vận hành an toàn,
//   xem lại purge_scheduled_at trước khi chuyển "delete".
// - "delete": pha 1 xoá Storage object theo session (storage_paths dạng
//   "<bucket>:<path>", bucket ∈ {cv, exports} — xem contract trong migration 0006);
//   lỗi Storage ở session nào → GIỮ nguyên session đó (không purge), retry ở lần
//   chạy sau. Pha 2 gọi purge_sessions(ids) CHỈ với id đã xoá Storage thành công.
//
// Response JSON: {mode, listed, storage_deleted, purged, errors}
// - listed: số session trả về từ list_expired_sessions.
// - storage_deleted: số session đã xoá Storage THÀNH CÔNG (0 nếu dry_run, hoặc
//   session không có file nào — coi là "sạch" ngay).
// - purged: số session đã bị xoá cứng khỏi DB (0 nếu dry_run).
// - errors: mảng {session_id, message} — lỗi Storage/purge không chặn các session khác.
//
// Không log nội dung PII — chỉ log số lượng + session id.

import { createClient } from "npm:@supabase/supabase-js@2";

interface ExpiredSessionRow {
  session_id: string;
  storage_paths: string[] | null;
}

interface PurgeError {
  session_id: string;
  message: string;
}

interface PurgeSummary {
  mode: string;
  listed: number;
  storage_deleted: number;
  purged: number;
  errors: PurgeError[];
}

function parseStorageEntry(entry: string): { bucket: "cv" | "exports"; path: string } | null {
  const idx = entry.indexOf(":");
  if (idx === -1) return null;
  const bucket = entry.slice(0, idx);
  const path = entry.slice(idx + 1);
  if ((bucket !== "cv" && bucket !== "exports") || path.length === 0) return null;
  return { bucket, path };
}

Deno.serve(async (req: Request) => {
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authHeader = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${serviceRoleKey ?? ""}`;

  if (!serviceRoleKey || authHeader !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const mode = Deno.env.get("PURGE_MODE") ?? "dry_run";
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const summary: PurgeSummary = { mode, listed: 0, storage_deleted: 0, purged: 0, errors: [] };

  const { data: rows, error: listError } = await admin.rpc("list_expired_sessions");
  if (listError) {
    console.error("[purge-expired] list_expired_sessions lỗi", { message: listError.message });
    return new Response(JSON.stringify({ ...summary, errors: [{ session_id: "*", message: listError.message }] }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const expired = (rows ?? []) as ExpiredSessionRow[];
  summary.listed = expired.length;

  if (expired.length === 0) {
    return new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (mode === "dry_run") {
    const ids = expired.map((r) => r.session_id);
    const { error: updateError } = await admin
      .from("sessions")
      .update({ purge_scheduled_at: new Date().toISOString() })
      .in("id", ids);
    if (updateError) {
      console.error("[purge-expired] dry_run đánh dấu purge_scheduled_at lỗi", { message: updateError.message });
      summary.errors.push({ session_id: "*", message: updateError.message });
    }
    console.log("[purge-expired] dry_run hoàn tất", { listed: summary.listed });
    return new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (mode !== "delete") {
    // Giá trị PURGE_MODE lạ → coi như dry_run để an toàn, không xoá gì.
    console.error("[purge-expired] PURGE_MODE không hợp lệ, fallback dry_run", { mode });
    return new Response(JSON.stringify({ ...summary, mode: `${mode} (fallback dry_run — không xoá gì)` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Pha 1 — xoá Storage object theo từng session, session nào lỗi thì giữ nguyên (retry sau).
  const purgeableIds: string[] = [];
  for (const row of expired) {
    const entries = (row.storage_paths ?? []).map(parseStorageEntry).filter((e): e is { bucket: "cv" | "exports"; path: string } => e !== null);
    const byBucket = new Map<"cv" | "exports", string[]>();
    for (const e of entries) {
      byBucket.set(e.bucket, [...(byBucket.get(e.bucket) ?? []), e.path]);
    }

    let storageOk = true;
    for (const [bucket, paths] of byBucket) {
      const { error: removeError } = await admin.storage.from(bucket).remove(paths);
      if (removeError) {
        storageOk = false;
        summary.errors.push({ session_id: row.session_id, message: `storage[${bucket}]: ${removeError.message}` });
        console.error("[purge-expired] xoá storage lỗi", { sessionId: row.session_id, bucket, message: removeError.message });
      }
    }

    if (storageOk) {
      summary.storage_deleted += 1;
      purgeableIds.push(row.session_id);
    }
  }

  // Pha 2 — purge_sessions CHỈ với session đã xoá Storage OK.
  if (purgeableIds.length > 0) {
    const { error: purgeError } = await admin.rpc("purge_sessions", { p_ids: purgeableIds });
    if (purgeError) {
      console.error("[purge-expired] purge_sessions lỗi", { count: purgeableIds.length, message: purgeError.message });
      summary.errors.push({ session_id: "*", message: `purge_sessions: ${purgeError.message}` });
    } else {
      summary.purged = purgeableIds.length;
    }
  }

  console.log("[purge-expired] delete hoàn tất", { listed: summary.listed, storage_deleted: summary.storage_deleted, purged: summary.purged, errorCount: summary.errors.length });
  return new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } });
});
