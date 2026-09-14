import { createServer, type IncomingMessage } from "node:http";
import { answerHintFixture } from "./claude-fixtures";

/**
 * Mock Anthropic Messages API. App trỏ vào đây qua `ANTHROPIC_BASE_URL` (P07) và
 * vẫn dùng SDK @anthropic-ai/sdk THẬT, nên response phải đúng shape `Message`.
 *
 * Interview Hack (chỉ ứng viên) chỉ còn 1 tác vụ LLM: gợi ý trả lời — luôn trả
 * `answerHintFixture()` bất kể request (không còn cần định tuyến theo schema).
 */

const PORT = Number(process.argv[process.argv.indexOf("--port") + 1] ?? 55392);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function messageResponse(model: string, text: string): unknown {
  return {
    id: "msg_e2e_mock",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 800 },
  };
}

const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mock: "claude" }));
    return;
  }

  if (!req.url?.endsWith("/v1/messages") || req.method !== "POST") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "mock: route lạ" } }));
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "mock: body không phải JSON" } }));
    return;
  }

  const fixture = answerHintFixture();
  const text = JSON.stringify(fixture);
  const model = typeof body.model === "string" ? body.model : "claude-mock";

  console.log(`[mock-claude] ${model} → answer-hint`);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(messageResponse(model, text)));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-claude] listening on http://127.0.0.1:${PORT}`);
});
