/**
 * Chỉ chấp nhận path nội bộ ("/...") cho redirect sau auth.
 * Chặn open-redirect: "//evil.com" (protocol-relative), "/\\evil.com"
 * (browser coi \ như /), "@evil.com" (userinfo@host trick khi nối vào origin),
 * và mọi absolute URL.
 */
export function safeInternalPath(raw: string | null, fallback = "/candidate"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return fallback;
  }
  return raw;
}
