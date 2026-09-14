import { useSessionStore } from "@/stores/session-store";
import type { Speaker } from "@/types/events";
import type { UttLang } from "@/types/ui";

function langToUttLang(lang: string | null | undefined): UttLang {
  if (lang === "ja") return "JA";
  if (lang === "en") return "EN";
  return "VI";
}

function speakerToPv(speaker: Speaker): 0 | 1 {
  return speaker === "interviewer" ? 1 : 0;
}

function coalesce(value: string | null | undefined, fallback: string): string {
  return value ?? fallback;
}

export function readTranslations(json: unknown): { vi?: string | null; ja?: string | null; en?: string | null } {
  if (!json || typeof json !== "object") return {};
  return json as { vi?: string | null; ja?: string | null; en?: string | null };
}

export function resolveDirectSpeaker(map: Map<string, Speaker>, rawSpeaker: string | null): Speaker {
  if (!rawSpeaker) return "interviewer";
  const existing = map.get(rawSpeaker);
  if (existing) return existing;
  const assigned: Speaker = map.size === 0 ? "interviewer" : "candidate";
  map.set(rawSpeaker, assigned);
  return assigned;
}

interface UpsertInput {
  id: number;
  speaker: Speaker;
  lang: string | null;
  text_orig: string;
  translations: { vi?: string | null; ja?: string | null; en?: string | null };
  time: string;
  partial: boolean;
  /** Có ở bản sinh từ stream và ở row server — khoá để nối hai bản làm một. */
  clientUttId?: string | null;
}

/**
 * Upsert theo id (seq server, hoặc id tạm ÂM khi còn partial/chưa có seq).
 *
 * Dedupe theo id KHÔNG đủ: bản local mang id âm, bản broadcast/backfill mang `seq` dương —
 * cùng một câu nói nhưng hai id khác nhau nên lọt thành hai bubble (đo 2026-08-24: mỗi câu
 * hiện 2 lần, một bản timestamp "00:00:23", một bản "00:23"). `idMap` nối hai bản qua
 * `client_utt_id`: thấy bản cũ thì ĐỔI id của nó sang seq thay vì chèn bản mới.
 */
export function upsertUtterance(u: UpsertInput, idMap?: Map<string, number>): void {
  const store = useSessionStore.getState();
  const payload = {
    id: u.id,
    pv: speakerToPv(u.speaker),
    lang: langToUttLang(u.lang),
    orig: u.text_orig,
    vi: coalesce(u.translations.vi, u.text_orig),
    ja: coalesce(u.translations.ja, u.text_orig),
    en: coalesce(u.translations.en, u.text_orig),
    disp: u.text_orig,
    partial: u.partial,
    time: u.time,
  };
  const priorId = u.clientUttId ? idMap?.get(u.clientUttId) : undefined;
  if (priorId !== undefined && priorId !== u.id && store.utts.some((x) => x.id === priorId)) {
    store.patchUtt(priorId, payload); // payload.id = u.id ⇒ bản cũ nhận luôn seq thật
    idMap?.set(u.clientUttId as string, u.id);
    return;
  }

  const exists = store.utts.some((x) => x.id === u.id);
  if (exists) store.patchUtt(u.id, payload);
  else store.appendUtt(payload);
  if (u.clientUttId) idMap?.set(u.clientUttId, u.id);
}
