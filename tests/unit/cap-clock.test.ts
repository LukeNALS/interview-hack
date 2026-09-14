import { describe, expect, test, vi } from "vitest";

// cap-clock.ts có `import "server-only"` — mock rỗng để import được dưới vitest (P05).
vi.mock("server-only", () => ({}));

const { computeElapsedSeconds, formatElapsedClock } = await import("@/lib/cap-clock");

describe("computeElapsedSeconds", () => {
  test("test_cap_clock_computes_elapsed_seconds_from_started_at", () => {
    // Arrange
    const startedAt = "2026-08-12T00:00:00.000Z";
    const now = new Date("2026-08-12T00:05:00.000Z");
    // Act
    const elapsed = computeElapsedSeconds(startedAt, now);
    // Assert
    expect(elapsed).toBe(300);
  });

  test("test_cap_clock_returns_null_when_started_at_missing", () => {
    // Arrange + Act
    const elapsed = computeElapsedSeconds(null);
    // Assert
    expect(elapsed).toBeNull();
  });

  test("test_cap_clock_returns_null_when_started_at_not_parseable", () => {
    // Arrange + Act
    const elapsed = computeElapsedSeconds("không phải ngày giờ");
    // Assert
    expect(elapsed).toBeNull();
  });
});

describe("formatElapsedClock", () => {
  test("test_cap_clock_format_elapsed_clock_formats_mm_ss_under_one_hour", () => {
    // Arrange
    const ms = (4 * 60 + 15) * 1000;
    // Act
    const formatted = formatElapsedClock(ms);
    // Assert
    expect(formatted).toBe("04:15");
  });

  test("test_cap_clock_format_elapsed_clock_formats_hh_mm_ss_over_one_hour", () => {
    // Arrange
    const ms = (2 * 3600 + 3 * 60 + 9) * 1000;
    // Act
    const formatted = formatElapsedClock(ms);
    // Assert
    expect(formatted).toBe("02:03:09");
  });

  test("test_cap_clock_format_elapsed_clock_clamps_negative_to_zero", () => {
    // Arrange + Act
    const formatted = formatElapsedClock(-500);
    // Assert
    expect(formatted).toBe("00:00");
  });
});
