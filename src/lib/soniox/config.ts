import type { SttSessionConfig } from "@soniox/client";

/**
 * Soniox realtime config — decisions locked in P01/POC (see
 * `docs/soniox-integration-notes.md` + `plans/.../poc/poc-soniox-report.md`):
 * model `stt-rt-v5`, PCM16 16kHz mono, `enable_endpoint_detection` (the `<end>` token is
 * the ONLY utterance boundary — no speaker/lang/gap heuristic, POC showed heuristics miss
 * 9/16 utterances), diarization only in direct mode.
 */

export const SONIOX_MODEL = "stt-rt-v5";
export const SONIOX_SAMPLE_RATE_HZ = 16000;
export const SONIOX_LANGUAGE_HINTS = ["vi", "ja", "en"] as const;

export type SonioxCaptureMode = "online" | "direct";

export interface SonioxModeConfigs {
  /** two_way ja<->vi — canonical: decides utterance boundaries/speaker/text_orig. */
  canonical: SttSessionConfig;
  /** one_way->en — contributes only the `en` translation field. */
  en: SttSessionConfig;
}

function baseConfig(mode: SonioxCaptureMode): Omit<SttSessionConfig, "translation"> {
  return {
    model: SONIOX_MODEL,
    audio_format: "pcm_s16le",
    sample_rate: SONIOX_SAMPLE_RATE_HZ,
    num_channels: 1,
    language_hints: [...SONIOX_LANGUAGE_HINTS],
    enable_language_identification: true,
    enable_endpoint_detection: true,
    // Diarization only in direct mode — online mode already knows the speaker from the
    // capture source (mic=interviewer, tab=candidate), see §Key Insight 3.
    enable_speaker_diarization: mode === "direct",
  };
}

/** Builds the pair of SttSessionConfig used for one audio stream (mic or tab). */
export function buildSonioxConfigs(mode: SonioxCaptureMode): SonioxModeConfigs {
  const base = baseConfig(mode);
  return {
    canonical: { ...base, translation: { type: "two_way", language_a: "ja", language_b: "vi" } },
    en: { ...base, translation: { type: "one_way", target_language: "en" } },
  };
}
