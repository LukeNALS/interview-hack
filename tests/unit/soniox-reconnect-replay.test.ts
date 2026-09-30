import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RealtimeToken } from "@soniox/client";
import { SonioxStreamController, type CanonicalSegment, type EnSegment } from "@/hooks/use-soniox";
import { makeGatedSessionFactory, openImmediately, pairKeys, type GatedFactoryOptions } from "../helpers/gated-soniox-session-factory";

/**
 * Reconnect phiên âm lại từ MỐC CUỐI đã emit (không chỉ từ lúc rớt): pair cũ bị bỏ cùng câu chưa chốt của nó, pair mới
 * nhận lại audio từ (mốc − 300 ms), token đã emit bị cổng loại. Thời gian chạy trên đồng hồ capture giả; mỗi chunk mang
 * mã `ts/100` trong 2 byte đầu để đọc lại được chunk nào đã được gửi sang pair mới.
 */

const STEP = 100;
const T0 = 1_000_000;
let now = T0;

/** 1 chunk = 100 ms PCM16 mono 16 kHz (3200 byte) — controller tính đồng hồ audio theo độ dài byte; 2 byte đầu mã hoá ts. */
const CHUNK_BYTES = 3200;
const chunkAt = (ts: number): ArrayBuffer => {
  const v = Math.floor(ts / STEP);
  const bytes = new Uint8Array(CHUNK_BYTES);
  bytes[0] = v % 256;
  bytes[1] = Math.floor(v / 256);
  return bytes.buffer;
};
const tsOf = (bytes: Uint8Array): number => (bytes[0] + bytes[1] * 256) * STEP;

function token(text: string, startMs: number, endMs: number, extra: Partial<RealtimeToken> = {}): RealtimeToken {
  return { text, is_final: true, start_ms: startMs, end_ms: endMs, ...extra } as RealtimeToken;
}

/** Token dịch thật của Soniox KHÔNG mang `start_ms`/`end_ms` (fixture `canonical-ja-vi-final.json`). */
function bareTranslation(text: string): RealtimeToken {
  return { text, is_final: true, translation_status: "translation" } as RealtimeToken;
}

function setup(options: GatedFactoryOptions = {}) {
  const { factory, instances } = makeGatedSessionFactory(options);
  const canonical: CanonicalSegment[] = [];
  const en: EnSegment[] = [];
  const controller = new SonioxStreamController({
    mode: "online",
    label: "mic",
    sessionFactory: factory,
    handlers: { onCanonicalFinal: (s) => canonical.push(s), onEnFinal: (s) => en.push(s) },
  });
  const feedRange = (fromTs: number, toTs: number) => {
    for (let ts = fromTs; ts <= toTs; ts += STEP) {
      now = ts;
      controller.feed(chunkAt(ts), ts);
    }
  };
  /** Chốt 1 segment canonical + 1 segment en kết thúc ở `relEndMs` trên pair hiện có `idx` (0/1 = pair đầu). */
  const emitSegments = (canonicalIdx: number, text: string, relStartMs: number, relEndMs: number) => {
    instances[canonicalIdx].handlers["token"]?.(token(text, relStartMs, relEndMs));
    instances[canonicalIdx].handlers["endpoint"]?.();
    instances[canonicalIdx + 1].handlers["token"]?.(token(`src ${text}`, relStartMs, relEndMs));
    instances[canonicalIdx + 1].handlers["token"]?.(token(`en ${text}`, relStartMs, relEndMs, { translation_status: "translation" }));
    instances[canonicalIdx + 1].handlers["endpoint"]?.();
  };
  const reconnect = async (prefix: string, firstIdx: number) => {
    const reconnecting = controller.reconnect(pairKeys(prefix));
    instances[firstIdx].resolveConnect();
    instances[firstIdx + 1].resolveConnect();
    await reconnecting;
  };
  return { controller, instances, canonical, en, feedRange, emitSegments, reconnect };
}

