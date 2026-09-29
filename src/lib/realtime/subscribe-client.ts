"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import type { Database } from "@/types/db";
import { realtimeChannelName, type ServerEvent } from "@/types/events";

/**
 * Subscribe kênh `session:{id}` phía browser (supabase-js) — nhận broadcast
 * `utterance.final`/`suggestion.new`/... từ `broadcast-server.ts` (BE).
 * Channel PRIVATE (audit #4, 0020): Realtime chỉ cho CHỦ phiên join; browser
 * không có quyền gửi. Không tự retry vô hạn — caller (use-live-session) quan
 * sát `onStatusChange` để tự resubscribe + backfill (fix B15, §Architecture
 * bước 13); join bị từ chối (CHANNEL_ERROR) đi cùng nhánh "disconnected".
 */

const EVENT_TYPES: readonly ServerEvent["type"][] = [
  "utterance.partial",
  "utterance.final",
  "suggestion.new",
  "insight.new",
  "conn.degraded",
  "conn.restored",
];

export type SubscribeStatus = "SUBSCRIBED" | "disconnected";

export interface SubscribeSessionChannelOptions {
  sessionId: string;
  onEvent: (event: ServerEvent) => void;
  onStatusChange?: (status: SubscribeStatus) => void;
  /** DI cho test — mặc định browser client thật. */
  client?: SupabaseClient<Database>;
}

/** Subscribe + trả unsubscribe fn — gọi lại hàm này ở caller để resubscribe khi rớt (B15). */
export function subscribeSessionChannel(opts: SubscribeSessionChannelOptions): () => void {
  const supabase = opts.client ?? createBrowserSupabaseClient();
  const channel = supabase.channel(realtimeChannelName(opts.sessionId), { config: { private: true } });

  for (const type of EVENT_TYPES) {
    channel.on(
      "broadcast",
      { event: type },
      (message: { payload: ServerEvent }) => opts.onEvent(message.payload),
    );
  }

  // Private join mang JWT user: nạp token vào Realtime TRƯỚC khi join — lần mount đầu
  // có thể đến trước sự kiện INITIAL_SESSION (lúc supabase-js tự setAuth), join bằng
  // anon sẽ bị từ chối. Token refresh giữa buổi thì supabase-js tự setAuth lại.
  let disposed = false;
  void Promise.resolve()
    .then(() => supabase.realtime.setAuth())
    .catch(() => undefined)
    .then(() => {
      if (disposed) return;
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          opts.onStatusChange?.("SUBSCRIBED");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          opts.onStatusChange?.("disconnected");
        }
      });
    });

  return () => {
    disposed = true;
    void supabase.removeChannel(channel);
  };
}
