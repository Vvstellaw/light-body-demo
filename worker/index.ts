/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

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

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

async function initializeDatabase(db: D1Database) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY NOT NULL, token_hash TEXT NOT NULL, created_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS body_records (owner_id TEXT NOT NULL, date TEXT NOT NULL, weight REAL NOT NULL, fat REAL, bmi REAL, muscle REAL, fasting INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (owner_id, date))"),
    db.prepare("CREATE TABLE IF NOT EXISTS body_photos (owner_id TEXT NOT NULL, date TEXT NOT NULL, angle TEXT NOT NULL, object_key TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (owner_id, date, angle))"),
    db.prepare("CREATE INDEX IF NOT EXISTS body_records_owner_date_idx ON body_records (owner_id, date)"),
    db.prepare("CREATE INDEX IF NOT EXISTS body_photos_owner_date_idx ON body_photos (owner_id, date)"),
  ]);
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
      env.DB.prepare("SELECT date, weight, fat, bmi, muscle, fasting FROM body_records WHERE owner_id = ? ORDER BY date")
        .bind(ownerId).all(),
      env.DB.prepare("SELECT date, angle FROM body_photos WHERE owner_id = ? ORDER BY date")
        .bind(ownerId).all(),
    ]);
    return json({ records: recordResult.results, photos: photoResult.results });
  }

  if (url.pathname === "/api/state" && request.method === "DELETE") {
    const listed = await env.PHOTOS.list({ prefix: `${encodeURIComponent(ownerId)}/` });
    if (listed.objects.length) await env.PHOTOS.delete(listed.objects.map((object) => object.key));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM body_photos WHERE owner_id = ?").bind(ownerId),
      env.DB.prepare("DELETE FROM body_records WHERE owner_id = ?").bind(ownerId),
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
    await env.DB.prepare("INSERT INTO body_records (owner_id, date, weight, fat, bmi, muscle, fasting, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, date) DO UPDATE SET weight = excluded.weight, fat = excluded.fat, bmi = excluded.bmi, muscle = excluded.muscle, fasting = excluded.fasting, updated_at = excluded.updated_at")
      .bind(ownerId, date, weight, nullableNumber(body.fat), nullableNumber(body.bmi), nullableNumber(body.muscle), body.fasting ? 1 : 0, new Date().toISOString()).run();
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
