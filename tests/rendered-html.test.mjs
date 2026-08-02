import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("ships an installable iPhone-safe app shell", async () => {
  const [html, manifest, serviceWorker] = await Promise.all([
    read("fit-demo.html"),
    read("manifest.webmanifest"),
    read("sw.js"),
  ]);

  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /safe-area-inset-top/);
  assert.match(html, /100dvh/);
  assert.match(html, /\.sensor\{display:none\}/);
  assert.match(html, /openInstallGuide/);
  assert.match(html, /添加到手机桌面/);

  const appManifest = JSON.parse(manifest);
  assert.equal(appManifest.display, "standalone");
  assert.equal(appManifest.scope, "/");
  assert.equal(appManifest.start_url, "/fit-demo.html");
  assert.ok(appManifest.icons.some((icon) => icon.sizes === "512x512"));
  assert.match(serviceWorker, /pathname\.startsWith\(["']\/api\/["']\)/);
});

test("keeps real records and private media storage wired", async () => {
  const [html, worker, hosting] = await Promise.all([
    read("fit-demo.html"),
    read("worker/index.ts"),
    read(".openai/hosting.json"),
  ]);

  assert.match(html, /function saveRecord/);
  assert.match(html, /function renderTrend/);
  assert.match(html, /function renderCompare/);
  assert.match(html, /辅助录入测试版/);
  assert.match(html, /当前测试版还不会自动读取照片特征/);

  assert.match(worker, /\/api\/records/);
  assert.match(worker, /env\.DB/);
  assert.match(worker, /env\.PHOTOS\.put/);
  assert.match(worker, /oai-authenticated-user-id/);

  const bindings = JSON.parse(hosting);
  assert.equal(bindings.d1, "DB");
  assert.equal(bindings.r2, "PHOTOS");
});
