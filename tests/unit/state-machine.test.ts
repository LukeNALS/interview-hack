import { expect, test } from "vitest";
import {
  assertScreenAllowed,
  isScreenAllowed,
  redirectPath,
  screenPath,
} from "@/lib/state-machine";

test("test_state_machine_status_prep_allows_setup_only", () => {
  // Arrange
  const status = "prep" as const;

  // Act + Assert
  expect(isScreenAllowed(status, "setup")).toBe(true);
  expect(isScreenAllowed(status, "live")).toBe(false);
});

test("test_state_machine_status_live_allows_live_only", () => {
  expect(isScreenAllowed("live", "live")).toBe(true);
  expect(isScreenAllowed("live", "setup")).toBe(false);
});

test("test_state_machine_status_done_allows_no_screen", () => {
  // Buổi đã kết thúc (processing/done/failed) — không còn màn nào trong luồng session.
  expect(isScreenAllowed("done", "setup")).toBe(false);
  expect(isScreenAllowed("done", "live")).toBe(false);
});

test("test_state_machine_assert_screen_allowed_passes_for_valid_pair", () => {
  expect(() => assertScreenAllowed("live", "live")).not.toThrow();
});

test("test_state_machine_assert_screen_allowed_throws_for_invalid_pair", () => {
  expect(() => assertScreenAllowed("live", "setup")).toThrow();
  expect(() => assertScreenAllowed("done", "live")).toThrow();
});

test("test_state_machine_redirect_path_prep_goes_to_setup", () => {
  expect(redirectPath("abc-123", "prep")).toBe("/sessions/abc-123/setup");
});

test("test_state_machine_redirect_path_live_stays_on_live", () => {
  expect(redirectPath("abc-123", "live")).toBe("/sessions/abc-123/live");
});

test("test_state_machine_redirect_path_ended_statuses_go_to_candidate", () => {
  // Buổi kết thúc (processing/done/failed) không còn report/wait — ra thẳng /candidate.
  expect(redirectPath("abc-123", "processing")).toBe("/candidate");
  expect(redirectPath("abc-123", "done")).toBe("/candidate");
  expect(redirectPath("abc-123", "failed")).toBe("/candidate");
});

test("test_screen_path_builds_session_route", () => {
  expect(screenPath("abc-123", "live")).toBe("/sessions/abc-123/live");
  expect(screenPath("abc-123", "setup")).toBe("/sessions/abc-123/setup");
});
