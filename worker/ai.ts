export const DEFAULT_AI_MODEL = "gpt-5.6-luna";

export const supportedAiModels = new Set([
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
]);

export class OpenAIRequestError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "OpenAIRequestError";
    this.status = status;
    this.code = code;
  }
}

export function normalizeAiModel(value: string | null | undefined) {
  return value && supportedAiModels.has(value) ? value : DEFAULT_AI_MODEL;
}

export function validateUserApiKey(value: string | null | undefined) {
  return Boolean(value && value.length <= 300 && /^sk-[A-Za-z0-9_-]{20,}$/.test(value));
}

export function extractResponseText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as { content?: unknown[] }).content)
      ? (item as { content: unknown[] }).content
      : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) return text;
    }
  }
  throw new OpenAIRequestError(502, "empty_model_response", "AI 没有返回可用结果，请重试");
}

type JsonSchema = Record<string, unknown>;
type VisionContent = Array<Record<string, unknown>>;

export async function requestStructuredVision(options: {
  apiKey: string;
  model?: string | null;
  prompt: string;
  images: string[];
  schemaName: string;
  schema: JsonSchema;
  safetyIdentifier: string;
  fetchImpl?: typeof fetch;
}) {
  if (!validateUserApiKey(options.apiKey)) {
    throw new OpenAIRequestError(400, "invalid_api_key_format", "API Key 格式不正确");
  }
  if (!options.images.length || options.images.some((image) => !/^data:image\/(jpeg|png|webp);base64,/i.test(image))) {
    throw new OpenAIRequestError(400, "invalid_image", "图片格式不支持，请使用 JPG、PNG 或 WebP");
  }

  const content: VisionContent = [{ type: "input_text", text: options.prompt }];
  for (const image of options.images) {
    content.push({ type: "input_image", image_url: image, detail: "high" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: normalizeAiModel(options.model),
        input: [{ role: "user", content }],
        reasoning: { effort: "low" },
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: options.schemaName,
            strict: true,
            schema: options.schema,
          },
        },
        safety_identifier: options.safetyIdentifier,
        store: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new OpenAIRequestError(504, "model_timeout", "AI 分析超时，请稍后重试");
    }
    throw new OpenAIRequestError(502, "model_unreachable", "暂时无法连接 AI 服务，请检查网络后重试");
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok) {
    const apiError = payload.error && typeof payload.error === "object"
      ? payload.error as { code?: unknown; message?: unknown }
      : {};
    const code = typeof apiError.code === "string" ? apiError.code : "openai_request_failed";
    const message = response.status === 401
      ? "API Key 无效或已失效"
      : response.status === 429
        ? "当前 API 额度不足或请求过多"
        : typeof apiError.message === "string"
          ? apiError.message.slice(0, 180)
          : "AI 服务返回错误，请稍后重试";
    throw new OpenAIRequestError(response.status, code, message);
  }

  const text = extractResponseText(payload);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new OpenAIRequestError(502, "invalid_model_json", "AI 返回的数据格式异常，请重试");
  }
}

export const scaleSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["weight", "body_fat", "bmi", "muscle_mass", "measurement_date", "metrics", "confidence", "warnings"],
  properties: {
    weight: { type: ["number", "null"] },
    body_fat: { type: ["number", "null"] },
    bmi: { type: ["number", "null"] },
    muscle_mass: { type: ["number", "null"] },
    measurement_date: { type: ["string", "null"] },
    metrics: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "label", "value", "unit", "confidence"],
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          value: { type: ["number", "string", "null"] },
          unit: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    warnings: { type: "array", maxItems: 5, items: { type: "string" } },
  },
};

export const bodyAnalysisSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["shape_tendency", "confidence", "summary", "observations", "priorities", "week_plan", "today_workout", "nutrition", "caveats"],
  properties: {
    shape_tendency: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string" },
    observations: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
    priorities: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "reason"],
        properties: { title: { type: "string" }, reason: { type: "string" } },
      },
    },
    week_plan: {
      type: "array",
      minItems: 7,
      maxItems: 7,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["day", "label", "focus", "duration_minutes"],
        properties: {
          day: { type: "string" },
          label: { type: "string" },
          focus: { type: "string" },
          duration_minutes: { type: "integer", minimum: 10, maximum: 90 },
        },
      },
    },
    today_workout: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "sets", "reps", "target", "cue", "avoid"],
        properties: {
          id: { type: "string", enum: ["squat", "row", "bridge"] },
          name: { type: "string" },
          sets: { type: "integer", minimum: 2, maximum: 5 },
          reps: { type: "string" },
          target: { type: "string" },
          cue: { type: "string" },
          avoid: { type: "string" },
        },
      },
    },
    nutrition: { type: "array", minItems: 2, maxItems: 3, items: { type: "string" } },
    caveats: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
  },
};
