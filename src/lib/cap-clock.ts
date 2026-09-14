import "server-only";

/**
 * Cap 90' — đồng hồ dùng chung mọi route (SU T5/AC3): serverless không giữ
 * timer nên MỌI check cap đều tính lại từ `elapsed = now - started_at`,
 * KHÔNG lưu state riêng. `now` optional để unit test deterministic.
 */

/** giây trôi qua từ `startedAt` tới `now`; null nếu session chưa có started_at (chưa live). */
export function computeElapsedSeconds(startedAt: string | null, now: Date = new Date()): number | null {
  if (!startedAt) return null;
  const startedMs = new Date(startedAt).getTime();
  if (Number.isNaN(startedMs)) return null;
  return Math.floor((now.getTime() - startedMs) / 1000);
}

/** "mm:ss" hoặc "hh:mm:ss" — hiển thị time trên utterance.final broadcast (P05). */
export function formatElapsedClock(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
