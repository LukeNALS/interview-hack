import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright E2E trỏ vào 127.0.0.1 (không phải localhost) nên Next dev coi là
  // cross-origin và CHẶN /_next/hmr + dev resource -> client JS không hydrate đủ,
  // spec cần transcript realtime sẽ flaky. Chỉ ảnh hưởng `next dev`, không đụng prod.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
