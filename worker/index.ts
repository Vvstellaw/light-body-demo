/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  bodyAnalysisSchema,
  normalizeAiModel,
  OpenAIRequestError,
  requestStructuredVision,
  scaleSchema,
  validateUserApiKey,
} from "./ai";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  PHOTOS: R2Bucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const angles = new Set(["front", "side", "back"]);
const dataImagePattern = /^data:image\/(jpeg|png|webp);base64,/i;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

async function initializeDatabase(db: D1Database) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY NOT NULL, token_hash TEXT NOT NULL, created_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS body_records (owner_id TEXT NOT NULL, date TEXT NOT NULL, weight REAL NOT NULL, fat REAL, bmi REAL, muscle REAL, fasting INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (owner_id, date))"),
    db.prepare("CREATE TABLE IF NOT EXISTS body_photos (owner_id TEXT NOT NULL, date TEXT NOT NULL, angle TEXT NOT NULL, object_key TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (owner_id, date, angle))"),
    db.prepare("CREATE TABLE IF NOT EXISTS ai_coach_profiles (owner_id TEXT PRIMARY KEY NOT NULL, source_date TEXT, model TEXT NOT NULL, result_json TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS body_records_owner_date_idx ON body_records (owner_id, date)"),
    db.prepare("CREATE INDEX IF NOT EXISTS body_photos_owner_date_idx ON body_photos (owner_id, date)"),
  ]);
  const columns = await db.prepare("PRAGMA table_info(body_records)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "metrics_json")) {
    await db.prepare("ALTER TABLE body_records ADD COLUMN metrics_json TEXT").run();
  }
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function resolveOwner(request: Request, env: Env) {
  const signedInId = request.headers.get("oai-authenticated-user-id");
  if (signedInId) return `user:${signedInId}`;

  const deviceId = request.headers.get("x-light-device") ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const secret = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!/^[a-zA-Z0-9-]{20,80}$/.test(deviceId) || secret.length < 32) return null;

  const tokenHash = await sha256(secret);
  const existing = await env.DB.prepare("SELECT token_hash FROM devices WHERE id = ?").bind(deviceId).first<{ token_hash: string }>();
  if (existing && existing.token_hash !== tokenHash) return null;
  if (!existing) {
    await env.DB.prepare("INSERT INTO devices (id, token_hash, created_at) VALUES (?, ?, ?)")
      .bind(deviceId, tokenHash, new Date().toISOString()).run();
  }
  return `device:${deviceId}`;
}

function photoKey(ownerId: string, date: string, angle: string) {
  return `${encodeURIComponent(ownerId)}/${date}/${angle}.jpg`;
}

function aiHeaders(request: Request) {
  const apiKey = request.headers.get("x-openai-key") ?? "";
  if (!validateUserApiKey(apiKey)) {
    throw new OpenAIRequestError(400, "missing_user_api_key", "请先配置你自己的 OpenAI API Key");
  }
  return { apiKey, model: normalizeAiModel(request.headers.get("x-openai-model")) };
}

function ensureDataImage(value: unknown) {
  return typeof value === "string" && dataImagePattern.test(value) && value.length <= 7_000_000 ? value : null;
}

