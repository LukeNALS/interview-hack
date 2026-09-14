import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { RetentionNotice } from "@/components/common/retention-notice";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** ISO của thời điểm cách bây giờ `days` ngày (âm = quá khứ). */
function isoInDays(days: number): string {
  return new Date(Date.now() + days * MS_PER_DAY).toISOString();
}

afterEach(() => {
  // vitest không bật globals → RTL không tự cleanup, phải gọi tay.
  cleanup();
});

test("test_retention_notice_shows_days_left_when_within_seven_day_threshold", () => {
  // Arrange — còn 3 ngày (trong ngưỡng cảnh báo ≤7)
  const expiresAt = isoInDays(3);

  // Act
  render(<RetentionNotice expiresAt={expiresAt} />);

  // Assert
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Còn 3 ngày trước khi buổi này bị xóa tự động theo hạn lưu trữ.",
  );
});

test("test_retention_notice_hidden_when_more_than_seven_days_left", () => {
  // Arrange — còn 30 ngày, chưa tới lúc làm phiền user
  const expiresAt = isoInDays(30);

  // Act
  const { container } = render(<RetentionNotice expiresAt={expiresAt} />);

  // Assert
  expect(container).toBeEmptyDOMElement();
});

test("test_retention_notice_expired_session_shows_overdue_text_not_negative_days", () => {
  // Arrange — quá hạn 3 ngày (daysUntil = -3)
  const expiresAt = isoInDays(-3);

  // Act
  render(<RetentionNotice expiresAt={expiresAt} />);

  // Assert — không được lòi ra "còn -3 ngày"
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(
    "Buổi này đã quá hạn lưu trữ — dữ liệu có thể bị xóa bất cứ lúc nào.",
  );
  expect(alert.textContent).not.toMatch(/-\d/);
});

test("test_retention_notice_hidden_when_expires_at_missing", () => {
  // Arrange + Act — API chưa trả expires_at (session cũ / lỗi fetch)
  const { container } = render(<RetentionNotice expiresAt={null} />);

  // Assert
  expect(container).toBeEmptyDOMElement();
});
