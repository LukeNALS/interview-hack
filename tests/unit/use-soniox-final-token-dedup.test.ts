import { describe, expect, test, vi } from "vitest";
import { SonioxStreamController, type CanonicalSegment, type EnSegment } from "@/hooks/use-soniox";
import type { RealtimeToken } from "@soniox/client";
import type { SonioxSessionFactory, SonioxSessionLike } from "@/lib/soniox/connection";

/**
 * Regression P07 — bug production: transcript LẶP phần đầu mỗi câu.
 *
 * Soniox realtime gửi token provisional (`is_final: false`) rồi PHÁT LẠI cùng đoạn đó
 * ở response sau dưới dạng bản final đầy đủ hơn. `TokenSegmentAccumulator.feed()` cũ
 * đẩy MỌI token vào `original`/`translation` nên segment chốt ra chứa cả hai bản:
 *   text_orig = "こんにちは、自己紹介をお" + "こんにちは、自己紹介をお願いします"  (dữ liệu thật trong DB)
 *
 * Hợp đồng khoá ở đây: chỉ token `is_final === true` được vào segment; token provisional
 * chỉ nuôi `partialText()` (bubble mờ đang gõ) và bị vứt khi bản final tới.
 */

interface FakeInstance {
  handlers: Record<string, (...args: unknown[]) => void>;
}

/** Fake session tối giản — connect() resolve ngay, ghi lại handler theo tên event. */
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

/** SDK thật LUÔN set `is_final` (Boolean(t.is_final), dist/index.mjs:646) — fixture phải nói đúng. */
function finalToken(text: string, extra: Partial<RealtimeToken> = {}): RealtimeToken {
  return { text, is_final: true, start_ms: 0, end_ms: 1000, ...extra } as RealtimeToken;
}

function partialToken(text: string, extra: Partial<RealtimeToken> = {}): RealtimeToken {
  return { text, is_final: false, start_ms: 0, end_ms: 1000, ...extra } as RealtimeToken;
}

/** instances[0] = canonical, instances[1] = en (thứ tự openAllReady trong controller). */
const CANONICAL = 0;
const EN = 1;