function parseJsonObject(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function recentRecordSummary(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(-14).map((record) => {
    if (!record || typeof record !== "object") return null;
    const item = record as Record<string, unknown>;
    return {
      date: String(item.date ?? "").slice(0, 10),
      weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : null,
      bodyFat: Number.isFinite(Number(item.fat)) ? Number(item.fat) : null,
      fasting: Boolean(item.fasting),
    };
  }).filter(Boolean);
}

function openAiError(error: unknown) {
  if (error instanceof OpenAIRequestError) {
    return json({ error: error.code, message: error.message }, error.status);
  }
  throw error;
}

async function handleApi(request: Request, env: Env, url: URL) {
  await initializeDatabase(env.DB);

  if (url.pathname === "/api/session") {
    return json({
      signedIn: Boolean(request.headers.get("oai-authenticated-user-id")),
      email: request.headers.get("oai-authenticated-user-email"),
    });
  }

  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return json({ error: "unauthorized" }, 401);

  if (url.pathname === "/api/state" && request.method === "GET") {
    const [recordResult, photoResult] = await Promise.all([
      env.DB.prepare("SELECT date, weight, fat, bmi, muscle, fasting, metrics_json FROM body_records WHERE owner_id = ? ORDER BY date")
        .bind(ownerId).all(),
      env.DB.prepare("SELECT date, angle FROM body_photos WHERE owner_id = ? ORDER BY date")
        .bind(ownerId).all(),
    ]);
    return json({
      records: recordResult.results.map((record) => ({
        ...record,
        metrics: parseJsonObject(record.metrics_json),
        metrics_json: undefined,
      })),
      photos: photoResult.results,
    });
  }

  if (url.pathname === "/api/state" && request.method === "DELETE") {
    const listed = await env.PHOTOS.list({ prefix: `${encodeURIComponent(ownerId)}/` });
    if (listed.objects.length) await env.PHOTOS.delete(listed.objects.map((object) => object.key));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM body_photos WHERE owner_id = ?").bind(ownerId),
      env.DB.prepare("DELETE FROM body_records WHERE owner_id = ?").bind(ownerId),
      env.DB.prepare("DELETE FROM ai_coach_profiles WHERE owner_id = ?").bind(ownerId),
    ]);
    return json({ ok: true });
  }

  if (url.pathname === "/api/records" && request.method === "POST") {
    const body = await request.json<Record<string, unknown>>();
    const date = String(body.date ?? "");
    const weight = Number(body.weight);
    if (!datePattern.test(date) || !Number.isFinite(weight) || weight < 20 || weight > 400) {
      return json({ error: "invalid_record" }, 400);
    }
    const nullableNumber = (value: unknown) => value == null || value === "" ? null : Number(value);
    const metricsJson = body.metrics && typeof body.metrics === "object" ? JSON.stringify(body.metrics).slice(0, 20_000) : null;
    await env.DB.prepare("INSERT INTO body_records (owner_id, date, weight, fat, bmi, muscle, fasting, metrics_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, date) DO UPDATE SET weight = excluded.weight, fat = excluded.fat, bmi = excluded.bmi, muscle = excluded.muscle, fasting = excluded.fasting, metrics_json = excluded.metrics_json, updated_at = excluded.updated_at")
      .bind(ownerId, date, weight, nullableNumber(body.fat), nullableNumber(body.bmi), nullableNumber(body.muscle), body.fasting ? 1 : 0, metricsJson, new Date().toISOString()).run();
    return json({ ok: true });
  }

  if (url.pathname === "/api/ai/scale" && request.method === "POST") {
    try {
      const { apiKey, model } = aiHeaders(request);
      const body = await request.json<Record<string, unknown>>();
      const image = ensureDataImage(body.image);
      if (!image) return json({ error: "invalid_image", message: "截图过大或格式不支持" }, 400);
      const result = await requestStructuredVision({
        apiKey,
        model,
        images: [image],
        schemaName: "body_scale_reading",
        schema: scaleSchema,
        safetyIdentifier: await sha256(ownerId),
        prompt: "读取这张体脂秤应用截图中的可见身体指标。只抄录画面中明确显示的数字和文字，不要推算、补全或根据其他指标计算。识别体重、体脂率、BMI、肌肉量和测量日期，并把其余可见指标放入 metrics。metrics.key 使用稳定英文键，例如 body_age、subcutaneous_fat、visceral_fat_index、body_water、skeletal_muscle_rate、bone_mass、protein_rate、basal_metabolism、fat_mass、water_mass、protein_mass、lean_body_mass、muscle_rate、standard_weight、body_type。看不清的值设为 null，并在 warnings 中说明。",
      });
      return json({ result, model });
    } catch (error) {
      return openAiError(error);
    }
  }

  if (url.pathname === "/api/ai/body-analysis" && request.method === "POST") {
    try {
      const { apiKey, model } = aiHeaders(request);
      const body = await request.json<Record<string, unknown>>();
      const imageInput = body.images && typeof body.images === "object" ? body.images as Record<string, unknown> : {};
      const front = ensureDataImage(imageInput.front);
      const side = ensureDataImage(imageInput.side);
      const back = ensureDataImage(imageInput.back);
      if (!front || !side) return json({ error: "missing_angles", message: "请至少提供正面和侧面照片" }, 400);
      const profile = body.profile && typeof body.profile === "object" ? body.profile : {};
      const records = recentRecordSummary(body.records);
      const result = await requestStructuredVision({
        apiKey,
        model,
        images: [front, side, ...(back ? [back] : [])],
        schemaName: "fitness_body_analysis",
        schema: bodyAnalysisSchema,
        safetyIdentifier: await sha256(ownerId),
        prompt: `你是一名谨慎的通用健身教练。根据用户自愿上传的正面、侧面${back ? "、背面" : ""}全身照片，以及以下个人记录，给出训练用途的体型倾向观察和一周计划。个人资料：${JSON.stringify(profile)}。最近记录：${JSON.stringify(records)}。不要诊断疾病，不要从照片估算精确体脂率、内脏脂肪或健康风险，不要评价吸引力、种族、年龄等敏感属性。体型倾向必须写成“苹果型倾向”“梨型倾向”“均衡型倾向”或“暂不确定”，并明确照片分析有局限。计划保持克制：每周 3 次力量、2 次低强度有氧、2 次恢复；今日动作仅使用 squat、row、bridge 三个 id，并根据观察调整组数、次数和动作要点。饮食只给一般性建议，禁止极端节食。若照片不足以可靠判断，把 confidence 调低并在 caveats 说明。`,
      });
      await env.DB.prepare("INSERT INTO ai_coach_profiles (owner_id, source_date, model, result_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET source_date = excluded.source_date, model = excluded.model, result_json = excluded.result_json, updated_at = excluded.updated_at")
        .bind(ownerId, datePattern.test(String(body.sourceDate ?? "")) ? String(body.sourceDate) : null, model, JSON.stringify(result), new Date().toISOString()).run();
      return json({ result, model });
    } catch (error) {
      return openAiError(error);
    }
  }

  if (url.pathname === "/api/ai/profile" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT source_date, model, result_json, updated_at FROM ai_coach_profiles WHERE owner_id = ?")
      .bind(ownerId).first<{ source_date: string | null; model: string; result_json: string; updated_at: string }>();
    if (!row) return json({ profile: null });
    return json({ profile: { sourceDate: row.source_date, model: row.model, updatedAt: row.updated_at, result: JSON.parse(row.result_json) } });
  }

  if (url.pathname === "/api/ai/profile" && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM ai_coach_profiles WHERE owner_id = ?").bind(ownerId).run();
    return json({ ok: true });
  }

  const recordMatch = url.pathname.match(/^\/api\/records\/(\d{4}-\d{2}-\d{2})$/);
  if (recordMatch && request.method === "DELETE") {
    const date = recordMatch[1];
    const photoRows = await env.DB.prepare("SELECT object_key FROM body_photos WHERE owner_id = ? AND date = ?")
      .bind(ownerId, date).all<{ object_key: string }>();
    if (photoRows.results.length) await env.PHOTOS.delete(photoRows.results.map((row) => row.object_key));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM body_photos WHERE owner_id = ? AND date = ?").bind(ownerId, date),
      env.DB.prepare("DELETE FROM body_records WHERE owner_id = ? AND date = ?").bind(ownerId, date),
    ]);
    return json({ ok: true });
  }

  const photoMatch = url.pathname.match(/^\/api\/photos\/(\d{4}-\d{2}-\d{2})\/(front|side|back)$/);
  if (photoMatch && request.method === "POST") {
    const [, date, angle] = photoMatch;
    const contentType = request.headers.get("content-type") ?? "";
    const body = await request.arrayBuffer();
    if (!contentType.startsWith("image/") || body.byteLength === 0 || body.byteLength > 5_000_000) {
      return json({ error: "invalid_photo" }, 400);
    }
    const objectKey = photoKey(ownerId, date, angle);
    await env.PHOTOS.put(objectKey, body, { httpMetadata: { contentType } });
    await env.DB.prepare("INSERT INTO body_photos (owner_id, date, angle, object_key, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_id, date, angle) DO UPDATE SET object_key = excluded.object_key, updated_at = excluded.updated_at")
      .bind(ownerId, date, angle, objectKey, new Date().toISOString()).run();
    return json({ ok: true });
  }

  if (photoMatch && request.method === "GET") {
    const [, date, angle] = photoMatch;
    if (!angles.has(angle)) return json({ error: "not_found" }, 404);
    const row = await env.DB.prepare("SELECT object_key FROM body_photos WHERE owner_id = ? AND date = ? AND angle = ?")
      .bind(ownerId, date, angle).first<{ object_key: string }>();
    if (!row) return json({ error: "not_found" }, 404);
    const object = await env.PHOTOS.get(row.object_key);
    if (!object) return json({ error: "not_found" }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("cache-control", "private, max-age=3600");
    return new Response(object.body, { headers });
  }

  return json({ error: "not_found" }, 404);
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/fit-demo")) {
      return Response.redirect(new URL("/fit-demo.html", url), 302);
    }

    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      return Response.redirect(new URL("/favicon.svg", url), 302);
    }

    if (request.method === "GET" && (url.pathname === "/apple-touch-icon.png" || url.pathname === "/apple-touch-icon-precomposed.png")) {
      return Response.redirect(new URL("/assets/app-icon-180.png", url), 302);
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        console.error("Light Body API error", error);
        return json({ error: "server_error" }, 500);
      }
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
