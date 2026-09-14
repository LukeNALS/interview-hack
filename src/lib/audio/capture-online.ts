/**
 * Online mode capture: mic = interviewer, tab audio = candidate — role is known from the
 * capture SOURCE, so no diarization needed (§Key Insight 3). Browser API touches only
 * happen here (development-rules "Browser API chỉ chạm ở capture-*.ts/pcm-worklet.ts");
 * `getUserMedia`/`getDisplayMedia` are injectable (DI) so this is testable without a
 * real browser if needed.
 */

export class TabAudioTrackMissingError extends Error {
  constructor() {
    super(
      "Không tìm thấy audio track trong tab được chia sẻ — vui lòng chọn lại tab và bật \"Chia sẻ âm thanh của thẻ\".",
    );
    this.name = "TabAudioTrackMissingError";
  }
}

export interface OnlineCaptureStreams {
  /** Interviewer's own microphone. */
  mic: MediaStream;
  /** Candidate's tab audio — video track already dropped. */
  tab: MediaStream;
}

export interface OnlineCaptureDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  getDisplayMedia?: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
}

/** Starts both online-mode streams. Throws `TabAudioTrackMissingError` (typed, so the UI
 *  can show a specific "pick the tab again + enable tab audio share" prompt, SU R3) when
 *  the shared tab has no audio track — releases any already-acquired tracks first. */
export async function startOnlineCapture(deps: OnlineCaptureDeps = {}): Promise<OnlineCaptureStreams> {
  const getUserMedia = deps.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c));
  const getDisplayMedia = deps.getDisplayMedia ?? ((c) => navigator.mediaDevices.getDisplayMedia(c));

  const mic = await getUserMedia({ audio: true });
  const tab = await getDisplayMedia({ video: true, audio: true });

  if (tab.getAudioTracks().length === 0) {
    for (const track of tab.getTracks()) track.stop();
    for (const track of mic.getTracks()) track.stop();
    throw new TabAudioTrackMissingError();
  }

  for (const track of tab.getVideoTracks()) {
    track.stop();
    tab.removeTrack(track);
  }

  return { mic, tab };
}

/** Stops both streams' tracks — call on stopCapture()/unmount. */
export function stopOnlineCapture(streams: OnlineCaptureStreams): void {
  for (const track of streams.mic.getTracks()) track.stop();
  for (const track of streams.tab.getTracks()) track.stop();
}
