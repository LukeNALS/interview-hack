#!/usr/bin/env node
/**
 * check:secrets — gate secret cho CI + pre-push (phase-07, SU AC9).
 *
 * Quét FILE ĐANG TRACKED bởi git (không quét working tree bẩn / node_modules)
 * tìm credential thật, và xác nhận `init docs/` — nơi chứa key thật — không bị
 * commit cũng không lọt vào bundle deploy.
 *
 * Cố ý KHÔNG trùng vai với gitleaks ở hook pre-push của team-ai-pack: hook đó
 * chạy trên máy dev, script này chạy trong CI (nơi không có pack) và bắt thêm
 * 2 rule riêng của dự án (init docs/ tracked, init docs/ thiếu trong .vercelignore).
 *
 * Exit 0 = sạch, exit 1 = phát hiện vấn đề (in file:line, KHÔNG in giá trị key).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Key ngẫu nhiên thật — mỗi pattern kèm nhãn để báo lỗi cho người đọc hiểu ngay. */
const SECRET_PATTERNS = [
  { label: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: "Supabase personal access token", re: /\bsbp_[a-f0-9]{40}\b/ },
  { label: "OpenAI API key", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { label: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Private key block", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

/** JWT 3 phần — service-role key của Supabase là JWT, cần soi payload mới biết nguy hiểm hay không. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

/** File tự nói về secret (doc/script này) — cho phép chứa TÊN pattern, không phải giá trị. */
const SELF_REFERENTIAL = new Set(["scripts/check-secrets.mjs", "docs/security-notes.md", "docs/ops-runbook.md"]);

/**
 * JWT của LOCAL supabase stack (`supabase start`) có `iss: "supabase-demo"` —
 * chuỗi tĩnh, giống hệt trên mọi máy, public trong docs Supabase. Không phải
 * secret → cho qua, nếu không script sẽ chặn chính script test local.
 */
function isLocalDemoJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return payload.iss === "supabase-demo";
  } catch {
    return false;
  }
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

const problems = [];

// ===== Rule 1+2: quét nội dung file tracked =====
const trackedFiles = git(["ls-files"]).split("\n").filter(Boolean);

for (const file of trackedFiles) {
  if (SELF_REFERENTIAL.has(file)) continue;

  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue; // binary / file đã xoá khỏi đĩa
  }
  if (content.includes("\0")) continue; // binary

  const lines = content.split("\n");

  lines.forEach((line, idx) => {
    for (const { label, re } of SECRET_PATTERNS) {
      if (re.test(line)) problems.push(`${file}:${idx + 1} — ${label}`);
    }

    for (const token of line.match(JWT_RE) ?? []) {
      if (isLocalDemoJwt(token)) continue;
      problems.push(`${file}:${idx + 1} — JWT nghi là Supabase service-role/anon key thật`);
    }
  });
}

// ===== Rule 3: `init docs/` (chứa key thật) không được tracked =====
const trackedInitDocs = trackedFiles.filter((f) => f.startsWith("init docs/"));
for (const file of trackedInitDocs) {
  problems.push(`${file} — "init docs/" chứa key thật, KHÔNG được commit (phải nằm trong .gitignore)`);
}

// ===== Rule 4: `init docs/` phải bị loại khỏi bundle deploy =====
try {
  const vercelIgnore = readFileSync(".vercelignore", "utf8");
  if (!/^init docs\/?$/m.test(vercelIgnore)) {
    problems.push(`.vercelignore — thiếu dòng "init docs/" → key thật sẽ được upload lên Vercel`);
  }
} catch {
  problems.push(`.vercelignore — không tồn tại → "init docs/" sẽ được upload lên Vercel`);
}

// ===== Kết luận =====
if (problems.length > 0) {
  console.error(`\n❌ check:secrets — phát hiện ${problems.length} vấn đề:\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error(`\nKhông in giá trị key ra log. Mở đúng file:line ở trên để xử lý.\n`);
  process.exit(1);
}

console.log(`✅ check:secrets — sạch (${trackedFiles.length} file tracked đã quét).`);
