import { describe, expect, test } from "vitest";
import { buildSonioxConfigs } from "@/lib/soniox/config";

describe("buildSonioxConfigs", () => {
  test("test_soniox_config_online_mode_disables_diarization", () => {
    // Arrange + Act
    const { canonical, en } = buildSonioxConfigs("online");
    // Assert — online mode knows speaker from capture source (mic/tab), no diarization
    expect(canonical.enable_speaker_diarization).toBe(false);
    expect(en.enable_speaker_diarization).toBe(false);
  });

  test("test_soniox_config_direct_mode_enables_diarization", () => {
    // Arrange + Act
    const { canonical, en } = buildSonioxConfigs("direct");
    // Assert
    expect(canonical.enable_speaker_diarization).toBe(true);
    expect(en.enable_speaker_diarization).toBe(true);
  });

  test("test_soniox_config_canonical_is_two_way_ja_vi_en_is_one_way_target_en", () => {
    // Arrange + Act
    const { canonical, en } = buildSonioxConfigs("online");
    // Assert — canonical=two_way ja<->vi (authoritative), en=one_way->en (SU T2)
    expect(canonical.translation).toEqual({ type: "two_way", language_a: "ja", language_b: "vi" });
    expect(en.translation).toEqual({ type: "one_way", target_language: "en" });
  });

  test("test_soniox_config_always_enables_endpoint_detection", () => {
    // Arrange + Act — <end> token is the ONLY authoritative utterance boundary (P01)
    const { canonical, en } = buildSonioxConfigs("online");
    // Assert
    expect(canonical.enable_endpoint_detection).toBe(true);
    expect(en.enable_endpoint_detection).toBe(true);
  });
});
