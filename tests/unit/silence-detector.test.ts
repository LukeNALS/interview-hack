import { describe, expect, test } from "vitest";
import { SilenceDetector } from "@/lib/audio/silence-detector";

describe("SilenceDetector", () => {
  test("test_silence_detector_no_signal_for_six_seconds_raises_silent_banner", () => {
    // Arrange
    let bannerRaised = false;
    const detector = new SilenceDetector({ onSilentBanner: () => (bannerRaised = true) });

    // Act — feed near-zero RMS samples spanning a 6s window (default threshold)
    detector.sample(0, 0);
    detector.sample(0, 3000);
    detector.sample(0, 5999);
    expect(bannerRaised).toBe(false); // not yet 6000ms of sustained silence

    detector.sample(0, 6000);

    // Assert
    expect(bannerRaised).toBe(true);
  });

  test("test_silence_detector_signal_within_six_seconds_does_not_raise_banner", () => {
    // Arrange
    let bannerRaised = false;
    const detector = new SilenceDetector({ onSilentBanner: () => (bannerRaised = true) });

    // Act — a real signal sample resets the silence clock before 6s elapses
    detector.sample(0, 0);
    detector.sample(0, 3000);
    detector.sample(0.5, 4000);
    detector.sample(0, 9500); // only 5.5s since the reset at 4000

    // Assert
    expect(bannerRaised).toBe(false);
  });

  test("test_silence_detector_signal_restored_after_banner_calls_restore_callback_once", () => {
    // Arrange
    let bannerCount = 0;
    let restoredCount = 0;
    const detector = new SilenceDetector({
      onSilentBanner: () => bannerCount++,
      onSignalRestored: () => restoredCount++,
    });

    // Act
    detector.sample(0, 0);
    detector.sample(0, 6000); // banner raised
    detector.sample(0.5, 6100); // signal restored
    detector.sample(0.5, 6200); // still has signal — restore callback must not repeat

    // Assert
    expect(bannerCount).toBe(1);
    expect(restoredCount).toBe(1);
  });
});
