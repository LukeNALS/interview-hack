"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateSessionInput } from "@/types/api";
import type { InterviewMode, SessionStatus } from "@/types/ui";

/** Lỗi API chuẩn hoá — giữ `code` để caller phân biệt (vd `question_gen_timeout`). */
export class ApiError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "ApiError";
    this.code = code;
  }
}

/** fetch + parse JSON dùng chung cho mọi hook P04 — throw ApiError khi !res.ok. */
export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = body as { error?: { code: string; message?: string } } | null;
    throw new ApiError(err?.error?.code ?? "unknown_error", err?.error?.message);
  }
  return body as T;
}

export interface ApiSession {
  id: string;
  status: SessionStatus;
  mode: InterviewMode;
  /** Chế độ buổi (0015): interviewer (mặc định) | candidate (gợi ý trả lời, không report). */
  kind: "interviewer" | "candidate";
  candidate_name: string | null;
  position: string | null;
  created_at: string;
  /** P05 — GET /sessions/:id thật trả rộng hơn 5 field cũ (BE report Unresolved #2). */
  started_at: string | null;
  ended_at: string | null;
  recording_started_at: string | null;
  cap_seconds: number;
  ended_reason: string | null;
  translation_lang: string;
  last_seq: number;
  /** P07 — hạn xóa tự động theo `profiles.retention_days` (chỉ có ở GET detail/list). */
  expires_at?: string;
}

/** Tạo session mới (status='prep') — gọi khi rời màn /candidate sang buổi thật. */
export function useCreateSession() {
  return useMutation({
    mutationFn: async (input: CreateSessionInput) => {
      const body = await fetchJson<{ session: ApiSession }>("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return body.session;
    },
  });
}

/**
 * Đọc session hiện tại — dùng cho guard route theo status thật + timer/cap
 * màn live (P05: `GET /api/sessions/:id` đã triển khai thật, xem
 * `phase-05-be-report.md`).
 */
export function useSession(sessionId: string | null) {
  return useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => fetchJson<{ session: ApiSession }>(`/api/sessions/${sessionId}`).then((b) => b.session),
    enabled: Boolean(sessionId),
    retry: false,
  });
}

export interface StartSessionResult {
  started_at: string;
  cap_seconds: number;
  /** Chế độ đã CHỐT phía server (BUG #4) — client seed lại cache để màn live đọc đúng. */
  mode: InterviewMode;
}

export interface StartSessionInput {
  /** Chế độ user chọn ở màn setup; bỏ trống = giữ nguyên mode lúc tạo session. */
  mode?: InterviewMode;
}

/** POST /start — trừ quota + set status='live'. Caller (setup screen) tự persist clock_offset ngay sau khi resolve (§Architecture trục thời gian, fix B14). */
export function useStartSession(sessionId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StartSessionInput = {}) => {
      if (!sessionId) throw new Error("Chưa có session để bắt đầu buổi");
      return fetchJson<StartSessionResult>(`/api/sessions/${sessionId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: input.mode }),
      });
    },
    onSuccess: (result) => {
      // BUG #3 (nguồn gây mount kép): chỉ invalidate thì cache còn giữ status='prep' vài
      // trăm ms sau khi push sang /live -> SessionScreenGuard đá về /candidate rồi refetch xong
      // lại đá ngược sang /live, LiveScreen mount 2 lần. Seed thẳng kết quả /start vào cache
      // để guard thấy 'live' NGAY ở lần render đầu.
      queryClient.setQueryData<ApiSession>(["session", sessionId], (old) =>
        old
          ? {
              ...old,
              status: "live",
              started_at: result.started_at,
              cap_seconds: result.cap_seconds,
              mode: result.mode ?? old.mode,
            }
          : old,
      );
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      // /start trừ 1 buổi free → badge "CÒN N BUỔI FREE" (useMe) phải đọc lại,
      // không thì user thấy số cũ tới tận lần refetch sau (P07).
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

/**
 * POST /end — chốt buổi thẳng status='done' (Interview Hack chỉ ứng viên,
 * không còn report job). Caller (cap countdown / ingest 409 handler / nút
 * "Kết thúc") PHẢI tự bắt lỗi và vẫn điều hướng về `/candidate` (best-effort).
 * KHÔNG throw ra ngoài UI.
 */
export function useEndSession(sessionId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error("Chưa có session để kết thúc buổi");
      return fetchJson<unknown>(`/api/sessions/${sessionId}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    },
    onSettled: () => {
      // Buổi < 5' được hoàn quota → badge phải đọc lại. Dùng onSettled chứ không
      // onSuccess: /end có thể trả lỗi sau khi đã hoàn quota, badge vẫn phải đúng.
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

const CLOCK_OFFSET_STORAGE_PREFIX = "interview-hack:clock-offset:";

/** localStorage key theo session_id (§Architecture "Persist clock_offset", fix B14). */
export function clockOffsetStorageKey(sessionId: string): string {
  return `${CLOCK_OFFSET_STORAGE_PREFIX}${sessionId}`;
}

/** Ghi `clock_offset = t0_local - started_at_server` ngay sau khi /start resolve. */
export function persistClockOffset(sessionId: string, clockOffsetMs: number): void {
  try {
    window.localStorage.setItem(clockOffsetStorageKey(sessionId), String(clockOffsetMs));
  } catch {
    // localStorage không khả dụng (Safari private mode, quota...) — reload giữa
    // buổi sẽ rơi về nhánh "coi như reconnect mới" (bước 16), không crash.
  }
}

/** Đọc lại clock_offset đã persist — null nếu chưa có (session mới/localStorage trống). */
export function readPersistedClockOffset(sessionId: string): number | null {
  try {
    const raw = window.localStorage.getItem(clockOffsetStorageKey(sessionId));
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
