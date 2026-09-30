import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RealtimeToken } from "@soniox/client";
import { SonioxStreamController, type CanonicalSegment, type EnSegment } from "@/hooks/use-soniox";
import { absToSessionAxis } from "@/lib/transcript/utterance-builder";
import { makeGatedSessionFactory, openImmediately, pairKeys } from "../helpers/gated-soniox-session-factory";

/**
 * Audit #6 — Mỗi lần reconnect là MỘT THẾ HỆ connection riêng (accumulator riêng, mốc thời gian tuyệt đối theo epoch
 * của CHÍNH connection phát). Trước đây 1 cặp accumulator sống qua mọi swap và epoch lấy từ canonical HIỆN TẠI lúc
 * emit: token cũ đến muộn bị ghép vào câu mới ("OLDNEW") và segment cũ rơi lệch trục thời gian.
 */

const EPOCH_1 = 1_000_000; // đồng hồ capture lúc pair đầu nhận chunk đầu tiên
/** Mốc audio chunk đầu được replay vào pair mới: segment cuối của pair 1 kết thúc ở EPOCH_1 + 900 ⇒ replay từ (mốc − 300 ms). */
const EPOCH_2 = EPOCH_1 + 600;
const CHUNK = new Uint8Array(3200).buffer; // 100 ms PCM16 mono 16 kHz — controller tính đồng hồ audio theo độ dài byte

function token(text: string, startMs: number, endMs: number, extra: Partial<RealtimeToken> = {}): RealtimeToken {
  return { text, is_final: true, start_ms: startMs, end_ms: endMs, ...extra } as RealtimeToken;
}

