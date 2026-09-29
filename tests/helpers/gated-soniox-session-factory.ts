import { RealtimeError } from "@soniox/client";
import type { SonioxStreamController } from "@/hooks/use-soniox";
import type { PairKeys, SonioxSessionFactory, SonioxSessionLike } from "@/lib/soniox/connection";

/**
 * Fake session factory cho test `SonioxStreamController`: kiểm soát ĐƯỢC thời điểm `connect()` resolve
 * (gate thủ công) để test đúng các race "drain() trước await openAllReady()" và "lỗi server đến trước
 * khi pair mới được swap". Ghi lại key đã dùng để assert mỗi connection một key riêng.
 */
export interface GatedInstance {
  apiKey: string;
  sentChunks: Uint8Array[];
  closed: boolean;
  handlers: Record<string, (...args: unknown[]) => void>;
  resolveConnect: () => void;
  /** `connect()` bị từ chối (mạng, timeout 20 s của SDK...). */
  rejectConnect: (err: Error) => void;
}

export function makeGatedSessionFactory() {
  const instances: GatedInstance[] = [];

  const factory: SonioxSessionFactory = (_config, apiKey) => {
    let resolveConnect!: () => void;
    let rejectConnect!: (err: Error) => void;
    const gate = new Promise<void>((resolve, reject) => {
      resolveConnect = resolve;
      rejectConnect = reject;
    });
    const record: GatedInstance = { apiKey, sentChunks: [], closed: false, handlers: {}, resolveConnect, rejectConnect };
    instances.push(record);
    const session: SonioxSessionLike = {
      async connect() {
        await gate;
      },
      sendAudio(data) {
        record.sentChunks.push(data as Uint8Array);
      },
      async finish() {},
      close() {
        record.closed = true;
        // Mô phỏng worst-case: SDK thật CÓ THỂ tự bắn "disconnected" ngay cả khi đóng chủ
        // động (chưa verify với SDK Soniox thật — code review Unresolved #3). Controller
        // PHẢI tự lọc qua guard stopped/stale-connection, không được dựa vào SDK "tử tế".
        record.handlers["disconnected"]?.();
      },
      on(event, handler) {
        record.handlers[event] = handler as (...args: unknown[]) => void;
        return session;
      },
    };
    return session;
  };

  return { factory, instances };
}

export type GatedInstances = ReturnType<typeof makeGatedSessionFactory>["instances"];

/** Cặp key giả có tiền tố dễ đọc: `<prefix>-canonical` / `<prefix>-en`. */
export function pairKeys(prefix: string): PairKeys {
  return { canonical: `${prefix}-canonical`, en: `${prefix}-en` };
}

/** open() tạo 2 instance MỚI (canonical rồi en, đồng bộ trước await connect() đầu tiên) —
 *  mở khoá cả 2 gate rồi await cho xong. */
export async function openImmediately(
  controller: SonioxStreamController,
  keys: PairKeys,
  instances: GatedInstances,
): Promise<void> {
  const before = instances.length;
  const opened = controller.open(keys);
  instances[before].resolveConnect();
  instances[before + 1].resolveConnect();
  await opened;
}

/** Lỗi server Soniox dựng bằng `RealtimeError` THẬT của SDK (`statusCode` + `raw` payload thô) — SDK đổi tên
 *  field thì test đỏ thay vì pass với object tự chế. */
export function serverError(statusCode: number, rawErrorType?: string): Error {
  const raw = rawErrorType ? { error_code: statusCode, error_type: rawErrorType } : { error_code: statusCode };
  return new RealtimeError(`soniox ${statusCode}`, "realtime_error", statusCode, raw);
}
