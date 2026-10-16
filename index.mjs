#!/usr/bin/env node
/**
 * Deploys a built web game to Gamavas Edge. Runs as the gamavas/deploy GitHub Action, or from
 * any terminal or CI:
 *
 *   GAMAVAS_DEPLOY_TOKEN=gvd_… node index.mjs --dir dist [--preview] [--api https://…]
 *
 * Only files Gamavas doesn't already have are uploaded (by content hash), straight to storage.
 * No dependencies: Node 20+ only.
 */
import { createHash } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const inAction = Boolean(process.env.GITHUB_ACTIONS);
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = (name) => process.env[`INPUT_${name.toUpperCase()}`]?.trim() || undefined;

const token = input("token") ?? process.env.GAMAVAS_DEPLOY_TOKEN;
const dir = resolve(input("dir") ?? option("dir") ?? ".");
const api = (input("api-url") ?? option("api") ?? "https://gamavas.fun/api/host/v1").replace(
  /\/+$/,
  "",
);
const production = (() => {
  const value =
    input("production") ?? (flag("preview") ? "false" : flag("production") ? "true" : "auto");
  if (value === "true") return true;
  if (value === "false") return false;
  // auto: pull requests are previews, everything else (pushes, manual runs) goes live.
  return !process.env.GITHUB_EVENT_NAME?.startsWith("pull_request");
})();

const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.git\/.*|__MACOSX\/.*)$/i;
const BATCH = 100;

function fail(message) {
  if (inAction) console.log(`::error title=Gamavas Edge::${message}`);
  else console.error(`✗ ${message}`);
  process.exit(1);
}

function gitDetails() {
  let message = null;
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
    message = event.head_commit?.message ?? event.pull_request?.title ?? null;
  } catch {}
  return {
    branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || null,
    commitSha: process.env.GITHUB_SHA ?? null,
    commitMessage: message,
  };
}

function walk(folder) {
  return readdirSync(folder).flatMap((name) => {
    const full = join(folder, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

async function call(method, path, body) {
  let response;
  try {
    response = await fetch(`${api}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    fail(`Couldn't reach ${api}: ${error.message}`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) fail(data.error ?? `${method} ${path} failed (${response.status})`);
  return data;
}

async function put(url, headers, bytes) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { method: "PUT", headers, body: bytes }).catch(() => null);
    if (response?.ok) return;
    if (response && response.status < 500 && response.status !== 429) {
      fail(
        `Upload refused (${response.status}). Try again; if it keeps failing, make a new token.`,
      );
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  fail("An upload kept failing. Try the deploy again.");
}

async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

if (!token)
  fail(
    "No deploy token. Pass the `token` input from your GAMAVAS_DEPLOY_TOKEN secret (or set GAMAVAS_DEPLOY_TOKEN).",
  );
let files;
try {
  files = walk(dir)
    .map((full) => ({ full, path: relative(dir, full).split(sep).join("/") }))
    .filter((f) => !JUNK.test(f.path));
} catch {
  fail(`Can't read the folder ${dir}. Set \`dir\` to your build folder.`);
}
if (!files.some((f) => f.path === "index.html")) {
  fail(
    `No index.html at the top of ${relative(process.cwd(), dir) || "."}. Set \`dir\` to the folder that contains it.`,
  );
}

const byHash = new Map();
const list = files.map((f) => {
  const bytes = readFileSync(f.full);
  const hash = createHash("sha256").update(bytes).digest("hex");
  byHash.set(hash, bytes);
  return { path: f.path, hash, size: bytes.length };
});
const totalBytes = list.reduce((sum, f) => sum + f.size, 0);
console.log(
  `Deploying ${list.length} ${list.length === 1 ? "file" : "files"} (${(totalBytes / 1024 / 1024).toFixed(1)} MB) from ${relative(process.cwd(), dir) || "."}…`,
);

const { deploymentId, missing } = await call("POST", "/deployments", {
  files: list,
  ...gitDetails(),
});
console.log(
  missing.length
    ? `Uploading ${missing.length} new ${missing.length === 1 ? "file" : "files"}…`
    : "Nothing new to upload.",
);
for (let i = 0; i < missing.length; i += BATCH) {
  const hashes = missing.slice(i, i + BATCH).map((m) => m.hash);
  const { uploads } = await call("POST", `/deployments/${deploymentId}/upload-urls`, { hashes });
  await pool(uploads, 6, (u) => put(u.url, u.headers, byHash.get(u.hash)));
  const { missing: notThere } = await call("POST", `/deployments/${deploymentId}/confirm`, {
    hashes,
  });
  if (notThere.length) fail(`${notThere.length} file(s) didn't arrive. Try the deploy again.`);
}

const done = await call("POST", `/deployments/${deploymentId}/finalize`, { production });
const url = done.live ? done.productionUrl : done.previewUrl;
console.log(done.live ? `✓ Live at ${done.productionUrl}` : `✓ Preview at ${done.previewUrl}`);
if (done.notLiveReason) {
  if (inAction) console.log(`::warning title=Gamavas Edge::${done.notLiveReason}`);
  else console.log(`! ${done.notLiveReason}`);
}
setOutput("url", url);
setOutput("preview-url", done.previewUrl);
setOutput("live", String(done.live));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Gamavas Edge\n\n${done.live ? "Live" : "Preview"}: ${url}\n\nPreview of this deploy: ${done.previewUrl}\n${done.notLiveReason ? `\n> ${done.notLiveReason}\n` : ""}`,
  );
}
