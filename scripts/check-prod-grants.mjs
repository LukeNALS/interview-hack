#!/usr/bin/env node
/**
 * `node scripts/check-prod-grants.mjs` — soi GRANT `anon` của MỌI hàm `public` trên project
 * production, so với allowlist dưới đây. Lệch => exit 1.
 *
 * Vì sao cần: Supabase remote TỰ GRANT cho `anon` khi tạo/replace hàm (ops-runbook §7), nên
 * prod trôi khỏi migration mà không ai biết. Đo 2026-08-21: 4 hàm có `anon=X` mà local không
 * có, trong đó `debit_free_session` cho phép người ẩn danh trừ quota tiền của người khác
 * (nợ N1, vá ở migration 0012).
 *
 * `tests/integration/rpc-grants.test.ts` KHÔNG thay được script này: nó chạy qua `test:db`,
 * mà `test:db` từ chối mọi API URL không phải localhost — tức mù hoàn toàn với prod.
 *
 * CHỈ ĐỌC. Không sửa gì. Cần `SUPABASE_PAT` (Personal Access Token) và `SUPABASE_PROJECT_REF`
 * (ref project prod) trong môi trường.
 */

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;

/** Hàm được phép cho `anon` gọi — mọi hàm khác có `anon=X` là lệch. */
const ANON_ALLOWED = new Set([
  "get_shared_report", // trang chia sẻ công khai /r/[token] (0003:189)
  "handle_new_user", // trigger tạo profile khi đăng ký
]);

if (!PROJECT_REF) {
  console.error("❌ thiếu SUPABASE_PROJECT_REF — export ref project prod rồi chạy lại.");
  process.exit(2);
}

const pat = process.env.SUPABASE_PAT;
if (!pat) {
  console.error("❌ thiếu SUPABASE_PAT — export rồi chạy lại .");
  process.exit(2);
}

const sql = `
  select p.proname as fn, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
   order by 1;
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
});

if (!res.ok) {
  console.error(`❌ Management API trả ${res.status}: ${(await res.text()).slice(0, 200)}`);
  process.exit(2);
}

const rows = await res.json();
const drift = rows.filter((r) => r.anon_exec && !ANON_ALLOWED.has(r.fn));
const missing = [...ANON_ALLOWED].filter((fn) => {
  const row = rows.find((r) => r.fn === fn);
  return row && !row.anon_exec;
});

console.log(`Đã soi ${rows.length} hàm public trên project ${PROJECT_REF}.`);

if (drift.length === 0 && missing.length === 0) {
  console.log("✅ GRANT anon khớp allowlist — không có lệch.");
  process.exit(0);
}

for (const r of drift) {
  console.error(`❌ LỆCH: anon CÓ execute trên "${r.fn}" (không nằm trong allowlist)`);
}
// Chiều ngược cũng là lệch: mất grant của get_shared_report = share link chết.
for (const fn of missing) {
  console.error(`❌ LỆCH: anon MẤT execute trên "${fn}" (allowlist yêu cầu phải có)`);
}
console.error("\n→ Vá bằng migration 0012 (revoke tường minh), rồi chạy lại script này.");
process.exit(1);
