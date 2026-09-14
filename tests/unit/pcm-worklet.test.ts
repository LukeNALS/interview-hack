import { describe, expect, test } from "vitest";
import { downsampleToPcm16 } from "@/lib/audio/pcm-worklet";

describe("downsampleToPcm16", () => {
  test("test_pcm_worklet_downsamples_48k_to_16k_length_matches", () => {
    // Arrange — 100ms of audio at 48kHz Chrome tab-capture rate = 4800 samples;
    // Soniox requires 16kHz -> should produce 1600 samples (100ms at 16kHz).
    const inputSampleRate = 48000;
    const targetSampleRate = 16000;
    const input = new Float32Array(4800);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i / 10);

    // Act
    const output = downsampleToPcm16(input, inputSampleRate, targetSampleRate);

    // Assert
    expect(output.length).toBe(1600);
    expect(output).toBeInstanceOf(Int16Array);
  });

  test("test_pcm_worklet_downsamples_same_rate_skips_resample_keeps_length", () => {
    // Arrange
    const input = new Float32Array(1600).fill(0.25);
    // Act
    const output = downsampleToPcm16(input, 16000, 16000);
    // Assert
    expect(output.length).toBe(1600);
  });

  test("test_pcm_worklet_downsamples_clamps_out_of_range_samples_to_pcm16_bounds", () => {
    // Arrange — out-of-range float samples (should never happen from real mic input, but
    // guards against overflow wraparound).
    const input = new Float32Array([2, -2, 0]);
    // Act
    const output = downsampleToPcm16(input, 16000, 16000);
    // Assert
    expect(output[0]).toBe(32767);
    expect(output[1]).toBe(-32768);
    expect(output[2]).toBe(0);
  });
});
