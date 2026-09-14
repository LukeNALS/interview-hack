/**
 * Helper dùng chung cho mọi chỗ phải QUÉT + XOÁ object Storage theo session
 * (DELETE /api/sessions/:id và cron dọn orphan) — layout path phẳng
 * `${userId}/${sessionId}/<file>` (xem storage/cv.ts, storage/export-files.ts).
 *
 * VÌ SAO TỒN TẠI (P07 fix H4): `.list(prefix)` KHÔNG truyền option bị storage-js
 * cắt ở 100 object đầu (con số verify thực nghiệm trong
 * tests/integration/storage-pagination.test.ts). Session nhiều file hơn thế:
 * route xoá 100 file đầu rồi xoá row `sessions` → phần dư MỒ CÔI VĨNH VIỄN, vì
 * `list_expired_sessions`/`purge_sessions` đều join từ `sessions` mà session đã
 * biến mất — không còn gì trên đời trỏ tới đám file đó nữa (thủng AC6).
 *
 * KHÔNG `import "server-only"`: module không đọc secret nào, chỉ thao tác trên
 * client được TRUYỀN VÀO — nhờ vậy test tầng db import trực tiếp được để chạy
 * đối đầu local stack.
 */

/** Bucket lưu file theo session — dùng chung cho route DELETE và cron orphan. */
export const SESSION_STORAGE_BUCKETS = ["cv", "exports"] as const;

/** Số object xin mỗi trang `.list()`. */
const LIST_PAGE_SIZE = 1000;

/** Số path mỗi lần `.remove()` — tránh nhồi 1 request khổng lồ khi session có hàng nghìn file. */
const REMOVE_BATCH_SIZE = 100;

interface StorageEntry {
  name: string;
  /** `null` = entry THƯ MỤC, không phải object thật. */
  id?: string | null;
}

/**
 * Chỉ cần phần `storage` của Supabase client — nhờ vậy nhận được cả client
 * typed (`SupabaseClient<Database>` từ createServiceRoleClient) lẫn client thô
 * của test tầng db, không phải kéo generic `Database` vào đây.
 */
export interface StorageClientLike {
  storage: {
    from(bucket: string): {
      list(
        path?: string,
        options?: { limit?: number; offset?: number },
      ): Promise<{ data: StorageEntry[] | null; error: { message: string } | null }>;
      remove(paths: string[]): Promise<{ data: unknown; error: { message: string } | null }>;
    };
  };
}

/**
 * Tên mọi object dưới `prefix` (KHÔNG kèm prefix), phân trang tới hết.
 *
 * Dừng khi trang trả về RỖNG chứ không phải khi `< LIST_PAGE_SIZE`: nếu server
 * tự cap `limit` xuống thấp hơn mức xin, điều kiện "< limit" sẽ dừng sớm và bỏ
 * sót đúng cái mà hàm này sinh ra để chống. Vòng lặp luôn kết thúc vì mỗi vòng
 * không rỗng đều đẩy `offset` lên ít nhất 1.
 *
 * @throws Error khi Storage lỗi — người gọi quyết định map sang HTTP status nào.
 */
export async function listAllObjectNames(
  client: StorageClientLike,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const names: string[] = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await client.storage.from(bucket).list(prefix, {
      limit: LIST_PAGE_SIZE,
      offset,
    });
    if (error) {
      throw new Error(`storage list ${bucket} lỗi: ${error.message}`);
    }
    const page = data ?? [];
    for (const entry of page) {
      // Layout của repo là phẳng nên không kỳ vọng có thư mục con, nhưng lọc cho
      // chắc: `.remove()` một "thư mục" không xoá gì mà vẫn tốn 1 slot lô.
      if (entry.id === null) continue;
      names.push(entry.name);
    }
    if (page.length === 0) break;
    offset += page.length;
  }

  return names;
}

/**
 * Xoá theo lô. Lỗi ở lô nào cũng dừng luôn (người gọi coi như "xoá storage thất
 * bại" và GIỮ nguyên dữ liệu DB để lần sau thử lại) — thà sót file còn hơn xoá
 * row rồi mất dấu file.
 *
 * @throws Error khi Storage lỗi.
 */
export async function removeObjects(
  client: StorageClientLike,
  bucket: string,
  paths: string[],
): Promise<void> {
  for (let i = 0; i < paths.length; i += REMOVE_BATCH_SIZE) {
    const batch = paths.slice(i, i + REMOVE_BATCH_SIZE);
    const { error } = await client.storage.from(bucket).remove(batch);
    if (error) {
      throw new Error(`storage remove ${bucket} lỗi: ${error.message}`);
    }
  }
}
