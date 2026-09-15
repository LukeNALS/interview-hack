import { readLocalSupabase } from "./local-supabase";

/**
 * Đọc mail THẬT từ Mailpit của local Supabase stack (API v1: /api/v1/messages
 * + /api/v1/message/{ID}). KHÔNG mock — test-standards bắt e2e đi qua mail thật.
 */

interface MailpitListItem {
  ID: string;
  To: { Address: string }[];
  Subject: string;
  Created: string;
}

interface MailpitListResponse {
  messages: MailpitListItem[];
}

interface MailpitMessageDetail {
  HTML: string;
  Text: string;
}

export interface ReceivedMail {
  subject: string;
  /** Nội dung HTML (fallback Text). */
  content: string;
}

/** Poll Mailpit tới khi có ít nhất `count` mail gửi cho `to`; trả theo thứ tự CŨ → MỚI. */
export async function waitForMailsTo(to: string, count: number, timeoutMs = 15_000): Promise<ReceivedMail[]> {
  const { mailpitUrl } = readLocalSupabase();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const listRes = await fetch(`${mailpitUrl}/api/v1/messages?limit=50`);
    const list = (await listRes.json()) as MailpitListResponse;
    const hits = list.messages
      .filter((m) => m.To?.some((t) => t.Address === to))
      .sort((a, b) => Date.parse(a.Created) - Date.parse(b.Created));
    if (hits.length >= count) {
      return Promise.all(
        hits.map(async (hit) => {
          const detailRes = await fetch(`${mailpitUrl}/api/v1/message/${hit.ID}`);
          const detail = (await detailRes.json()) as MailpitMessageDetail;
          return { subject: hit.Subject, content: detail.HTML || detail.Text };
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`E2E: không thấy đủ ${count} mail tới ${to} trong ${timeoutMs}ms (Mailpit).`);
}

/** Poll Mailpit tới khi có mail gửi cho `to`, trả nội dung mail MỚI NHẤT. */
export async function waitForMailTo(to: string, timeoutMs = 15_000): Promise<string> {
  const mails = await waitForMailsTo(to, 1, timeoutMs);
  return mails[mails.length - 1].content;
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