describe("SonioxStreamController — token provisional không được lọt vào segment", () => {
  test("test_soniox_controller_provisional_then_final_token_emits_segment_without_duplicated_prefix", async () => {
    // Arrange — mô phỏng đúng stream thật đã gây bug trong DB.
    const { factory, instances } = makeSessionFactory();
    const onCanonicalFinal = vi.fn<(s: CanonicalSegment) => void>();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onCanonicalFinal },
    });
    await controller.open("key");

    // Act — Soniox bắn bản provisional trước, rồi phát LẠI cả câu dưới dạng final.
    instances[CANONICAL].handlers["token"]?.(partialToken("こんにちは、自己紹介をお", { language: "ja", speaker: "1", start_ms: 120, end_ms: 1200 }));
    instances[CANONICAL].handlers["token"]?.(finalToken("こんにちは、自己紹介をお願いします", { language: "ja", speaker: "1", start_ms: 120, end_ms: 1980 }));
    instances[CANONICAL].handlers["endpoint"]?.();

    // Assert — chỉ bản final, KHÔNG có tiền tố lặp.
    expect(onCanonicalFinal).toHaveBeenCalledTimes(1);
    expect(onCanonicalFinal.mock.calls[0][0].textOrig).toBe("こんにちは、自己紹介をお願いします");
  });

  test("test_soniox_controller_provisional_tokens_only_emit_no_segment_on_endpoint", async () => {
    // Arrange — cả câu chưa có token final nào (mạng chậm, chưa kịp finalize).
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
    instances[CANONICAL].handlers["token"]?.(partialToken("こんにちは"));
    instances[CANONICAL].handlers["endpoint"]?.();

    // Assert — không chốt utterance từ nội dung chưa final (nội dung đó còn thay đổi được).
    expect(onCanonicalFinal).not.toHaveBeenCalled();
  });

  test("test_soniox_controller_provisional_tokens_still_stream_partial_text_for_live_bubble", async () => {
    // Arrange — hành vi bubble mờ realtime PHẢI giữ nguyên cho user.
    const { factory, instances } = makeSessionFactory();
    const onPartial = vi.fn<(t: string) => void>();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onPartial },
    });
    await controller.open("key");

    // Act — đuôi provisional lớn dần theo từng response.
    instances[CANONICAL].handlers["token"]?.(partialToken("こんにちは", { start_ms: 120, end_ms: 600 }));
    instances[CANONICAL].handlers["token"]?.(partialToken("、自己紹介を", { start_ms: 600, end_ms: 1200 }));

    // Assert — user vẫn thấy chữ chạy.
    expect(onPartial).toHaveBeenLastCalledWith("こんにちは、自己紹介を");
  });

  test("test_soniox_controller_resent_provisional_tail_does_not_duplicate_partial_text", async () => {
    // Arrange — mỗi response Soniox gửi LẠI toàn bộ đuôi provisional.
    const { factory, instances } = makeSessionFactory();
    const onPartial = vi.fn<(t: string) => void>();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onPartial },
    });
    await controller.open("key");

    // Act — response 1: [120,600]; response 2: phát lại [120,600] + phần mới [600,1200].
    instances[CANONICAL].handlers["token"]?.(partialToken("こんにちは", { start_ms: 120, end_ms: 600 }));
    instances[CANONICAL].handlers["token"]?.(partialToken("こんにちは", { start_ms: 120, end_ms: 600 }));
    instances[CANONICAL].handlers["token"]?.(partialToken("、自己紹介を", { start_ms: 600, end_ms: 1200 }));

    // Assert — bubble hiện đuôi hiện tại, không nối chồng bản cũ.
    expect(onPartial).toHaveBeenLastCalledWith("こんにちは、自己紹介を");
  });

  test("test_soniox_controller_provisional_translation_token_is_excluded_from_en_segment", async () => {
    // Arrange — nhánh dịch (kênh en) cũng phải lọc provisional, nếu không bản dịch lặp.
    const { factory, instances } = makeSessionFactory();
    const onEnFinal = vi.fn<(s: EnSegment) => void>();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onEnFinal },
    });
    await controller.open("key");

    // Act — "Hello, please" provisional rồi "Hello, please introduce yourself" final.
    instances[EN].handlers["token"]?.(finalToken("こんにちは", { language: "ja" }));
    instances[EN].handlers["token"]?.(partialToken("Hello, please", { translation_status: "translation" }));
    instances[EN].handlers["token"]?.(finalToken("Hello, please introduce yourself", { translation_status: "translation" }));
    instances[EN].handlers["endpoint"]?.();

    // Assert
    expect(onEnFinal).toHaveBeenCalledTimes(1);
    expect(onEnFinal.mock.calls[0][0].textEn).toBe("Hello, please introduce yourself");
  });

  test("test_soniox_controller_flushed_segment_drops_leftover_provisional_tail", async () => {
    // Arrange — đuôi provisional còn sót khi endpoint tới không được dính sang câu sau.
    const { factory, instances } = makeSessionFactory();
    const onCanonicalFinal = vi.fn<(s: CanonicalSegment) => void>();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onCanonicalFinal },
    });
    await controller.open("key");

    // Act — câu 1 final + đuôi provisional dư, endpoint, rồi câu 2.
    instances[CANONICAL].handlers["token"]?.(finalToken("câu một", { start_ms: 0, end_ms: 900 }));
    instances[CANONICAL].handlers["token"]?.(partialToken("rác provisional", { start_ms: 900, end_ms: 1200 }));
    instances[CANONICAL].handlers["endpoint"]?.();
    instances[CANONICAL].handlers["token"]?.(finalToken("câu hai", { start_ms: 1200, end_ms: 2000 }));
    instances[CANONICAL].handlers["endpoint"]?.();

    // Assert
    expect(onCanonicalFinal).toHaveBeenCalledTimes(2);
    expect(onCanonicalFinal.mock.calls[0][0].textOrig).toBe("câu một");
    expect(onCanonicalFinal.mock.calls[1][0].textOrig).toBe("câu hai");
  });
});
