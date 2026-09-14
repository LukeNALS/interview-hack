import { describe, expect, test, vi } from "vitest";
import { SonioxStreamController, type CanonicalSegment, type EnSegment } from "@/hooks/use-soniox";
import type { RealtimeToken } from "@soniox/client";
import type { SonioxSessionFactory, SonioxSessionLike } from "@/lib/soniox/connection";

/**
 * Regression P07 — bug production: KHÔNG utterance nào được chốt trong buổi live.
 *
 * Nguyên nhân: `TokenSegmentAccumulator.feed()` chỉ chốt khi thấy token `<end>`, NHƯNG
 * SDK @soniox/client lọc bỏ `<end>`/`<fin>` khỏi stream token (`filterSpecialTokens`,
 * dist/index.mjs:962) và bắn `endpoint` thành event RIÊNG (index.mjs:973). Controller
 * lại không hề đăng ký handler `onEndpoint` -> `flush()` không bao giờ chạy ->
 * onCanonicalFinal/onEnFinal không bao giờ bắn -> không gì được POST lên /utterances.
 *
 * VÌ SAO TEST CŨ KHÔNG BẮT ĐƯỢC: fake session của `use-soniox.test.ts` đẩy thẳng token
 * `<end>` vào handler `token` — tức là mô phỏng đúng cái mà SDK THẬT không bao giờ gửi.
 * Test dưới đây cố ý KHÔNG BAO GIỜ gửi `<end>` qua đường token; chốt câu chỉ đến từ
 * event `endpoint`, đúng như SDK thật hành xử.
 */

interface FakeInstance {
  handlers: Record<string, (...args: unknown[]) => void>;
}

/** Fake session tối giản — connect() resolve ngay (không cần gate như test reconnect). */
function makeSessionFactory() {
  const instances: FakeInstance[] = [];

  const factory: SonioxSessionFactory = () => {
    const record: FakeInstance = { handlers: {} };
    instances.push(record);
    const session: SonioxSessionLike = {
      async connect() {},
      sendAudio() {},
      async finish() {},
      close() {},
      on(event, handler) {
        record.handlers[event] = handler as (...args: unknown[]) => void;
        return session;
      },
    };
    return session;
  };

  return { factory, instances };
}

/**
 * `is_final: true` mặc định — SDK thật LUÔN set field này (`is_final: Boolean(t.is_final)`,
 * dist/index.mjs:646) và accumulator chỉ gộp token đã final vào segment (chống transcript
 * lặp, xem use-soniox-final-token-dedup.test.ts). Fixture bỏ trống field = mô phỏng thứ SDK
 * không bao giờ gửi.
 */
function token(text: string, extra: Partial<RealtimeToken> = {}): RealtimeToken {
  return { text, is_final: true, start_ms: 0, end_ms: 1000, ...extra } as RealtimeToken;
}

/** instances[0] = canonical, instances[1] = en (thứ tự openAllReady trong controller). */
const CANONICAL = 0;
const EN = 1;

