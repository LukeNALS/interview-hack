import { describe, expect, test } from "vitest";
import { startOnlineCapture, TabAudioTrackMissingError } from "@/lib/audio/capture-online";

function fakeTrack(kind: "audio" | "video"): MediaStreamTrack {
  return { kind, stop: () => {} } as unknown as MediaStreamTrack;
}

function fakeStream(tracks: MediaStreamTrack[]): MediaStream {
  const removed = new Set<MediaStreamTrack>();
  return {
    getTracks: () => tracks.filter((t) => !removed.has(t)),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio" && !removed.has(t)),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video" && !removed.has(t)),
    removeTrack: (t: MediaStreamTrack) => removed.add(t),
  } as unknown as MediaStream;
}

describe("startOnlineCapture", () => {
  test("test_capture_online_tab_without_audio_track_throws_typed_error", async () => {
    // Arrange — tab shared WITHOUT "Chia sẻ âm thanh của thẻ" enabled (no audio track)
    const mic = fakeStream([fakeTrack("audio")]);
    const tabNoAudio = fakeStream([fakeTrack("video")]);

    // Act + Assert
    await expect(
      startOnlineCapture({
        getUserMedia: async () => mic,
        getDisplayMedia: async () => tabNoAudio,
      }),
    ).rejects.toThrow(TabAudioTrackMissingError);
  });

  test("test_capture_online_drops_video_track_from_tab_stream_on_success", async () => {
    // Arrange
    const mic = fakeStream([fakeTrack("audio")]);
    const videoTrack = fakeTrack("video");
    const audioTrack = fakeTrack("audio");
    const tab = fakeStream([videoTrack, audioTrack]);

    // Act
    const result = await startOnlineCapture({
      getUserMedia: async () => mic,
      getDisplayMedia: async () => tab,
    });

    // Assert — video track removed, audio track kept
    expect(result.tab.getVideoTracks()).toHaveLength(0);
    expect(result.tab.getAudioTracks()).toHaveLength(1);
    expect(result.mic).toBe(mic);
  });
});
