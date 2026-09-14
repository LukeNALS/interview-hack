"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppLogo } from "@/components/common/app-header";
import { Toast } from "@/components/common/toast";
import { fetchJson } from "@/hooks/use-session";
import { useToast } from "@/hooks/use-toast";

/** Row từ GET /api/admin/users — service-role sau requireAdmin, KHÔNG đọc thẳng PostgREST. */
interface AdminUserRow {
  id: string;
  email: string;
  plan: string;
  free_sessions_left: number;
  created_at: string;
  session_count: number;
}

/**
 * Bảng Users admin phase 01: email · plan · quota free · ngày tạo · số buổi,
 * sửa inline quota/plan qua PATCH /api/admin/users/:id. Token sẵn có, không lib table.
 */
export function AdminUsersTable() {
  const queryClient = useQueryClient();
  const { toast, showToast } = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [quotaInput, setQuotaInput] = useState("");
  const [planInput, setPlanInput] = useState("");

  const users = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => fetchJson<{ users: AdminUserRow[] }>("/api/admin/users").then((b) => b.users),
    retry: false,
  });

  const patchUser = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { free_sessions_left?: number; plan?: string } }) =>
      fetchJson<{ user: AdminUserRow }>(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      showToast("Đã lưu");
      setEditingId(null);
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      // Nếu admin tự sửa quota của chính mình thì badge "CÒN N BUỔI FREE" phải đọc lại.
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    onError: () => showToast("Lưu thất bại — thử lại"),
  });

  const startEdit = (u: AdminUserRow) => {
    setEditingId(u.id);
    setQuotaInput(String(u.free_sessions_left));
    setPlanInput(u.plan);
  };

  const save = (u: AdminUserRow) => {
    const quota = Number(quotaInput);
    if (!Number.isInteger(quota) || quota < 0 || quota > 999) {
      showToast("Quota phải là số nguyên 0-999");
      return;
    }
    const body: { free_sessions_left?: number; plan?: string } = {};
    if (quota !== u.free_sessions_left) body.free_sessions_left = quota;
    if (planInput.trim() !== u.plan) body.plan = planInput.trim();
    if (body.free_sessions_left === undefined && body.plan === undefined) {
      setEditingId(null);
      return;
    }
    patchUser.mutate({ id: u.id, body });
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex min-h-[62px] flex-none items-center gap-[14px] border-b border-divider bg-app/85 px-7 py-2">
        <AppLogo />
        <span className="h-[18px] w-px bg-control" />
        <span className="text-[11px] tracking-[.1em] text-muted">ADMIN · USERS</span>
      </header>
      <main className="mx-auto w-full max-w-[980px] flex-1 px-6 pb-16 pt-8">
        {users.isLoading ? <div className="text-[14px] text-secondary">Đang tải danh sách user…</div> : null}
        {users.isError ? (
          <div className="text-[14px] text-secondary">Không tải được danh sách user — thử tải lại trang.</div>
        ) : null}
        {users.data ? (
          <div className="overflow-x-auto rounded-btn-lg border border-divider">
            <table className="w-full border-collapse text-[13.5px]">
              <thead>
                <tr className="border-b border-divider text-left text-[11px] tracking-[.12em] text-label">
                  <th className="px-4 py-3 font-bold">EMAIL</th>
                  <th className="px-4 py-3 font-bold">PLAN</th>
                  <th className="px-4 py-3 font-bold">BUỔI FREE CÒN</th>
                  <th className="px-4 py-3 font-bold">SỐ BUỔI ĐÃ TẠO</th>
                  <th className="px-4 py-3 font-bold">NGÀY TẠO</th>
                  <th className="px-4 py-3 font-bold" aria-label="Thao tác" />
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => (
                  <tr key={u.id} className="border-b border-divider/60 text-secondary last:border-b-0">
                    <td className="px-4 py-3 text-bright">{u.email}</td>
                    <td className="px-4 py-3">
                      {editingId === u.id ? (
                        <input
                          aria-label={`Plan của ${u.email}`}
                          value={planInput}
                          onChange={(e) => setPlanInput(e.target.value)}
                          className="w-24 rounded-btn border border-control bg-transparent px-2 py-1 text-[13px] text-bright"
                        />
                      ) : (
                        u.plan
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {editingId === u.id ? (
                        <input
                          aria-label={`Buổi free còn của ${u.email}`}
                          type="number"
                          min={0}
                          max={999}
                          value={quotaInput}
                          onChange={(e) => setQuotaInput(e.target.value)}
                          className="w-20 rounded-btn border border-control bg-transparent px-2 py-1 text-[13px] text-bright"
                        />
                      ) : (
                        u.free_sessions_left
                      )}
                    </td>
                    <td className="px-4 py-3">{u.session_count}</td>
                    <td className="px-4 py-3">{new Date(u.created_at).toLocaleDateString("vi-VN")}</td>
                    <td className="px-4 py-3 text-right">
                      {editingId === u.id ? (
                        <span className="inline-flex gap-2">
                          <button
                            type="button"
                            onClick={() => save(u)}
                            disabled={patchUser.isPending}
                            className="cursor-pointer rounded-chip-lg border border-accent/55 px-3 py-1 text-[12.5px] font-semibold text-accent-hover hover:bg-label/20 disabled:opacity-60"
                          >
                            Lưu
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="cursor-pointer rounded-chip-lg border border-control px-3 py-1 text-[12.5px] font-semibold text-bright hover:border-muted"
                          >
                            Huỷ
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEdit(u)}
                          className="cursor-pointer rounded-chip-lg border border-control px-3 py-1 text-[12.5px] font-semibold text-bright hover:border-muted"
                        >
                          Sửa
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </main>
      <Toast message={toast} />
    </div>
  );
}
