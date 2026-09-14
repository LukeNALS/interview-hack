import type { Screen, SessionStatus } from "@/types/ui";

/**
 * Máy trạng thái client — Interview Hack chỉ ứng viên: setup → live.
 * URL là nguồn sự thật về màn; state machine chỉ guard hợp lệ theo trạng thái
 * session phía server. Buổi kết thúc (processing/done/failed) không còn màn
 * nào trong luồng session — ra hẳn về `/candidate` (không có report/wait nữa).
 */

export const SCREENS = ["setup", "live"] as const;

/** Màn được phép hiển thị theo trạng thái session phía server — thiếu key = không
 *  còn màn nào trong luồng session (buổi đã kết thúc, xem {@link redirectPath}). */
const STATUS_SCREENS: Partial<Record<SessionStatus, readonly Screen[]>> = {
  prep: ["setup"],
  live: ["live"],
};

export function isScreenAllowed(status: SessionStatus, screen: Screen): boolean {
  return (STATUS_SCREENS[status] ?? []).includes(screen);
}

/**
 * Guard route theo trạng thái session — reload giữa buổi phải rơi về đúng màn.
 * Ném lỗi khi route không hợp lệ; caller bắt và redirect qua {@link redirectPath}.
 */
export function assertScreenAllowed(status: SessionStatus, screen: Screen): void {
  if (!isScreenAllowed(status, screen)) {
    throw new Error(`Màn "${screen}" không hợp lệ với trạng thái buổi "${status}".`);
  }
}

/**
 * Đường redirect đúng khi URL không khớp trạng thái session — 'prep'/'live' còn
 * màn trong luồng (setup/live); mọi trạng thái khác (processing/done/failed =
 * buổi đã kết thúc, không tạo báo cáo nữa) ra hẳn khỏi luồng session về `/candidate`.
 */
export function redirectPath(sessionId: string, status: SessionStatus): string {
  const screens = STATUS_SCREENS[status];
  if (screens && screens.length > 0) return screenPath(sessionId, screens[0]);
  return "/candidate";
}

/** Đường dẫn route của 1 màn trong buổi. */
export function screenPath(sessionId: string, screen: Screen): string {
  return `/sessions/${sessionId}/${screen}`;
}
