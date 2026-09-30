import { describe, expect, test } from "vitest";
import {
  fatalToastMessage,
  giveUpToastMessage,
  isKeyServiceUnavailable,
  KEY_SERVICE_UNAVAILABLE_MESSAGE,
} from "@/hooks/live-session/soniox-error-messages";
import { ApiError } from "@/hooks/use-session";
import { ReconnectStreakExceededError } from "@/hooks/live-session/reconnect-streak-guard";

describe("fatalToastMessage", () => {
  test("test_fatal_toast_session_expired_has_no_toast_but_every_other_kind_does", () => {
    // Arrange + Act + Assert — session_expired: cap countdown tự kết thúc buổi; còn lại PHẢI hiện lỗi
    expect(fatalToastMessage("session_expired")).toBeNull();
    expect(fatalToastMessage("forbidden")).toContain("từ chối quyền truy cập");
    expect(fatalToastMessage("quota")).toContain("hết số dư hoặc ngân sách tháng");
    expect(fatalToastMessage("fatal")).toContain("cấu hình");
  });
});

describe("giveUpToastMessage", () => {
  test("test_give_up_toast_when_session_already_ended_or_capped_shows_no_toast", () => {
    // Arrange — route 403 cap_reached / 409 invalid_session_status: buổi đã kết thúc, "mất kết nối" là sai nghĩa
    // Act + Assert
    expect(giveUpToastMessage("mic", new ApiError("cap_reached"))).toBeNull();
    expect(giveUpToastMessage("mic", new ApiError("invalid_session_status"))).toBeNull();
  });

  test("test_give_up_toast_when_key_service_unavailable_says_so_and_asks_to_reload", () => {
    // Arrange
    const msg = giveUpToastMessage("tab", new ApiError("rate_limit_unavailable"));
    // Assert
    expect(msg).toContain(KEY_SERVICE_UNAVAILABLE_MESSAGE);
    expect(msg).toContain("tải lại trang");
    expect(msg).toContain("(tab)");
  });

  test("test_give_up_toast_when_quick_failure_streak_exceeded_says_connection_keeps_dropping_and_asks_to_reload", () => {
    // Arrange
    const msg = giveUpToastMessage("mic", new ReconnectStreakExceededError());
    // Assert
    expect(msg).toContain("liên tục bị ngắt hoặc từ chối");
    expect(msg).toContain("tải lại trang");
    expect(msg).toContain("(mic)");
  });

  test("test_give_up_toast_when_rate_limit_exceeded_names_the_key_limit", () => {
    expect(giveUpToastMessage("mic", new ApiError("rate_limit_exceeded"))).toContain("Vượt giới hạn xin khoá");
  });

  test("test_give_up_toast_for_unknown_error_falls_back_to_lost_connection_message", () => {
    expect(giveUpToastMessage("mic", new Error("boom"))).toBe(
      "Mất kết nối thu âm (mic) — đã dừng, transcript trước đó vẫn giữ nguyên",
    );
  });
});

describe("isKeyServiceUnavailable", () => {
  test("test_is_key_service_unavailable_only_for_503_and_502_route_codes", () => {
    expect(isKeyServiceUnavailable(new ApiError("rate_limit_unavailable"))).toBe(true);
    expect(isKeyServiceUnavailable(new ApiError("soniox_key_failed"))).toBe(true);
    expect(isKeyServiceUnavailable(new ApiError("rate_limit_exceeded"))).toBe(false);
    expect(isKeyServiceUnavailable(new Error("mic denied"))).toBe(false);
  });
});
