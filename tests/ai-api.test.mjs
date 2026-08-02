import assert from "node:assert/strict";
import test from "node:test";
import {
  extractResponseText,
  normalizeAiModel,
  requestStructuredVision,
  validateUserApiKey,
} from "../worker/ai.ts";

test("validates user-owned API keys and restricts model selection", () => {
  assert.equal(validateUserApiKey("sk-proj-abcdefghijklmnopqrstuvwxyz123456"), true);
  assert.equal(validateUserApiKey("not-a-key"), false);
  assert.equal(normalizeAiModel("gpt-5.6-terra"), "gpt-5.6-terra");
  assert.equal(normalizeAiModel("unknown-model"), "gpt-5.6-luna");
});

test("extracts structured text from Responses API output", () => {
  assert.equal(extractResponseText({ output_text: '{"ok":true}' }), '{"ok":true}');
  assert.equal(extractResponseText({ output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }] }), '{"ok":true}');
});

test("sends image input with structured output and does not store the response", async () => {
  let captured;
  const fetchImpl = async (_url, options) => {
    captured = options;
    return Response.json({ output_text: '{"weight":59.6}' });
  };
  const result = await requestStructuredVision({
    apiKey: "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    model: "gpt-5.6-luna",
    prompt: "read the visible value",
    images: ["data:image/jpeg;base64,ZmFrZQ=="],
    schemaName: "reading",
    schema: { type: "object", properties: {} },
    safetyIdentifier: "device-hash",
    fetchImpl,
  });

  assert.equal(result.weight, 59.6);
  const body = JSON.parse(captured.body);
  assert.equal(body.store, false);
  assert.equal(body.input[0].content[1].type, "input_image");
  assert.equal(body.text.format.type, "json_schema");
  assert.match(captured.headers.authorization, /^Bearer sk-/);
});
