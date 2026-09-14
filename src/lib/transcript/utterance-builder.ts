/**
 * §Architecture "Trục thời gian utterance (session axis)" — normalizes Soniox's
 * per-connection-relative timestamps onto a session-wide axis using ONLY client clocks
 * (`t0_local`, `epoch_conn`). NEVER mixes in a server clock (`recording_started_at`) —
 * that's the whole point of this module being pure/DI'd: FE wave supplies `t0LocalMs`
 * (persisted across reload, see fix B14) and `epochConnMs` (per-connection, see
 * `src/lib/soniox/connection.ts` normal case, or `epochConnForReplay` in
 * `src/lib/soniox/reconnect.ts` for the post-outage replay case, fix B13).
 */

export type StreamLabel = "mic" | "tab" | "mixed";

export interface NormalizeTimestampInput {
  /** Soniox token start/end, ms relative to the CURRENT connection's own audio feed. */
  tSonioxStartMs: number;
  tSonioxEndMs: number;
  /** Client Date.now() when the current connection's first PCM chunk was fed (normal
   *  case), OR capture_ts of the first replayed chunk after a reconnect (fix B13). */
  epochConnMs: number;
  /** Client Date.now() captured at the `/start` response — session axis zero point. */
  t0LocalMs: number;
}

export interface NormalizedTimestamp {
  t_start_ms: number;
  t_end_ms: number;
}

/** t_session = epoch_conn + t_soniox - t0_local — see module docblock. */
export function normalizeToSessionAxis(input: NormalizeTimestampInput): NormalizedTimestamp {
  const { tSonioxStartMs, tSonioxEndMs, epochConnMs, t0LocalMs } = input;
  return {
    t_start_ms: epochConnMs + tSonioxStartMs - t0LocalMs,
    t_end_ms: epochConnMs + tSonioxEndMs - t0LocalMs,
  };
}

/**
 * client_utt_id = `${stream}:${t_start_session_ms}` — uses the SESSION-axis start (not
 * the raw Soniox-local start_ms, which resets to ~0 after every reconnect/renew) so ids
 * stay unique across the whole 90-minute session.
 */
export function buildClientUtteranceId(stream: StreamLabel, tStartSessionMs: number): string {
  return `${stream}:${tStartSessionMs}`;
}

export interface BuildUtteranceInput {
  stream: StreamLabel;
  speaker: string | null;
  lang: string | null;
  textOrig: string;
  translations: { vi: string | null; ja: string | null };
  tSonioxStartMs: number;
  tSonioxEndMs: number;
  epochConnMs: number;
  t0LocalMs: number;
  questionId: string | null;
}

export interface BuiltUtterance {
  client_utt_id: string;
  speaker: string | null;
  lang: string | null;
  text_orig: string;
  translations: { vi: string | null; ja: string | null };
  t_start_ms: number;
  t_end_ms: number;
  question_id: string | null;
}

/** Turns one canonical-connection final token/result into a session-axis utterance
 *  ready to hand to `align.ts`. Partial tokens are NOT built here — caller only invokes
 *  this on `is_final`/`<end>` boundaries (§Architecture, endpoint detection). */
export function buildUtterance(input: BuildUtteranceInput): BuiltUtterance {
  const { t_start_ms, t_end_ms } = normalizeToSessionAxis(input);
  return {
    client_utt_id: buildClientUtteranceId(input.stream, t_start_ms),
    speaker: input.speaker,
    lang: input.lang,
    text_orig: input.textOrig,
    translations: input.translations,
    t_start_ms,
    t_end_ms,
    question_id: input.questionId,
  };
}