beforeEach(() => {
  now = T0;
  vi.useFakeTimers();
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SonioxStreamController — reconnect replay từ mốc cuối đã emit", () => {
  test("test_soniox_controller_reconnect_replays_audio_from_last_emitted_boundary_minus_margin", async () => {
    // Arrange — câu đầu kết thúc ở abs 1_004_000 (cả canonical lẫn en); rớt lúc ~1_010_000
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    s.feedRange(T0, T0 + 10_000);
    s.emitSegments(0, "câu một", 3000, 4000);
    s.instances[0].handlers["disconnected"]?.();
    s.feedRange(T0 + 10_100, T0 + 12_000); // audio tới trong lúc degraded

    // Act
    await s.reconnect("k2", 2);

    // Assert — replay từ chunk 1_003_700 (= mốc 1_004_000 − 300 ms), tới hết buffer (84 chunk), đúng thứ tự
    const replayed = s.instances[2].sentChunks.map(tsOf);
    expect(replayed[0]).toBe(1_003_700);
    expect(replayed).toHaveLength(84);
    expect(replayed).toEqual([...replayed].sort((a, b) => a - b));
    expect(s.instances[3].sentChunks.map(tsOf)).toEqual(replayed);
  });

  test("test_soniox_controller_reconnect_utterance_straddling_drop_is_emitted_once_and_complete", async () => {
    // Arrange — chưa emit gì; câu "Xin chào các bạn" nói giữa lúc rớt, pair cũ chỉ kịp có nửa đầu (final, chưa endpoint)
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    s.feedRange(T0, T0 + 5_500);
    s.instances[0].handlers["token"]?.(token("Xin chào", 4000, 5000));
    s.instances[0].handlers["disconnected"]?.();
    s.feedRange(T0 + 5_600, T0 + 6_500);

    // Act — pair mới phiên âm lại từ đầu buffer (chưa có mốc): cả câu, rồi endpoint; endpoint muộn của pair cũ bị bỏ
    await s.reconnect("k2", 2);
    s.instances[2].handlers["token"]?.(token("Xin chào", 4000, 5000));
    s.instances[2].handlers["token"]?.(token(" các bạn", 5000, 6000));
    s.instances[2].handlers["endpoint"]?.();
    s.instances[0].handlers["endpoint"]?.();

    // Assert — đúng 1 segment, đủ câu, mốc tuyệt đối theo epoch của chunk đầu được replay (T0)
    expect(s.canonical).toHaveLength(1);
    expect(s.canonical[0]).toMatchObject({ textOrig: "Xin chào các bạn", startAbsMs: T0 + 4000, endAbsMs: T0 + 6000 });
  });

  test("test_soniox_controller_new_generation_drops_tokens_already_emitted_before_the_drop", async () => {
    // Arrange — câu một đã emit (kết thúc abs 1_004_000); pair mới replay từ 1_003_700 nên phiên âm lại đuôi câu một
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    s.feedRange(T0, T0 + 10_000);
    s.emitSegments(0, "câu một", 3000, 4000);
    s.instances[0].handlers["disconnected"]?.();
    s.feedRange(T0 + 10_100, T0 + 12_000);
    await s.reconnect("k2", 2); // epoch pair mới = 1_003_700

    // Act — token trùng (abs end 1_004_000 ≤ cổng) rồi token mới (abs 1_004_100..1_004_600)
    s.instances[2].handlers["token"]?.(token("đuôi câu một", 0, 300));
    s.instances[2].handlers["token"]?.(token("câu hai", 400, 900));
    s.instances[2].handlers["endpoint"]?.();

    // Assert — câu một chỉ phát 1 lần (trước khi rớt); segment mới chỉ chứa phần sau cổng
    expect(s.canonical.map((x) => x.textOrig)).toEqual(["câu một", "câu hai"]);
    expect(s.canonical[1]).toMatchObject({ startAbsMs: 1_004_100, endAbsMs: 1_004_600 });
  });

  test("test_soniox_controller_reconnect_when_last_boundary_is_older_than_30s_flushes_old_finals_and_replays_from_new_boundary", async () => {
    // Arrange — câu ngắn ở đầu buổi (abs 1_000_500), rồi nói liền ~60 s không endpoint: mốc cũ quá 30 s
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    s.feedRange(T0, T0 + 60_000);
    s.emitSegments(0, "sớm", 0, 500);
    s.instances[0].handlers["token"]?.(token("phần nói rất dài", 1000, 59_000));
    s.instances[1].handlers["token"]?.(token("src dài", 1000, 59_000));
    s.instances[1].handlers["token"]?.(token("en dài", 1000, 59_000, { translation_status: "translation" }));
    s.instances[0].handlers["disconnected"]?.();
    s.feedRange(T0 + 60_100, T0 + 60_500);

    // Act
    await s.reconnect("k2", 2);

    // Assert — final của pair cũ được chốt thành segment (không mất câu), replay ngắn từ mốc mới (1_059_000 − 300), không phải 60 s
    expect(s.canonical.map((x) => x.textOrig)).toEqual(["sớm", "phần nói rất dài"]);
    expect(s.en.map((x) => x.textEn)).toEqual(["en sớm", "en dài"]);
    const replayed = s.instances[2].sentChunks.map(tsOf);
    expect(replayed[0]).toBe(1_058_700);
    expect(replayed).toHaveLength(19);
  });

  test("test_soniox_controller_reconnect_after_flush_clamps_replay_to_30s_when_en_never_emitted", async () => {
    // Arrange — nói liền 60 s; canonical có final nhưng en chưa từng emit ⇒ sau khi chốt vẫn chưa có mốc chung
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    s.feedRange(T0, T0 + 60_000);
    s.instances[0].handlers["token"]?.(token("phần nói rất dài", 1000, 59_000));
    s.instances[0].handlers["disconnected"]?.();
    s.feedRange(T0 + 60_100, T0 + 60_500);

    // Act
    await s.reconnect("k2", 2);

    // Assert — replay tối đa 30 s TRƯỚC LÚC RỚT (1_030_000..1_060_000) + mọi audio tới sau đó (..1_060_500), không phải cả 60 s
    const replayed = s.instances[2].sentChunks.map(tsOf);
    expect(s.canonical.map((x) => x.textOrig)).toEqual(["phần nói rất dài"]);
    expect(replayed[0]).toBe(1_030_000);
    expect(replayed).toHaveLength(306);
  });

  test("test_soniox_controller_reconnect_closes_old_generation_immediately_and_ignores_its_late_events", async () => {
    // Arrange
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    s.feedRange(T0, T0 + 2_000);
    s.instances[0].handlers["disconnected"]?.();

    // Act
    await s.reconnect("k2", 2);
    s.instances[0].handlers["token"]?.(token("muộn", 0, 500));
    s.instances[0].handlers["token"]?.(token("<end>", 500, 500)); // transport thô (POC/mock) chốt câu bằng token <end>
    s.instances[0].handlers["endpoint"]?.();

    // Assert — đóng ngay (không còn overlap 1 s) và event muộn không sinh segment
    expect(s.instances[0].closed).toBe(true);
    expect(s.instances[1].closed).toBe(true);
    expect(s.canonical).toEqual([]);
  });

  test("test_soniox_controller_reconnect_after_45s_outage_replays_all_audio_captured_after_the_drop", async () => {
    // Arrange — mốc cuối 1_004_000, rớt lúc 1_010_000, mất 40 s mới nối lại (xin key + retry): audio 1_010_100..1_050_000 nằm trong buffer
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    s.feedRange(T0, T0 + 10_000);
    s.emitSegments(0, "câu một", 3000, 4000);
    s.instances[0].handlers["disconnected"]?.();
    s.feedRange(T0 + 10_100, T0 + 50_000);

    // Act
    await s.reconnect("k2", 2);

    // Assert — KHÔNG mất đoạn nào: replay liền mạch từ (mốc − 300 ms) tới chunk cuối, không chốt final sớm vì mốc chỉ cách lúc rớt 6 s
    const replayed = s.instances[2].sentChunks.map(tsOf);
    expect(replayed[0]).toBe(1_003_700);
    expect(replayed.at(-1)).toBe(T0 + 50_000);
    expect(replayed).toHaveLength(464);
    expect(replayed.every((ts, i) => i === 0 || ts - replayed[i - 1] === STEP)).toBe(true);
    expect(s.canonical.map((x) => x.textOrig)).toEqual(["câu một"]);
  });

  test("test_soniox_controller_gate_tolerates_token_end_jitter_up_to_half_its_duration", async () => {
    // Arrange — câu một kết thúc abs 1_004_000; epoch pair mới 1_003_700
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    s.feedRange(T0, T0 + 10_000);
    s.emitSegments(0, "câu một", 3000, 4000);
    s.instances[0].handlers["disconnected"]?.();
    s.feedRange(T0 + 10_100, T0 + 12_000);
    await s.reconnect("k2", 2);

    // Act — cùng từ "một" nhưng pair mới ghi mốc kết thúc lệch +60 ms (abs 1_004_060 > cổng); rồi câu mới thật
    s.instances[2].handlers["token"]?.(token("một", 200, 360));
    s.instances[2].handlers["token"]?.(token("câu hai", 400, 900));
    s.instances[2].handlers["endpoint"]?.();

    // Assert — từ lệch mốc bị coi là đã emit (không sinh câu lặp/mảnh), câu mới vẫn qua
    expect(s.canonical.map((x) => x.textOrig)).toEqual(["câu một", "câu hai"]);
  });

  test("test_soniox_controller_gate_drops_translation_of_already_emitted_tail_but_keeps_translation_of_new_text", async () => {
    // Arrange — như trên nhưng câu có bản dịch; token dịch KHÔNG có mốc thời gian nên cổng thời gian không áp được cho chúng
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    s.feedRange(T0, T0 + 10_000);
    s.emitSegments(0, "câu một", 3000, 4000);
    s.instances[0].handlers["disconnected"]?.();
    s.feedRange(T0 + 10_100, T0 + 12_000);
    await s.reconnect("k2", 2);

    // Act — pair mới phiên âm lại đuôi câu một (gốc + dịch) rồi tới câu mới (gốc + dịch)
    s.instances[2].handlers["token"]?.(bareTranslation("dịch đuôi cũ"));
    s.instances[2].handlers["token"]?.(token("đuôi câu một", 0, 300, { language: "ja" }));
    s.instances[2].handlers["token"]?.(token("câu hai", 400, 900, { language: "ja" }));
    s.instances[2].handlers["token"]?.(bareTranslation("bản dịch hai"));
    s.instances[2].handlers["endpoint"]?.();

    // Assert — bản dịch của phần đã emit không dính vào câu mới
    expect(s.canonical).toHaveLength(2);
    expect(s.canonical[1]).toMatchObject({ textOrig: "câu hai", translationVi: "bản dịch hai", translationJa: null });
  });

  test("test_soniox_controller_first_generation_keeps_translation_tokens_that_arrive_before_the_source_tokens", async () => {
    // Arrange — chưa rớt lần nào: không có cổng, mọi token dịch (kể cả tới trước token gốc đầu tiên) phải vào câu
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    s.feedRange(T0, T0 + 2_000);

    // Act
    s.instances[0].handlers["token"]?.(bareTranslation("dịch tới trước"));
    s.instances[0].handlers["token"]?.(token("gốc", 500, 1000, { language: "ja" }));
    s.instances[0].handlers["endpoint"]?.();

    // Assert
    expect(s.canonical[0]).toMatchObject({ textOrig: "gốc", translationVi: "dịch tới trước" });
  });


  test("test_soniox_controller_first_generation_epoch_is_anchored_to_the_first_chunk_not_to_the_clock_at_feed_time", async () => {
    // Arrange — Date.now() lúc feed muộn hơn captureTs của chunk (chunk tới main thread rồi mới được gửi đi)
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    now = T0 + 70;

    // Act
    s.controller.feed(chunkAt(T0), T0);
    s.instances[0].handlers["token"]?.(token("đầu tiên", 0, 500));
    s.instances[0].handlers["endpoint"]?.();

    // Assert — mốc tuyệt đối theo captureTs của chunk đầu, không theo Date.now() lúc feed
    expect(s.canonical[0]).toMatchObject({ startAbsMs: T0, endAbsMs: T0 + 500 });
  });

  test("test_soniox_controller_replay_epoch_follows_the_audio_clock_not_capture_ts_jitter", async () => {
    // Arrange — captureTs từng chunk tới main thread lệch thất thường (−40..+90 ms); chunk đầu đúng giờ. Audio vẫn liền mạch 100 ms/chunk.
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    for (let i = 0; i <= 120; i++) {
      const jitter = i === 0 ? 0 : i % 2 === 0 ? 90 : -40;
      now = T0 + i * STEP;
      s.controller.feed(chunkAt(T0 + i * STEP), T0 + i * STEP + jitter);
    }
    s.emitSegments(0, "câu một", 3000, 4000); // mốc đã emit = abs T0 + 4000 (epoch = chunk đầu đúng giờ)
    s.instances[0].handlers["disconnected"]?.();

    // Act — replay từ (mốc − 300 ms) = chunk thứ 37 (audio T0 + 3700, captureTs của nó lệch +90 ms)
    await s.reconnect("k2", 2);
    s.instances[2].handlers["token"]?.(token("câu hai", 400, 900));
    s.instances[2].handlers["endpoint"]?.();

    // Assert — epoch connection mới = mốc audio của chunk replay đầu tiên (T0 + 3700), KHÔNG lệch theo jitter captureTs
    expect(s.canonical[1]).toMatchObject({ textOrig: "câu hai", startAbsMs: T0 + 4100, endAbsMs: T0 + 4600 });
  });

  describe("đuôi câu đã emit bị connection mới phiên âm lại với mốc lệch", () => {
    /** Câu một kết thúc abs T0 + 4000 bằng chữ "…します。"; connection mới có epoch T0 + 3700 nên mốc token = 3700 + offset. */
    async function afterReconnectWithEmittedTail() {
      const s = setup();
      await openImmediately(s.controller, pairKeys("k1"), s.instances);
      s.feedRange(T0, T0 + 10_000);
      s.instances[0].handlers["token"]?.(token("図書館は閉まり", 2500, 3700, { language: "ja" }));
      s.instances[0].handlers["token"]?.(token("ます。", 3700, 4000, { language: "ja" }));
      s.instances[0].handlers["endpoint"]?.();
      s.instances[1].handlers["token"]?.(token("src", 2500, 4000));
      s.instances[1].handlers["token"]?.(token("en", 2500, 4000, { translation_status: "translation" }));
      s.instances[1].handlers["endpoint"]?.();
      s.instances[0].handlers["disconnected"]?.();
      s.feedRange(T0 + 10_100, T0 + 12_000);
      await s.reconnect("k2", 2);
      return s;
    }

    test("test_soniox_controller_gate_drops_shifted_tail_token_that_matches_the_end_of_the_emitted_sentence", async () => {
      // Arrange
      const s = await afterReconnectWithEmittedTail();

      // Act — cùng chữ "ます。" nhưng connection mới gán mốc lệch +200 ms (abs 4000..4200 tính từ epoch 3700 ⇒ start 300→ lệch ra sau cổng)
      s.instances[2].handlers["token"]?.(token("ます。", 318, 498, { language: "ja" }));
      s.instances[2].handlers["endpoint"]?.();
      s.instances[2].handlers["token"]?.(token("câu hai", 800, 1300, { language: "vi" }));
      s.instances[2].handlers["endpoint"]?.();

      // Assert — mảnh đuôi bị loại, câu mới vẫn qua
      expect(s.canonical.map((x) => x.textOrig)).toEqual(["図書館は閉まります。", "câu hai"]);
    });

    test("test_soniox_controller_gate_drops_token_whose_midpoint_is_inside_the_emitted_region_even_when_its_text_differs", async () => {
      // Arrange
      const s = await afterReconnectWithEmittedTail();

      // Act — chữ nhận dạng khác lần trước ("まつ" thay vì "ます。") nhưng điểm giữa (abs 4000) nằm trong vùng đã emit, kết thúc lệch +100 ms
      s.instances[2].handlers["token"]?.(token("まつ", 200, 400, { language: "ja" }));
      s.instances[2].handlers["endpoint"]?.();
      s.instances[2].handlers["token"]?.(token("câu hai", 800, 1300, { language: "vi" }));
      s.instances[2].handlers["endpoint"]?.();

      // Assert — bị loại theo thời gian, không cần khớp chữ
      expect(s.canonical.map((x) => x.textOrig)).toEqual(["図書館は閉まります。", "câu hai"]);
    });

    test("test_soniox_controller_gate_keeps_token_within_slack_when_its_text_does_not_match_the_emitted_tail", async () => {
      // Arrange
      const s = await afterReconnectWithEmittedTail();

      // Act — sát sau cổng nhưng là chữ khác (người nói tiếp ngay) ⇒ không phải phần đã emit
      s.instances[2].handlers["token"]?.(token("はい", 318, 498, { language: "ja" }));
      s.instances[2].handlers["endpoint"]?.();

      // Assert
      expect(s.canonical.map((x) => x.textOrig)).toEqual(["図書館は閉まります。", "はい"]);
    });

    test("test_soniox_controller_gate_stops_matching_text_once_a_real_token_has_passed", async () => {
      // Arrange
      const s = await afterReconnectWithEmittedTail();

      // Act — lời mới ("はい") qua cổng trước; "ます。" đến ngay sau (vẫn trong dung sai) là phần của lời mới, không phải đuôi cũ
      s.instances[2].handlers["token"]?.(token("はい", 318, 498, { language: "ja" }));
      s.instances[2].handlers["token"]?.(token("ます。", 520, 700, { language: "ja" }));
      s.instances[2].handlers["endpoint"]?.();

      // Assert
      expect(s.canonical.map((x) => x.textOrig)).toEqual(["図書館は閉まります。", "はいます。"]);
    });

    test("test_soniox_controller_gate_ignores_repeated_provisional_tokens_when_matching_the_emitted_tail", async () => {
      // Arrange
      const s = await afterReconnectWithEmittedTail();

      // Act — Soniox gửi lại đuôi provisional nhiều lần, rồi mới chốt bản final (mốc lệch)
      const provisional = token("ます。", 318, 498, { language: "ja", is_final: false });
      s.instances[2].handlers["token"]?.(provisional);
      s.instances[2].handlers["token"]?.(provisional);
      s.instances[2].handlers["token"]?.(token("ます。", 318, 498, { language: "ja" }));
      s.instances[2].handlers["endpoint"]?.();

      // Assert — provisional không cộng dồn vào chữ so khớp: bản final vẫn nhận ra là đuôi đã emit
      expect(s.canonical.map((x) => x.textOrig)).toEqual(["図書館は閉まります。"]);
    });

    test("test_soniox_controller_gate_keeps_matching_text_that_starts_well_after_the_boundary", async () => {
      // Arrange
      const s = await afterReconnectWithEmittedTail();

      // Act — cùng chữ "ます。" nhưng bắt đầu 1,1 s sau cổng: câu nói mới thật, không phải đuôi bị phiên âm lại
      s.instances[2].handlers["token"]?.(token("ます。", 1400, 1600, { language: "ja" }));
      s.instances[2].handlers["endpoint"]?.();

      // Assert
      expect(s.canonical.map((x) => x.textOrig)).toEqual(["図書館は閉まります。", "ます。"]);
    });
  });

  test("test_soniox_controller_three_consecutive_reconnects_emit_every_segment_once_in_order", async () => {
    // Arrange — câu một ở pair 1
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    s.feedRange(T0, T0 + 10_000);
    s.emitSegments(0, "câu một", 3000, 4000); // abs 1_003_000..1_004_000

    // Act — rớt lần 1 → pair 2 phiên âm lại đuôi + câu hai; rớt lần 2 → pair 3 ...; rớt lần 3 → pair 4
    s.instances[0].handlers["disconnected"]?.();
    s.feedRange(T0 + 10_100, T0 + 12_000);
    await s.reconnect("k2", 2); // epoch 1_003_700
    s.emitSegments(2, "đuôi", 0, 300); // trùng phần đã emit ⇒ bị cổng loại
    s.emitSegments(2, "câu hai", 400, 900); // abs 1_004_100..1_004_600
    s.instances[2].handlers["disconnected"]?.();
    s.feedRange(T0 + 12_100, T0 + 15_000);
    await s.reconnect("k3", 4); // epoch 1_004_300
    s.emitSegments(4, "đuôi hai", 0, 300);
    s.emitSegments(4, "câu ba", 500, 1000); // abs 1_004_800..1_005_300
    s.instances[4].handlers["disconnected"]?.();
    s.feedRange(T0 + 15_100, T0 + 17_000);
    await s.reconnect("k4", 6); // epoch 1_005_000
    s.emitSegments(6, "đuôi ba", 0, 300);
    s.emitSegments(6, "câu bốn", 500, 1000); // abs 1_005_500..1_006_000

    // Assert — mỗi câu đúng 1 lần, đúng thứ tự, mốc tăng dần; 3 pair cũ đều đã đóng
    expect(s.canonical.map((x) => x.textOrig)).toEqual(["câu một", "câu hai", "câu ba", "câu bốn"]);
    expect(s.en.map((x) => x.textEn)).toEqual(["en câu một", "en câu hai", "en câu ba", "en câu bốn"]);
    const starts = s.canonical.map((x) => x.startAbsMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(s.canonical[3]).toMatchObject({ startAbsMs: 1_005_500, endAbsMs: 1_006_000 });
    expect([0, 1, 2, 3, 4, 5].every((i) => s.instances[i].closed)).toBe(true);
  });

  test("test_soniox_controller_reconnect_when_replay_throws_closes_the_new_pair_and_keeps_old_generation", async () => {
    // Arrange — sendAudio của pair mới ném (session chết ngay lúc replay)
    const s = setup({
      onSendAudio: (record) => {
        if (record.apiKey.startsWith("k2")) throw new Error("StateError: session closed");
      },
    });
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    s.feedRange(T0, T0 + 2_000);
    s.instances[0].handlers["disconnected"]?.();

    // Act
    const reconnecting = s.controller.reconnect(pairKeys("k2"));
    s.instances[2].resolveConnect();
    s.instances[3].resolveConnect();

    // Assert — lỗi nổi lên cho backoff thử lại; pair mới bị đóng (không rò WebSocket/đốt stream-seconds); pair cũ vẫn là hiện tại
    await expect(reconnecting).rejects.toThrow("StateError");
    expect(s.instances[2].closed).toBe(true);
    expect(s.instances[3].closed).toBe(true);
    expect(s.instances[0].closed).toBe(false);
  });
});

describe("SonioxStreamController — bỏ cuộc và dừng", () => {
  test("test_soniox_controller_stop_with_flush_pending_emits_finals_of_current_generation", async () => {
    // Arrange — bỏ cuộc reconnect: câu đang nói dở có final nhưng chưa có endpoint
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    s.feedRange(T0, T0 + 2_000);
    s.instances[0].handlers["token"]?.(token("đang nói dở", 500, 1500));

    // Act
    await s.controller.stop({ flushPending: true });

    // Assert
    expect(s.canonical.map((x) => x.textOrig)).toEqual(["đang nói dở"]);
  });

  test("test_soniox_controller_plain_stop_does_not_emit_pending_finals", async () => {
    // Arrange — đường unmount/lỗi giữ hành vi cũ: đóng ngay, không phát gì thêm
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    s.feedRange(T0, T0 + 2_000);
    s.instances[0].handlers["token"]?.(token("đang nói dở", 500, 1500));

    // Act
    await s.controller.stop();

    // Assert
    expect(s.canonical).toEqual([]);
  });

  test("test_soniox_controller_feed_after_stop_is_ignored", async () => {
    // Arrange
    const s = setup();
    await openImmediately(s.controller, pairKeys("k1"), s.instances);
    await s.controller.stop();
    const sentBefore = s.instances[0].sentChunks.length;

    // Act
    s.controller.feed(chunkAt(T0 + 5_000), T0 + 5_000);

    // Assert — không ném, không gửi sang session đã đóng
    expect(s.instances[0].sentChunks).toHaveLength(sentBefore);
  });
});
