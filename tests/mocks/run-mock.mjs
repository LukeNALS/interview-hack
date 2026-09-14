import { registerHooks } from "node:module";

/**
 * Launcher cho mock server viết bằng TypeScript.
 *
 * Vì sao cần file .mjs này: Node ESM đòi phần mở rộng tường minh khi import
 * (`./ws-protocol.ts`), nhưng `tsc` từ chối đúng dạng đó (TS5097 —
 * `allowImportingTsExtensions` chưa bật, mà tsconfig.json không thuộc phạm vi sửa
 * của P07). Hook `resolve` dưới đây gắn đuôi `.ts` khi Node resolve hụt, nhờ vậy
 * module mock giữ nguyên import không đuôi (tsc xanh) mà `node` vẫn chạy được.
 * File .mjs không nằm trong `include` của tsconfig nên bản thân nó không bị typecheck.
 *
 * Dùng: node tests/mocks/run-mock.mjs <tên-module> [--port N]
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const name = process.argv[2];
if (!name || !/^[a-z-]+$/.test(name)) {
  console.error("run-mock: thiếu/không hợp lệ tên module. Ví dụ: node tests/mocks/run-mock.mjs claude-server --port 55392");
  process.exit(1);
}

await import(`./${name}.ts`);
