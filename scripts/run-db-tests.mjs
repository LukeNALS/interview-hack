#!/usr/bin/env node
/**
 * `pnpm test:db` — chạy suite DB-backed đối đầu LOCAL Supabase stack.
 *
 * Key local đọc TẠI RUNTIME từ `supabase status -o json`, KHÔNG hardcode vào
 * package.json. Hai lý do:
 *  1. Key demo local tuy là hằng số public (giống nhau trên mọi máy) nhưng vẫn
 *     khớp rule `jwt` của gitleaks → hardcode làm secret-gate đỏ vĩnh viễn, ép
 *     team thêm .gitleaksignore và tập thói quen bỏ qua cảnh báo secret.
 *  2. Stack đổi key (đổi JWT_SECRET, bản CLI mới) thì script vẫn đúng.
 *
 * An toàn: chỉ chấp nhận API URL trỏ localhost/127.0.0.1 — không đời nào lỡ
 * trỏ suite này (nó tạo/xoá session, user) vào project thật.
 */

import { execFileSync, spawnSync } from "node:child_process";

const DB_TEST_FILES = [
  "tests/integration/retention.test.ts",
  "tests/integration/sweeper.test.ts",
  "tests/integration/rls-matrix.test.ts",
  "tests/integration/storage-pagination.test.ts",
  "tests/integration/rpc-grants.test.ts",
  "tests/integration/profile-privileges.test.ts",
];

function fail(message) {
  console.error(`\n❌ test:db — ${message}\n`);
  process.exit(1);
}

let status;
try {
  status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8" }));
} catch {
  fail("không đọc được `supabase status`. Local stack chưa chạy? → `supabase start`");
}

const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = status;
if (!API_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  fail("`supabase status` thiếu API_URL/ANON_KEY/SERVICE_ROLE_KEY — stack chưa lên đủ.");
}

const host = new URL(API_URL).hostname;
if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
  fail(`API_URL trỏ "${host}", không phải localhost. Suite này ghi/xoá dữ liệu — từ chối chạy.`);
}

const result = spawnSync("pnpm", ["exec", "vitest", "run", ...DB_TEST_FILES], {
  stdio: "inherit",
  env: {
    ...process.env,
    SUPABASE_TEST_URL: API_URL,
    SUPABASE_TEST_ANON_KEY: ANON_KEY,
    SUPABASE_TEST_SERVICE_KEY: SERVICE_ROLE_KEY,
  },
});

process.exit(result.status ?? 1);
