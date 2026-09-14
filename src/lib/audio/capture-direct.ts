/**
 * Direct mode capture: single mic stream shared by both interviewer and candidate
 * (in-person interview) — speaker role comes from Soniox diarization instead of the
 * capture source (§Key Insight 3). `echoCancellation`/`noiseSuppression` help since both
 * voices come through the same mic, unlike online mode's isolated mic/tab streams.
 */

export interface DirectCaptureDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}

export async function startDirectCapture(deps: DirectCaptureDeps = {}): Promise<MediaStream> {
  const getUserMedia = deps.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c));
  return getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
}

/** Stops the stream's tracks — call on stopCapture()/unmount. */
export function stopDirectCapture(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
