import type { SonioxConnection } from "./connection";

/**
 * "1 AudioWorklet -> fan-out 2 WS" (§Key Insight 1 / SU R1): the exact same PCM chunk,
 * same order, same call, goes to every connection for one audio stream — keeps
 * canonical/en on a shared clock so `align.ts`'s IoU matching stays accurate.
 */

/** Opens N connections concurrently and waits for ALL to be ready before returning.
 *  Feeding audio into a half-open connection would skew that connection's epoch_conn
 *  relative to its sibling — always await this before the first fanOutChunk() call.
 *  `apiKeys[i]` mở `connections[i]`: key single-use nên MỖI connection một key riêng. */
export async function openAllReady(connections: SonioxConnection[], apiKeys: string[]): Promise<void> {
  if (apiKeys.length !== connections.length) {
    throw new Error(`openAllReady: ${connections.length} connection nhưng ${apiKeys.length} key`);
  }
  await Promise.all(connections.map((c, i) => c.open(apiKeys[i])));
}

/** Fans one PCM chunk out to every connection identically. */
export function fanOutChunk(connections: SonioxConnection[], chunk: Uint8Array): void {
  for (const conn of connections) conn.feed(chunk);
}

/** Gracefully finishes + closes every connection — call on stopCapture(). */
export async function closeAll(connections: SonioxConnection[]): Promise<void> {
  // allSettled: connection đã chết vì lỗi server (SDK ném StateError ở finish()) không được chặn
  // việc close() connection anh em còn sống — nếu không WebSocket kia rò tới khi server tự ngắt.
  await Promise.allSettled(connections.map((c) => c.finish()));
  for (const conn of connections) conn.close();
}