/** Dựng controller với 2 thế hệ: pair 1 (instances[0]=canonical, [1]=en) rồi rớt + reconnect sang pair 2 ([2],[3]). */
async function controllerAfterReconnect(beforeDrop?: (instances: ReturnType<typeof makeGatedSessionFactory>["instances"]) => void) {
  vi.spyOn(Date, "now").mockReturnValue(EPOCH_1);
  const { factory, instances } = makeGatedSessionFactory();
  const canonical: CanonicalSegment[] = [];
  const en: EnSegment[] = [];
  const partials: string[] = [];
  const controller = new SonioxStreamController({
    mode: "online",
    label: "mic",
    sessionFactory: factory,
    handlers: {
      onCanonicalFinal: (s) => canonical.push(s),
      onEnFinal: (s) => en.push(s),
      onPartial: (t) => partials.push(t),
    },
  });
  await openImmediately(controller, pairKeys("k1"), instances);
  for (let i = 0; i < 30; i++) controller.feed(CHUNK, EPOCH_1 + i * 100); // pair 1 có epoch_conn = EPOCH_1 (chunk đầu)
  beforeDrop?.(instances); // segment của pair 1 được emit TRƯỚC khi rớt

  instances[0].handlers["disconnected"]?.(); // rớt ⇒ degraded, audio sau đó vào buffer
  for (let i = 30; i < 40; i++) controller.feed(CHUNK, EPOCH_1 + i * 100);
  const reconnecting = controller.reconnect(pairKeys("k2"));
  instances[2].resolveConnect();
  instances[3].resolveConnect();
  await reconnecting; // pair 2 có epoch_conn = mốc audio của chunk replay đầu tiên (EPOCH_2 khi pair 1 đã emit, EPOCH_1 khi chưa)
  return { controller, instances, canonical, en, partials };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SonioxStreamController — thế hệ connection (audit #6)", () => {
  test("test_soniox_controller_late_final_from_old_generation_is_ignored_and_never_merged_into_new_generation_segment", async () => {
    // Arrange — token cũ đến muộn sau khi đã swap (pair mới phiên âm lại phần chưa chốt), rồi pair mới có token riêng
    const { instances, canonical } = await controllerAfterReconnect();
    instances[0].handlers["token"]?.(token("OLD", 300_000, 301_000));
    instances[2].handlers["token"]?.(token("NEW", 0, 1_000));

    // Act — endpoint cũ đến muộn, rồi endpoint của pair mới
    instances[0].handlers["endpoint"]?.();
    instances[2].handlers["endpoint"]?.();

    // Assert — thế hệ cũ bị bỏ; segment mới chỉ chứa "NEW" (trước sửa: 1 segment "OLDNEW" start 300000 end 1000)
    expect(canonical.map((s) => s.textOrig)).toEqual(["NEW"]);
  });

  test("test_soniox_controller_segment_times_use_epoch_of_emitting_connection", async () => {
    // Arrange — pair 1 chốt segment TRƯỚC khi rớt; pair 2 (epoch khác) chốt sau reconnect
    const { instances, canonical, en } = await controllerAfterReconnect((inst) => {
      inst[0].handlers["token"]?.(token("OLD", 500, 900));
      // Segment en chỉ chốt khi có token gốc đi kèm token dịch (accumulator cần `original` không rỗng).
      inst[1].handlers["token"]?.(token("src-old", 500, 900));
      inst[1].handlers["token"]?.(token("old-en", 500, 900, { translation_status: "translation" }));
      inst[0].handlers["endpoint"]?.();
      inst[1].handlers["endpoint"]?.();
    });
    instances[2].handlers["token"]?.(token("NEW", 500, 900));
    instances[3].handlers["token"]?.(token("src-new", 500, 900));
    instances[3].handlers["token"]?.(token("new-en", 500, 900, { translation_status: "translation" }));

    // Act — endpoint của pair mới
    instances[2].handlers["endpoint"]?.();
    instances[3].handlers["endpoint"]?.();

    // Assert — mốc tuyệt đối = epoch của CHÍNH thế hệ phát (không dồn hết về epoch của pair hiện tại)
    expect(canonical.map((s) => [s.textOrig, s.startAbsMs, s.endAbsMs])).toEqual([
      ["OLD", EPOCH_1 + 500, EPOCH_1 + 900],
      ["NEW", EPOCH_2 + 500, EPOCH_2 + 900],
    ]);
    expect(en.map((s) => [s.textEn, s.startAbsMs, s.endAbsMs])).toEqual([
      ["old-en", EPOCH_1 + 500, EPOCH_1 + 900],
      ["new-en", EPOCH_2 + 500, EPOCH_2 + 900],
    ]);
  });

  test("test_soniox_controller_partial_text_comes_only_from_current_generation", async () => {
    // Arrange
    const { instances, partials } = await controllerAfterReconnect();
    partials.length = 0;

    // Act — token provisional của pair cũ (sắp đóng) rồi của pair hiện tại
    instances[0].handlers["token"]?.(token("cũ", 0, 100, { is_final: false }));
    instances[2].handlers["token"]?.(token("mới", 0, 100, { is_final: false }));

    // Assert — bubble mờ chỉ vẽ từ thế hệ hiện tại
    expect(partials).toEqual(["mới"]);
  });

  test("test_soniox_controller_token_before_any_audio_has_no_timeline_and_is_not_emitted", async () => {
    // Arrange — chưa bơm chunk nào ⇒ connection chưa có epoch_conn
    vi.spyOn(Date, "now").mockReturnValue(EPOCH_1);
    const { factory, instances } = makeGatedSessionFactory();
    const canonical: CanonicalSegment[] = [];
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onCanonicalFinal: (s) => canonical.push(s) },
    });
    await openImmediately(controller, pairKeys("k1"), instances);

    // Act
    instances[0].handlers["token"]?.(token("lạc", 0, 100));
    instances[0].handlers["endpoint"]?.();

    // Assert — không đặt được segment lên trục capture nên bỏ (không đẩy mốc rác lên server)
    expect(canonical).toEqual([]);
  });
});

describe("absToSessionAxis", () => {
  test("test_abs_to_session_axis_subtracts_t0_local_from_absolute_capture_clock", () => {
    // Arrange + Act
    const result = absToSessionAxis(1_300_500, 1_300_900, 1_000_000);

    // Assert
    expect(result).toEqual({ t_start_ms: 300_500, t_end_ms: 300_900 });
  });
});
