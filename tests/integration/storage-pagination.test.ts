import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canRunDbTests, createAdminClient, createTestUser, deleteTestUsers, seedSession, throwOnError } from "./db-test-support";
import { listAllObjectNames, removeObjects } from "@/lib/storage/session-files";

/**
 * Storage pagination (H4) + nhận diện orphan (migration 0009) — chạy THẬT đối
 * đầu local Supabase stack, không mock. Opt-in qua SUPABASE_TEST_* → `pnpm test:db`.
 *
 * Test này tồn tại vì con số "100" trong H4 là giả định lan truyền qua nhiều
 * report mà CHƯA AI VERIFY. Ở đây upload 101 object thật rồi gọi `.list()` không
 * option để ĐO con số đó — mọi mock ở tầng `pnpm test` mô phỏng theo kết quả này.
 *
 * CHỈ dùng bucket `cv`: migration 0004 tạo sẵn nên có mặt ở mọi môi trường
 * (local/CI/prod), trong khi `exports` được tạo tay. Cơ chế phân trang và điều
 * kiện orphan không phụ thuộc bucket nào nên 1 bucket là đủ chứng minh.
 */

const suite = canRunDbTests ? describe : describe.skip;

const BUCKET = "cv";
/** > 100 để lộ đúng ngưỡng cắt mặc định của `.list()`. */
const TOTAL_OBJECTS = 101;
/** Con số ĐO ĐƯỢC ngày 2026-08-17 trên supabase local stack (storage-js không truyền option). */
const OBSERVED_DEFAULT_LIST_LIMIT = 100;
/** Bucket `cv` chặn mime type lạ (0004) — nội dung phải là PDF. */
const PDF_BYTES = Buffer.from("%PDF-1.4 storage-pagination-test\n%%EOF\n");

interface OrphanRow {
  bucket_id: string;
  object_name: string;
}

async function uploadObjects(admin: SupabaseClient, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 20) {
    const batch = paths.slice(i, i + 20);
    const results = await Promise.all(
      batch.map((path) =>
        admin.storage.from(BUCKET).upload(path, PDF_BYTES, { contentType: "application/pdf", upsert: true }),
      ),
    );
    for (const result of results) throwOnError(`upload ${BUCKET}`, result.error);
  }
}

async function listOrphanNames(admin: SupabaseClient, olderThan: string): Promise<string[]> {
  const { data, error } = await admin.rpc("list_orphan_storage_objects", {
    p_older_than: olderThan,
    p_limit: 5000,
  });
  throwOnError(`rpc list_orphan_storage_objects (${olderThan})`, error);
  return (data as OrphanRow[]).map((row) => row.object_name);
}

suite("Storage pagination + orphan detection (local stack)", () => {
  const suffix = Date.now();
  const email = `storage-pagination-${suffix}@example.com`;

  let admin: SupabaseClient;
  let userId: string;

  /** Session CÓ THẬT trong bảng `sessions` — file của nó KHÔNG được coi là orphan. */
  const liveSessionId = crypto.randomUUID();
  /** Session KHÔNG tồn tại — file dưới prefix này chính là orphan. */
  const orphanSessionId = crypto.randomUUID();
  /** Path rác: segment thứ 2 không phải uuid — cast `::uuid` sẽ làm CẢ query raise 22P02. */
  const junkPath = `not-a-uuid-${suffix}/also-not-a-uuid/junk.pdf`;

  let livePrefix: string;
  let orphanPath: string;
  let uploadedPaths: string[];

  beforeAll(async () => {
    admin = createAdminClient();
    userId = await createTestUser(admin, email);
    await seedSession(admin, { id: liveSessionId, userId, fields: { status: "done" } });

    livePrefix = `${userId}/${liveSessionId}`;
    orphanPath = `${userId}/${orphanSessionId}/orphan.pdf`;

    const liveFiles = Array.from(
      { length: TOTAL_OBJECTS },
      (_, i) => `${livePrefix}/file-${String(i).padStart(3, "0")}.pdf`,
    );
    uploadedPaths = [...liveFiles, orphanPath, junkPath];
    await uploadObjects(admin, uploadedPaths);
  }, 120000);

  afterAll(async () => {
    // Tự dọn: object Storage trước (không cascade theo user), rồi user (cascade sessions).
    await removeObjects(admin, BUCKET, uploadedPaths);
    await deleteTestUsers(admin, [userId]);
  }, 120000);

  test("test_storage_list_without_options_truncates_at_default_limit", async () => {
    // Arrange — 101 object thật dưới cùng 1 prefix

    // Act — gọi ĐÚNG như route cũ: không truyền option nào
    const { data, error } = await admin.storage.from(BUCKET).list(livePrefix);
    throwOnError("list không option", error);

    // Assert — đây LÀ con số gây ra H4: xoá session kiểu cũ chỉ chạm được 100 file đầu
    expect(data).toHaveLength(OBSERVED_DEFAULT_LIST_LIMIT);
    expect(data!.length).toBeLessThan(TOTAL_OBJECTS);
  }, 60000);

  test("test_list_all_object_names_paginates_until_every_object_is_returned", async () => {
    // Arrange

    // Act
    const names = await listAllObjectNames(admin, BUCKET, livePrefix);

    // Assert — đủ 101, không trùng, có cả file đầu lẫn file nằm sau ngưỡng 100
    expect(names).toHaveLength(TOTAL_OBJECTS);
    expect(new Set(names).size).toBe(TOTAL_OBJECTS);
    expect(names).toContain("file-000.pdf");
    expect(names).toContain("file-100.pdf");
  }, 60000);

  test("test_list_orphan_storage_objects_returns_object_without_matching_session_row", async () => {
    // Arrange — orphanPath nằm dưới sessionId không tồn tại trong bảng sessions

    // Act — p_older_than = 0 để bỏ lưới an toàn, xét cả object vừa upload
    const names = await listOrphanNames(admin, "0 seconds");

    // Assert
    expect(names).toContain(orphanPath);
  }, 60000);

  test("test_list_orphan_storage_objects_keeps_objects_of_an_existing_session", async () => {
    // Arrange — liveSessionId CÓ row thật trong `sessions`

    // Act
    const names = await listOrphanNames(admin, "0 seconds");

    // Assert — không được đụng file của session còn sống
    expect(names).not.toContain(`${livePrefix}/file-000.pdf`);
    expect(names).not.toContain(`${livePrefix}/file-100.pdf`);
  }, 60000);

  test("test_list_orphan_storage_objects_ignores_objects_newer_than_lookback_window", async () => {
    // Arrange — object vừa upload xong, trẻ hơn ngưỡng mặc định 24h

    // Act
    const names = await listOrphanNames(admin, "24 hours");

    // Assert — lưới chống race: upload đang diễn ra không bị dọn nhầm
    expect(names).not.toContain(orphanPath);
  }, 60000);

  test("test_list_orphan_storage_objects_does_not_raise_on_non_uuid_path_segment", async () => {
    // Arrange — junkPath có segment thứ 2 không phải uuid

    // Act — query phải chạy trót lọt (cast `path_tokens[2]::uuid` sẽ raise 22P02 ở đây)
    const names = await listOrphanNames(admin, "0 seconds");

    // Assert — rác vẫn được liệt kê để dọn, không làm chết cả job
    expect(names).toContain(junkPath);
  }, 60000);
});