describe("SonioxStreamController — chốt segment qua event `endpoint` của SDK", () => {
  test("test_soniox_controller_sdk_endpoint_event_flushes_canonical_segment", async () => {
    // Arrange — controller thật + fake session ghi lại handler theo tên event.
    const { factory, instances } = makeSessionFactory();
    const onCanonicalFinal = vi.fn<(s: CanonicalSegment) => void>();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onCanonicalFinal },
    });
    await controller.open("key");

    // Act — token thường (KHÔNG có `<end>`, đúng như SDK sau filterSpecialTokens),
    // rồi SDK bắn `endpoint` báo hết câu.
    instances[CANONICAL].handlers["token"]?.(token("Tổng quan ", { language: "vi", speaker: "spk-1" }));
    instances[CANONICAL].handlers["token"]?.(token("về Chuyển đổi số", { end_ms: 2400 }));
    instances[CANONICAL].handlers["endpoint"]?.();

    // Assert — segment được chốt đúng 1 lần với text ghép đủ.
    expect(onCanonicalFinal).toHaveBeenCalledTimes(1);
    const segment = onCanonicalFinal.mock.calls[0][0];
    expect(segment.textOrig).toBe("Tổng quan về Chuyển đổi số");
    expect(segment.language).toBe("vi");
    expect(segment.speaker).toBe("spk-1");
    expect(segment.endMs).toBe(2400);
  });

  test("test_soniox_controller_sdk_endpoint_event_flushes_en_translation_segment", async () => {
    // Arrange
    const { factory, instances } = makeSessionFactory();
    const onEnFinal = vi.fn<(s: EnSegment) => void>();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onEnFinal },
    });
    await controller.open("key");

    // Act — connection `en` (one_way -> en) nhận CẢ token gốc LẪN token dịch:
    // accumulator chốt theo `original`, `textEn` lấy từ nhánh `translation`.
    instances[EN].handlers["token"]?.(token("Chuyển đổi số", { language: "vi" }));
    instances[EN].handlers["token"]?.(token("Digital ", { translation_status: "translation" }));
    instances[EN].handlers["token"]?.(token("transformation", { translation_status: "translation", end_ms: 2400 }));
    instances[EN].handlers["endpoint"]?.();

    // Assert
    expect(onEnFinal).toHaveBeenCalledTimes(1);
    expect(onEnFinal.mock.calls[0][0].textEn).toBe("Digital transformation");
  });

  test("test_soniox_controller_tokens_without_endpoint_event_stay_partial_and_emit_no_final", async () => {
    // Arrange — khoá lại đúng bản chất bug: token chảy về nhưng SDK chưa báo hết câu.
    const { factory, instances } = makeSessionFactory();
    const onCanonicalFinal = vi.fn();
    const onPartial = vi.fn<(t: string) => void>();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onCanonicalFinal, onPartial },
    });
    await controller.open("key");

    // Act — KHÔNG bắn `endpoint`.
    instances[CANONICAL].handlers["token"]?.(token("chưa hết câu"));

    // Assert — chỉ partial, tuyệt đối chưa final.
    expect(onCanonicalFinal).not.toHaveBeenCalled();
    expect(onPartial).toHaveBeenLastCalledWith("chưa hết câu");
  });

  test("test_soniox_controller_endpoint_event_with_empty_buffer_emits_no_final", async () => {
    // Arrange — endpoint tới khi chưa tích luỹ token nào (im lặng đầu buổi).
    const { factory, instances } = makeSessionFactory();
    const onCanonicalFinal = vi.fn();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onCanonicalFinal },
    });
    await controller.open("key");

    // Act
    instances[CANONICAL].handlers["endpoint"]?.();

    // Assert — không bắn segment rỗng.
    expect(onCanonicalFinal).not.toHaveBeenCalled();
  });

  test("test_soniox_controller_two_endpoint_events_produce_two_separate_segments", async () => {
    // Arrange — nhiều lượt nói liên tiếp phải ra nhiều utterance, không dính vào nhau.
    const { factory, instances } = makeSessionFactory();
    const onCanonicalFinal = vi.fn<(s: CanonicalSegment) => void>();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onCanonicalFinal },
    });
    await controller.open("key");

    // Act
    instances[CANONICAL].handlers["token"]?.(token("câu một"));
    instances[CANONICAL].handlers["endpoint"]?.();
    instances[CANONICAL].handlers["token"]?.(token("câu hai"));
    instances[CANONICAL].handlers["endpoint"]?.();

    // Assert — accumulator reset sạch giữa 2 lượt.
    expect(onCanonicalFinal).toHaveBeenCalledTimes(2);
    expect(onCanonicalFinal.mock.calls[0][0].textOrig).toBe("câu một");
    expect(onCanonicalFinal.mock.calls[1][0].textOrig).toBe("câu hai");
  });
});
