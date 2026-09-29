import { describe, expect, test } from "vitest";
import { classifySonioxRealtimeError } from "@/lib/soniox/classify-realtime-error";

/**
 * Phân loại lỗi server Soniox phát qua event `error` sau connect (dữ liệu thật: E1 401 key single-use
 * dùng lại, E4 403 `temp_api_key_session_expired`). Đối tượng lỗi giả có đúng shape SDK 2.3.0
 * (`RealtimeError`: `statusCode` + `raw` là payload thô) — hàm không `instanceof` class SDK.
 */

function sdkError(statusCode?: number, raw?: unknown): Error {
  return Object.assign(new Error("soniox"), { statusCode, raw });
}

describe("classifySonioxRealtimeError", () => {
  test("test_classify_soniox_error_401_auth_is_retry_with_new_keys", () => {
    // Arrange — key single-use đã dùng / hết hạn
    const err = sdkError(401, { error_code: 401, error_message: "Invalid or expired temporary API key" });
    // Act + Assert
    expect(classifySonioxRealtimeError(err)).toBe("retry");
  });

  test("test_classify_soniox_error_403_with_session_expired_type_is_session_expired_without_retry", () => {
    // Arrange — E4: max_session_duration hết, server cắt cứng
    const err = sdkError(403, { error_code: 403, error_type: "temp_api_key_session_expired" });
    // Act + Assert
    expect(classifySonioxRealtimeError(err)).toBe("session_expired");
  });

  test("test_classify_soniox_error_403_without_session_expired_type_is_forbidden", () => {
    // Arrange — 403 vì lý do KHÁC (thiếu quyền)
    const err = sdkError(403, { error_code: 403, error_type: "permission_denied" });
    // Act + Assert
    expect(classifySonioxRealtimeError(err)).toBe("forbidden");
  });

  test("test_classify_soniox_error_403_without_raw_payload_is_forbidden", () => {
    // Arrange — thiếu payload thô: mặc định an toàn là hiện lỗi cho user, KHÔNG nuốt như hết cap
    // Act + Assert
    expect(classifySonioxRealtimeError(sdkError(403))).toBe("forbidden");
    expect(classifySonioxRealtimeError(sdkError(403, null))).toBe("forbidden");
  });

  test("test_classify_soniox_error_does_not_read_message_text_to_detect_session_expiry", () => {
    // Arrange — message giống hệt câu thật của E4 nhưng KHÔNG có raw.error_type
    const err = Object.assign(
      new Error("Temporary API key session duration limit exceeded. Create a new temporary API key."),
      { statusCode: 403 },
    );
    // Act + Assert — không so text (đổi câu chữ là hỏng), chỉ tin field có cấu trúc
    expect(classifySonioxRealtimeError(err)).toBe("forbidden");
  });

  test.each([402, 429])("test_classify_soniox_error_%i_quota_is_fatal_quota", (status) => {
    expect(classifySonioxRealtimeError(sdkError(status))).toBe("quota");
  });

  test.each([408, 500, 503, 502, 504])("test_classify_soniox_error_%i_server_side_is_retry", (status) => {
    expect(classifySonioxRealtimeError(sdkError(status))).toBe("retry");
  });

  test("test_classify_soniox_error_connection_error_without_status_is_retry", () => {
    // Arrange — WS đóng bất thường: SDK dựng ConnectionError, không có statusCode
    // Act + Assert
    expect(classifySonioxRealtimeError(sdkError(undefined))).toBe("retry");
  });

  test("test_classify_soniox_error_400_bad_request_is_fatal_config", () => {
    expect(classifySonioxRealtimeError(sdkError(400))).toBe("fatal");
  });

  test.each([null, undefined, "boom", 42, {}])("test_classify_soniox_error_unknown_shape_%j_is_retry", (input) => {
    expect(classifySonioxRealtimeError(input)).toBe("retry");
  });
});
