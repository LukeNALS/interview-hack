import { readLocalSupabase } from "./local-supabase";

/**
 * Đọc mail THẬT từ Mailpit của local Supabase stack (API v1: /api/v1/messages
 * + /api/v1/message/{ID}). KHÔNG mock — test-standards bắt e2e đi qua mail thật.
 */

interface MailpitListItem {
  ID: string;
  To: { Address: string }[];
}

interface MailpitListResponse {
  messages: MailpitListItem[];
}

interface MailpitMessageDetail {
  HTML: string;
  Text: string;
}

/** Poll Mailpit tới khi có mail gửi cho `to`, trả nội dung HTML (fallback Text). */
export async function waitForMailTo(to: string, timeoutMs = 15_000): Promise<string> {
  const { mailpitUrl } = readLocalSupabase();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const listRes = await fetch(`${mailpitUrl}/api/v1/messages?limit=50`);
    const list = (await listRes.json()) as MailpitListResponse;
    const hit = list.messages.find((m) => m.To?.some((t) => t.Address === to));
    if (hit) {
      const detailRes = await fetch(`${mailpitUrl}/api/v1/message/${hit.ID}`);
      const detail = (await detailRes.json()) as MailpitMessageDetail;
      return detail.HTML || detail.Text;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`E2E: không thấy mail tới ${to} trong ${timeoutMs}ms (Mailpit).`);
}

/** Trích link `/auth/confirm?token_hash=...&type=<type>` từ nội dung mail. */
export function extractConfirmLink(mailContent: string, type: string): string {
  const pattern = new RegExp(`href="([^"]*\\/auth\\/confirm\\?token_hash=[^"&]+&type=${type})"`);
  const match = mailContent.match(pattern);
  if (!match) {
    throw new Error(`E2E: không tìm thấy link xác nhận type=${type} trong nội dung mail.`);
  }
  return match[1].replace(/&amp;/g, "&");
}
