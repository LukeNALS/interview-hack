import "server-only";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getPublicEnv, getServerEnv } from "@/lib/env";
import { realtimeChannelName, type ServerEvent } from "@/types/events";

/**
 * Đẩy event Realtime cho kênh `session:{id}` — dùng REST broadcast endpoint
 * (Supabase, service-role) là đường chính vì route chạy serverless, KHÔNG
 * giữ WebSocket mở được (phase-05 §Architecture). Fallback supabase-js
 * `channel.send` nếu REST lỗi. Lỗi broadcast KHÔNG throw — ingest (DB ghi
 * trước khi gọi hàm này) là nguồn sự thật, client bù qua backfill (SU T8).
 *
 * Broadcast public (không set `private`) — chưa có Realtime Authorization
 * RLS policy nào cấu hình cho `session:{id}`; xem Unresolved trong report
 * P05-BE (channel name = session UUID, độ khó đoán là lớp bảo vệ duy nhất).
 */

const BROADCAST_REST_PATH = "/realtime/v1/api/broadcast";
const FALLBACK_TIMEOUT_MS = 3000;

export async function broadcastEvent(sessionId: string, event: ServerEvent): Promise<void> {
  const channel = realtimeChannelName(sessionId);
  const restOk = await broadcastViaRest(channel, event);
  if (restOk) return;

  try {
    await broadcastViaClient(channel, event);
  } catch (err) {
    console.error("[broadcast] fallback channel.send lỗi", {
      channel,
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function broadcastViaRest(channel: string, event: ServerEvent): Promise<boolean> {
  try {
    const { NEXT_PUBLIC_SUPABASE_URL } = getPublicEnv();
    const { SUPABASE_SERVICE_ROLE_KEY } = getServerEnv();

    const res = await fetch(`${NEXT_PUBLIC_SUPABASE_URL}${BROADCAST_REST_PATH}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ topic: channel, event: event.type, payload: event }],
      }),
    });

    if (!res.ok) {
      console.error("[broadcast] REST broadcast lỗi", { channel, eventType: event.type, status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    console.error("[broadcast] REST broadcast exception", {
      channel,
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Fallback hiếm khi dùng — mở tạm 1 kết nối Realtime để gửi rồi đóng ngay, có timeout chặn treo function. */
async function broadcastViaClient(channel: string, event: ServerEvent): Promise<void> {
  const supabase = createServiceRoleClient();
  const rt = supabase.channel(channel, { config: { broadcast: { self: false } } });

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      void supabase.removeChannel(rt);
      resolve();
    };
    const timer = setTimeout(finish, FALLBACK_TIMEOUT_MS);

    rt.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        rt.send({ type: "broadcast", event: event.type, payload: event }).finally(() => {
          clearTimeout(timer);
          finish();
        });
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(timer);
        finish();
      }
    });
  });
}
