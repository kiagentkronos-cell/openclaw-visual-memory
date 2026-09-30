// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// src/entry.ts
import path5 from "node:path";
import { existsSync } from "node:fs";

// src/config.ts
function defaultWorkspaceDir() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return `${home.replace(/\/+$/, "")}/.openclaw/workspace`;
}
function defaultDiagLogPath() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return `${home.replace(/\/+$/, "")}/.openclaw/logs/visual-memory-hook.log`;
}
function defaultMediaDir() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return `${home.replace(/\/+$/, "")}/.openclaw/media`;
}
function defaultTranscriptDir() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return `${home.replace(/\/+$/, "")}/.openclaw/plugins/visual-memory/transcripts`;
}
var DEFAULT_CONFIG = {
  enabled: true,
  workspaceDir: defaultWorkspaceDir(),
  vmScriptRelPath: "scripts/visual-memory/vm.py",
  venvRelPath: "scripts/visual-memory/venv/bin/python",
  checkTimeoutMs: 12e4,
  maxImageSizeBytes: 20 * 1024 * 1024,
  maxImageAgeMs: 15 * 60 * 1e3,
  injectionTtlMs: 12e4,
  stagingRetryMs: 5e3,
  mediaDir: defaultMediaDir(),
  diagLogPath: defaultDiagLogPath(),
  transcriptDir: defaultTranscriptDir(),
  transcriptMaxFiles: 200
};
function normalizeConfig(raw) {
  const pick = (key) => {
    const value = raw?.[key];
    return value === void 0 ? void 0 : value;
  };
  return {
    enabled: pick("enabled") ?? DEFAULT_CONFIG.enabled,
    workspaceDir: pick("workspaceDir") ?? DEFAULT_CONFIG.workspaceDir,
    vmScriptRelPath: pick("vmScriptRelPath") ?? DEFAULT_CONFIG.vmScriptRelPath,
    venvRelPath: pick("venvRelPath") ?? DEFAULT_CONFIG.venvRelPath,
    checkTimeoutMs: pick("checkTimeoutMs") ?? DEFAULT_CONFIG.checkTimeoutMs,
    maxImageSizeBytes: pick("maxImageSizeBytes") ?? DEFAULT_CONFIG.maxImageSizeBytes,
    maxImageAgeMs: pick("maxImageAgeMs") ?? DEFAULT_CONFIG.maxImageAgeMs,
    injectionTtlMs: pick("injectionTtlMs") ?? DEFAULT_CONFIG.injectionTtlMs,
    stagingRetryMs: pick("stagingRetryMs") ?? DEFAULT_CONFIG.stagingRetryMs,
    mediaDir: pick("mediaDir") ?? DEFAULT_CONFIG.mediaDir,
    diagLogPath: pick("diagLogPath") ?? DEFAULT_CONFIG.diagLogPath,
    transcriptDir: pick("transcriptDir") ?? DEFAULT_CONFIG.transcriptDir,
    transcriptMaxFiles: pick("transcriptMaxFiles") ?? DEFAULT_CONFIG.transcriptMaxFiles
  };
}

// src/handler.ts
import path4 from "node:path";

// src/media.ts
function isImageFact(fact) {
  if (fact.kind !== void 0) {
    return fact.kind === "image";
  }
  return typeof fact.contentType === "string" && fact.contentType.toLowerCase().startsWith("image/");
}
function localImagePaths(media) {
  if (!Array.isArray(media)) {
    return [];
  }
  const paths = [];
  for (const fact of media) {
    if (isImageFact(fact) && typeof fact.path === "string" && fact.path.length > 0) {
      paths.push(fact.path);
    }
  }
  return paths;
}

// src/promptmedia.ts
import fs from "node:fs";
import path from "node:path";
var MEDIA_NOTE_LINE = /\[media attached(?:\s+\d+\/\d+)?:\s*([^\]]+)\]/gi;
var IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".heic",
  ".heif",
  ".tif",
  ".tiff"
]);
function isUnder(base, resolved) {
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return resolved === base || resolved.startsWith(prefix);
}
function gateMediaPath(candidate, allowedDirs) {
  if (!path.isAbsolute(candidate)) return void 0;
  const resolved = path.resolve(candidate);
  const bases = allowedDirs.map((d) => path.resolve(d)).filter((d) => d.length > 0);
  if (!bases.some((base) => isUnder(base, resolved))) return void 0;
  try {
    const real = fs.realpathSync(resolved);
    const realResolved = path.resolve(real);
    if (!bases.some((base) => isUnder(base, realResolved))) return void 0;
  } catch {
  }
  return resolved;
}
function kindFromPath(p) {
  const ext = path.extname(p.trim()).toLowerCase();
  if (ext.length === 0) return void 0;
  return IMAGE_EXTENSIONS.has(ext) ? "image" : void 0;
}
function parseNotePayload(payload, ctx) {
  let rest = payload.trim();
  if (rest.length === 0) return void 0;
  if (/^\d+\s+files$/i.test(rest)) return void 0;
  rest = rest.replace(/\s+"[^"]*"\s*$/, "").trim();
  let contentType;
  const withUrl = rest.split(/\s*\|\s*/);
  const primary = withUrl[0] ?? "";
  const url = withUrl.length > 1 ? withUrl.slice(1).join(" | ") : void 0;
  let pathPart = primary.trim();
  const mimeMatch = pathPart.match(/\s*\(([^()]*)\)\s*$/);
  if (mimeMatch) {
    contentType = mimeMatch[1]?.trim() || void 0;
    pathPart = pathPart.slice(0, mimeMatch.index).trim();
  }
  let factPath;
  let factUrl = url;
  const trimmed = pathPart.replace(/^"|"$/g, "").trim();
  if (trimmed.startsWith("media://inbound/")) {
    factPath = path.join(ctx.mediaDir, "inbound", path.basename(trimmed.slice("media://".length)));
  } else if (trimmed.includes("://")) {
    factUrl = factUrl ?? trimmed;
  } else if (trimmed.length > 0) {
    factPath = trimmed;
  } else if (factUrl) {
  } else {
    return void 0;
  }
  const kind = contentType ? contentType.toLowerCase().startsWith("image/") ? "image" : contentType.toLowerCase().startsWith("audio/") ? "audio" : contentType.toLowerCase().startsWith("video/") ? "video" : void 0 : kindFromPath(factPath ?? trimmed);
  const fact = {};
  if (factPath) {
    const gated = gateMediaPath(factPath, ctx.allowedDirs);
    if (gated === void 0) {
      if (!url) return void 0;
    } else {
      fact.path = gated;
    }
  }
  if (factUrl) fact.url = factUrl;
  if (contentType) fact.contentType = contentType;
  if (kind) fact.kind = kind;
  if (!fact.path && !fact.url) return void 0;
  return fact;
}
function asContext(ctx) {
  if (typeof ctx === "string") return { mediaDir: ctx, allowedDirs: [ctx] };
  const allowedDirs = ctx.allowedDirs.length > 0 ? ctx.allowedDirs : [ctx.mediaDir];
  return { mediaDir: ctx.mediaDir, allowedDirs };
}
function promptMediaFacts(text, ctx) {
  const context = asContext(ctx);
  const facts = [];
  const seen = /* @__PURE__ */ new Set();
  if (typeof text !== "string" || text.length === 0) return facts;
  for (const match of text.matchAll(MEDIA_NOTE_LINE)) {
    const fact = parseNotePayload(match[1] ?? "", context);
    if (!fact) continue;
    const key = fact.path ?? fact.url ?? "";
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    facts.push(fact);
  }
  return facts;
}
function promptImageFacts(text, ctx) {
  return promptMediaFacts(text, ctx).filter((fact) => {
    if (fact.kind !== void 0) return fact.kind === "image";
    if (typeof fact.contentType === "string") {
      return fact.contentType.toLowerCase().startsWith("image/");
    }
    return false;
  });
}

// src/injection.ts
var INJECTION_PREFIX = "[Visual Memory]";
function formatHit(hit) {
  const score = Number.isFinite(hit.score) ? hit.score.toFixed(2) : "?";
  const scope = hit.scope && hit.scope !== "private" ? `, ${hit.scope}` : "";
  return `${hit.name} (${hit.kind}, ${hit.confidence}, ${score}${scope})`;
}
function parseCheckOutput(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { status: "error", reason: "empty output" };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { status: "error", reason: "invalid JSON output" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { status: "error", reason: "non-object output" };
  }
  const obj = parsed;
  if (obj.ok !== true) {
    return { status: "error", reason: "vm.py reported failure" };
  }
  if (!Array.isArray(obj.hits)) {
    return { status: "error", reason: "invalid JSON output" };
  }
  const hits = [];
  for (const raw of obj.hits) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const hit = raw;
    if (typeof hit.name !== "string" || hit.name.length === 0) {
      continue;
    }
    hits.push({
      name: hit.name,
      kind: typeof hit.kind === "string" ? hit.kind : "unknown",
      score: typeof hit.score === "number" ? hit.score : Number.NaN,
      confidence: typeof hit.confidence === "string" ? hit.confidence : "unknown",
      scope: typeof hit.scope === "string" ? hit.scope : void 0
    });
  }
  return { status: "ok", hits };
}
function buildInjectionText(outcome) {
  if (outcome.status === "error") {
    return `${INJECTION_PREFIX} ${unavailableText(outcome.reason)}`;
  }
  if (outcome.hits.length === 0) {
    return `${INJECTION_PREFIX} keine Treffer`;
  }
  const formatted = outcome.hits.map(formatHit).join("; ");
  return `${INJECTION_PREFIX} Treffer: ${formatted}`;
}
function unavailableText(reason) {
  const lowered = reason.toLowerCase();
  if (lowered.includes("timed out") || lowered.includes("timeout")) {
    return "Check nicht verf\xFCgbar (timeout)";
  }
  return `Check nicht verf\xFCgbar (fehler: ${sanitizeReasonToken(reason)})`;
}
function sanitizeReasonToken(reason) {
  const r = reason.toLowerCase();
  if (r.includes("not readable")) return "file_not_readable";
  if (r.includes("size guard")) return "too_large";
  if (r.includes("age guard")) return "too_old";
  if (r.includes("spawn error") || r.includes("spawn failed") || r.includes("bad interpreter")) {
    return "spawn_error";
  }
  if (r.includes("exited")) return "exit_code";
  if (r.includes("json") || r.includes("empty output") || r.includes("non-object")) {
    return "bad_output";
  }
  if (r.includes("reported failure")) return "vm_failure";
  return reason.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 24) || "error";
}

// src/checker.ts
import { spawn as nodeSpawn } from "node:child_process";
import { stat } from "node:fs/promises";
var defaultSpawn = (command, args) => {
  const child = nodeSpawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    // Never open a shell — arguments go straight to execve.
    shell: false
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return child;
};
async function checkImage(imagePath, options) {
  let stats;
  try {
    stats = await stat(imagePath);
  } catch {
    return { status: "skipped", reason: "image file not readable" };
  }
  if (options.maxSizeBytes > 0 && stats.size > options.maxSizeBytes) {
    return { status: "skipped", reason: "image exceeds size guard" };
  }
  if (options.maxAgeMs > 0) {
    const now = (options.now ?? Date.now)();
    if (now - stats.mtimeMs > options.maxAgeMs) {
      return { status: "skipped", reason: "image older than age guard" };
    }
  }
  const spawn = options.spawn ?? defaultSpawn;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    let handle;
    try {
      handle = spawn(options.pythonPath, [options.scriptPath, "check", imagePath]);
    } catch (err) {
      finish({ status: "error", reason: `spawn failed: ${String(err)}` });
      return;
    }
    let stdout = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        handle.kill("SIGKILL");
      } catch {
      }
      finish({ status: "error", reason: "check timed out" });
    }, options.timeoutMs);
    const onData = (chunk) => {
      if (stdout.length < 64 * 1024) {
        stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      }
    };
    const out = handle.stdout;
    if (typeof out?.on === "function") {
      out.on("data", onData);
    }
    handle.on("error", (err) => {
      clearTimeout(timer);
      finish({ status: "error", reason: `spawn error: ${err.message}` });
    });
    handle.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        return;
      }
      if (code !== 0) {
        finish({ status: "error", reason: `vm.py exited with code ${code}` });
        return;
      }
      finish(parseCheckOutput(stdout));
    });
  });
}

// src/diaglog.ts
import { appendFile, mkdir, readFile, stat as stat2, writeFile } from "node:fs/promises";
import path2 from "node:path";
import { createHash } from "node:crypto";
function shortMessageId(messageId, fallbackKey) {
  const trimmed = typeof messageId === "string" ? messageId.trim() : "";
  if (trimmed.length > 0) {
    return trimmed.slice(0, 12);
  }
  return createHash("sha256").update(fallbackKey).digest("hex").slice(0, 12);
}
function sanitize(value) {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60);
}
function formatDiagLine(now, rec) {
  const parts = [now.toISOString(), `msg=${sanitize(rec.msgId)}`];
  if (rec.channel) {
    parts.push(`channel=${sanitize(rec.channel)}`);
  }
  parts.push(`decision=${rec.decision}`);
  if (typeof rec.images === "number") {
    parts.push(`images=${Math.trunc(rec.images)}`);
  }
  if (typeof rec.hits === "number") {
    parts.push(`hits=${Math.trunc(rec.hits)}`);
  }
  if (rec.reason) {
    parts.push(`reason=${sanitize(rec.reason)}`);
  }
  return `${parts.join(" ")}
`;
}
var FileDiagSink = class {
  queue = Promise.resolve();
  filePath;
  maxBytes;
  now;
  constructor(filePath, maxBytes, now = Date.now) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.now = now;
  }
  record(rec) {
    const line = formatDiagLine(new Date(this.now()), rec);
    this.queue = this.queue.then(() => this.writeLine(line)).catch(() => {
    });
  }
  /** Test seam: resolves once all queued writes have settled. */
  flush() {
    return this.queue;
  }
  async writeLine(line) {
    try {
      let size = 0;
      try {
        size = (await stat2(this.filePath)).size;
      } catch {
        size = 0;
      }
      if (size > this.maxBytes) {
        await this.rotate();
      }
      await appendFile(this.filePath, line, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        await mkdir(path2.dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, line, "utf8");
        return;
      }
      throw err;
    }
  }
  async rotate() {
    const buf = await readFile(this.filePath);
    const tail = buf.subarray(Math.max(0, buf.length - Math.floor(this.maxBytes / 2)));
    const firstNewline = tail.indexOf(10);
    const keep = firstNewline >= 0 ? tail.subarray(firstNewline + 1) : tail;
    await writeFile(this.filePath, keep);
  }
};

// src/transcript.ts
import { appendFile as appendFile2, mkdir as mkdir2, readdir, unlink } from "node:fs/promises";
import path3 from "node:path";
import { randomUUID } from "node:crypto";
var NULL_TRANSCRIPT_SINK = {
  begin: () => ({ record() {
  }, done() {
  } })
};
var TRANSCRIPT_PREFIX = "visual-memory-";
function transcriptFileName(nowMs) {
  const iso = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return `${TRANSCRIPT_PREFIX}${iso}-${randomUUID().slice(0, 8)}.jsonl`;
}
var FileTranscriptSink = class {
  queue = Promise.resolve();
  dir;
  maxFiles;
  now;
  constructor(dir, maxFiles, now = Date.now) {
    this.dir = dir;
    this.maxFiles = Math.max(1, Math.trunc(maxFiles));
    this.now = now;
  }
  /** Test seam: resolves once all queued writes have settled. */
  flush() {
    return this.queue;
  }
  begin(meta) {
    const fileName = transcriptFileName(this.now());
    const filePath = path3.join(this.dir, fileName);
    let closed = false;
    const writeLine = (obj) => {
      const stamped = JSON.stringify(obj);
      this.queue = this.queue.then(async () => {
        try {
          await appendFile2(filePath, stamped + "\n", "utf8");
        } catch (err) {
          if (err.code === "ENOENT") {
            await mkdir2(this.dir, { recursive: true });
            await appendFile2(filePath, stamped + "\n", "utf8");
          }
        }
      }).catch(() => {
      });
    };
    const append = (line) => {
      if (closed) return;
      writeLine({ ts: new Date(this.now()).toISOString(), ...line });
    };
    this.queue = this.queue.then(async () => {
      await mkdir2(this.dir, { recursive: true });
      await appendFile2(filePath, JSON.stringify({ type: "run", ts: new Date(this.now()).toISOString(), ...meta }) + "\n", "utf8");
    }).catch(() => {
    });
    return {
      record: append,
      done: (line) => {
        if (closed) return;
        closed = true;
        writeLine({ ts: new Date(this.now()).toISOString(), type: "done", ...line });
        this.queue = this.queue.then(() => this.prune()).catch(() => void 0);
      }
    };
  }
  /** Keep the newest maxFiles transcripts (lexicographic order = time order). */
  async prune() {
    let names;
    try {
      names = (await readdir(this.dir)).filter((n) => n.startsWith(TRANSCRIPT_PREFIX) && n.endsWith(".jsonl"));
    } catch {
      return;
    }
    if (names.length <= this.maxFiles) return;
    names.sort();
    const doomed = names.slice(0, names.length - this.maxFiles);
    await Promise.all(
      doomed.map((n) => unlink(path3.join(this.dir, n)).catch(() => void 0))
    );
  }
};

// src/handler.ts
import { createHash as createHash2 } from "node:crypto";
import { stat as stat3 } from "node:fs/promises";
function resolveSessionKey(event, ctx) {
  return event.sessionKey ?? ctx.sessionKey;
}
function messageKey(event, ctx) {
  const id = event.messageId ?? ctx.messageId;
  if (typeof id === "string" && id.length > 0) {
    return `id:${id}`;
  }
  return `raw:${resolveSessionKey(event, ctx) ?? "?"}:${event.content ?? ""}`;
}
function channelLabel(event) {
  const provider = event.metadata?.provider;
  if (typeof provider === "string" && provider.length > 0) {
    return provider;
  }
  const surface = event.metadata?.surface;
  return typeof surface === "string" && surface.length > 0 ? surface : void 0;
}
var MessageLedger = class {
  seen = /* @__PURE__ */ new Map();
  maxEntries;
  now;
  constructor(opts) {
    this.maxEntries = opts?.maxEntries ?? 500;
    this.now = opts?.now ?? Date.now;
  }
  /** True (and records) when the key has NOT been seen before. */
  claim(key) {
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.set(key, this.now());
    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) {
        this.seen.delete(oldest.value);
      }
    }
    return true;
  }
  /** Claim an absolute image path (path-keyed namespace `path:`). */
  claimPath(imagePath) {
    return this.claim(`path:${imagePath}`);
  }
  has(key) {
    return this.seen.has(key);
  }
  hasPath(imagePath) {
    return this.seen.has(`path:${imagePath}`);
  }
};
function handleMessageReceived(event, ctx, deps) {
  const key = messageKey(event, ctx);
  const msgId = shortMessageId(event.messageId ?? ctx.messageId, key);
  const channel = channelLabel(event);
  const log = (decision, extra) => deps.diag.record({ msgId, channel, decision, ...extra });
  if (!deps.config.enabled) {
    log("disabled");
    return { action: "disabled" };
  }
  if (event.mediaStagingPending === true && !Array.isArray(event.media)) {
    log("staging_pending_skip", {
      images: Array.isArray(event.originalMedia) ? event.originalMedia.length : 0
    });
    const sessionKey = resolveSessionKey(event, ctx);
    const originals = Array.isArray(event.originalMedia) ? event.originalMedia : [];
    if (sessionKey) {
      deps.schedule(() => {
        retryStagedOriginals(originals, sessionKey, key, msgId, channel, deps);
      }, deps.config.stagingRetryMs);
    }
    return { action: "staging-pending" };
  }
  const images = localImagePaths(event.media);
  if (images.length === 0) {
    log("no_image");
    return { action: "no-image" };
  }
  log("image_found", { images: images.length });
  return { action: "image-noted" };
}
async function handlePromptBuild(event, ctx, deps) {
  const channel = ctx.channel ?? ctx.channelId;
  const msgId = "promptbuild";
  const log = (decision, extra) => deps.diag.record({ msgId, channel, decision, ...extra });
  if (!deps.config.enabled) {
    log("disabled");
    return { action: "disabled" };
  }
  log("prompt_fire", ctx.trigger ? { reason: `trigger_${ctx.trigger}` } : void 0);
  if (ctx.trigger !== void 0 && ctx.trigger !== "user") {
    return { action: "no-image" };
  }
  const promptText = typeof event.currentUserMessage === "string" && event.currentUserMessage.length > 0 ? event.currentUserMessage : event.prompt ?? "";
  const facts = promptImageFacts(promptText, noteParseContext(deps));
  const images = facts.map((fact) => fact.path).filter((p) => typeof p === "string" && p.length > 0);
  if (images.length === 0) {
    return { action: "no-image" };
  }
  const sessionKey = ctx.sessionKey;
  if (!sessionKey) {
    deps.log.warn("visual-memory: prompt image without resolvable sessionKey; skipped");
    log("no_image", { reason: "no_session", images: images.length });
    return { action: "no-image", reason: "no_session" };
  }
  const fresh = images.filter((p) => deps.processed.claimPath(p));
  if (fresh.length === 0) {
    log("dedup_skip", { images: images.length });
    return { action: "duplicate" };
  }
  const key = `path:${fresh.join(",")}`;
  log("image_found", { images: fresh.length });
  log("check_started", { images: fresh.length });
  const result = await runChecks(fresh, sessionKey, key, msgId, channel, deps, {
    seam: "before_prompt_build",
    trigger: ctx.trigger
  });
  const { text, hitsTotal, run, startedAt } = result;
  run.record({
    type: "inject",
    text,
    idempotencyKey: `visual-memory:${sessionKey}:${key}`,
    mode: "same_turn"
  });
  run.done({
    decision: "injected_sync",
    hitsTotal,
    durationMs: (deps.now ?? Date.now)() - startedAt
  });
  log("injected", { hits: hitsTotal, reason: "same_turn" });
  return { action: "prepend", text };
}
function noteParseContext(deps) {
  const mediaDir = deps.mediaDir ?? deps.config.mediaDir;
  allowedMediaDirs(deps).length;
  const allowedDirs = allowedMediaDirs(deps);
  return { mediaDir, allowedDirs };
}
function allowedMediaDirs(deps) {
  const mediaDir = deps.mediaDir ?? deps.config.mediaDir;
  const allowedDirs = [mediaDir];
  if (typeof deps.config.workspaceDir === "string" && deps.config.workspaceDir.length > 0) {
    const workspaceMedia = path4.join(deps.config.workspaceDir, "media");
    if (!allowedDirs.some((d) => path4.resolve(d) === path4.resolve(workspaceMedia))) {
      allowedDirs.push(workspaceMedia);
    }
  }
  return allowedDirs;
}
function retryStagedOriginals(originals, sessionKey, key, msgId, channel, deps) {
  const log = (decision, extra) => deps.diag.record({ msgId, channel, decision, ...extra });
  const images = [];
  for (const fact of originals) {
    if (typeof fact.path === "string" && fact.path.length > 0 && deps.fileExists(fact.path) && (fact.kind === void 0 || fact.kind === "image")) {
      images.push(fact.path);
    }
  }
  if (images.length === 0) {
    log("staging_pending_skip", { reason: "retry_not_readable" });
    return;
  }
  const fresh = images.filter((p) => deps.processed.claimPath(p));
  if (fresh.length === 0) {
    log("dedup_skip");
    return;
  }
  log("check_started", { images: fresh.length });
  void deliverViaNextTurn(fresh, sessionKey, key, msgId, channel, deps, {
    seam: "staging_retry"
  }).catch(() => {
  });
}
async function deliverViaNextTurn(images, sessionKey, key, msgId, channel, deps, transcriptMeta) {
  const log = (decision, extra) => deps.diag.record({ msgId, channel, decision, ...extra });
  const result = await runChecks(images, sessionKey, key, msgId, channel, deps, transcriptMeta);
  const { text, hitsTotal, run, startedAt } = result;
  const elapsed = () => (deps.now ?? Date.now)() - startedAt;
  const idempotencyKey = `visual-memory:${sessionKey}:${key}`;
  run.record({ type: "inject", text, idempotencyKey, mode: "next_turn", ttlMs: deps.config.injectionTtlMs });
  try {
    const res = await deps.enqueue({
      sessionKey,
      text,
      // One injection per message+session: covers re-delivery of the same
      // message and lets the host dedupe pending entries.
      idempotencyKey,
      ttlMs: deps.config.injectionTtlMs
    });
    if (res && typeof res === "object" && res.enqueued === false) {
      log("inject_failed", { reason: "host_refused" });
      deps.log.error("visual-memory: staging-retry enqueue refused by host (enqueued=false)");
      run.done({ decision: "inject_failed", reason: "host_refused", hitsTotal, durationMs: elapsed() });
      return "dropped";
    }
    log("injected", { hits: hitsTotal, reason: "next_turn" });
    run.done({ decision: "injected", hitsTotal, durationMs: elapsed() });
    return "enqueued";
  } catch (err) {
    log("inject_failed", { reason: reasonToken(String(err)) });
    deps.log.error(`visual-memory: staging-retry enqueue failed (${String(err)})`);
    run.done({ decision: "inject_failed", reason: reasonToken(String(err)), hitsTotal, durationMs: elapsed() });
    return "dropped";
  }
}
async function runChecks(images, sessionKey, messageKeyStr, msgId, channel, deps, transcriptMeta) {
  const log = (decision, extra) => deps.diag.record({ msgId, channel, decision, ...extra });
  const run = (deps.transcripts ?? NULL_TRANSCRIPT_SINK).begin({
    id: `vmrun-${shortMessageId(messageKeyStr, messageKeyStr)}`,
    seam: "check",
    channel,
    sessionKey,
    images: images.length,
    ...transcriptMeta
  });
  const startedAt = (deps.now ?? Date.now)();
  const deadlineAt = startedAt + deps.config.checkTimeoutMs;
  for (const image of images) {
    const info = {
      type: "image",
      path: image,
      // pathhash, NOT a content hash: identity of the note path for dedupe
      // forensics; the image bytes are never read into the transcript.
      pathhash: createHash2("sha256").update(image).digest("hex").slice(0, 16)
    };
    try {
      const st = await stat3(image);
      info.sizeBytes = st.size;
      info.mtimeMs = st.mtimeMs;
    } catch {
      info.exists = false;
    }
    run.record(info);
  }
  const outcomes = [];
  for (const image of images) {
    const checkStarted = (deps.now ?? Date.now)();
    const remaining = deadlineAt - checkStarted;
    if (remaining <= 0) {
      outcomes.push({ status: "error", reason: "check timed out" });
      run.record({ type: "check", path: image, status: "error", reason: "deadline exhausted", durationMs: 0 });
      continue;
    }
    const result = await checkImage(image, {
      pythonPath: deps.pythonPath,
      scriptPath: deps.scriptPath,
      timeoutMs: remaining,
      maxSizeBytes: deps.config.maxImageSizeBytes,
      maxAgeMs: deps.config.maxImageAgeMs,
      spawn: deps.spawn,
      now: deps.now
    });
    outcomes.push(result);
    const checkLine = {
      type: "check",
      path: image,
      status: result.status,
      durationMs: (deps.now ?? Date.now)() - checkStarted
    };
    if (result.status === "ok") checkLine.hits = result.hits;
    else checkLine.reason = result.reason;
    run.record(checkLine);
  }
  let unavailableReason;
  for (const o of outcomes) {
    if (o.status === "ok") {
      if (o.hits.length > 0) {
        log("check_hits", { hits: o.hits.length });
      } else {
        log("check_miss");
      }
    } else if (o.status === "error") {
      unavailableReason ??= o.reason;
      if (o.reason === "check timed out") {
        log("check_timeout");
      } else {
        log("check_error", { reason: reasonToken(o.reason) });
      }
      deps.log.error(`visual-memory: check failed (${o.reason})`);
    } else {
      unavailableReason ??= o.reason;
      log("check_error", { reason: reasonToken(o.reason) });
      deps.log.info(`visual-memory: check skipped (${o.reason})`);
    }
  }
  const failed = outcomes.filter((o) => o.status !== "ok");
  let outcome;
  if (failed.length > 0) {
    outcome = { status: "error", reason: unavailableReason ?? "check unavailable" };
  } else {
    const best = /* @__PURE__ */ new Map();
    for (const o of outcomes) {
      if (o.status !== "ok") continue;
      for (const hit of o.hits) {
        const id = `${hit.name} ${hit.kind}`;
        const prev = best.get(id);
        if (!prev || (hit.score ?? -1) > (prev.score ?? -1)) {
          best.set(id, hit);
        }
      }
    }
    outcome = { status: "ok", hits: [...best.values()] };
  }
  const text = buildInjectionText(outcome);
  const hitsTotal = outcome.status === "ok" ? outcome.hits.length : 0;
  return { text, hitsTotal, run, startedAt };
}
function reasonToken(reason) {
  const r = reason.toLowerCase();
  if (r.includes("timed out") || r.includes("timeout")) return "timeout";
  if (r.includes("not readable")) return "file_not_readable";
  if (r.includes("size guard")) return "too_large";
  if (r.includes("age guard")) return "too_old";
  if (r.includes("spawn error") || r.includes("spawn failed")) return "spawn_error";
  if (r.includes("exited")) return "exit_code";
  if (r.includes("json") || r.includes("empty output")) return "bad_output";
  if (r.includes("reported failure")) return "vm_failure";
  return "error";
}

// src/entry.ts
function buildDeps(api, config, extras = {}) {
  return {
    config,
    pythonPath: path5.resolve(config.workspaceDir, config.venvRelPath),
    scriptPath: path5.resolve(config.workspaceDir, config.vmScriptRelPath),
    spawn: extras.spawn,
    now: extras.now,
    log: {
      info: (msg) => api.logger.info?.(msg),
      warn: (msg) => api.logger.warn?.(msg),
      error: (msg) => api.logger.error?.(msg)
    },
    processed: new MessageLedger(),
    // Production sink: size-capped metadata-only file. A sink failure is
    // silent by design; tests pass their own capture sink via extras.diag.
    diag: extras.diag ?? new FileDiagSink(config.diagLogPath, 1048576, extras.now ?? Date.now),
    transcripts: extras.transcripts ?? new FileTranscriptSink(config.transcriptDir, config.transcriptMaxFiles, extras.now ?? Date.now),
    schedule: extras.schedule ?? ((fn, delayMs) => setTimeout(fn, delayMs)),
    fileExists: extras.fileExists ?? ((p) => existsSync(p)),
    mediaDir: config.mediaDir,
    // Return the host result so the handler can see enqueued:false refusals
    // (the host does not throw when it drops an injection).
    enqueue: async ({ sessionKey, text, idempotencyKey, ttlMs }) => api.session.workflow.enqueueNextTurnInjection({
      sessionKey,
      text,
      idempotencyKey,
      ttlMs,
      placement: "prepend_context"
    })
  };
}
var HOOK_GRACE_MS = 5e3;
function registerMessageHook(api, extras = {}) {
  const config = normalizeConfig(api.pluginConfig);
  const deps = buildDeps(api, config, extras);
  const handle = (event, ctx) => handleMessageReceived(
    event,
    ctx,
    deps
  );
  const handlePrompt = (event, ctx) => handlePromptBuild(
    event,
    ctx,
    deps
  );
  const handlers = {
    before_prompt_build: async (event, ctx) => {
      const decision = await handlePrompt(event, ctx);
      if (decision.action === "prepend") {
        return { prependContext: decision.text };
      }
      return void 0;
    },
    message_received: async (event, ctx) => {
      handle(event, ctx);
      return void 0;
    }
  };
  api.on("message_received", async (event, ctx) => {
    await handlers.message_received(event, ctx);
  });
  api.on(
    "before_prompt_build",
    async (event, ctx) => {
      const r = await handlers.before_prompt_build(event, ctx);
      return r ?? void 0;
    },
    // The Gateway must wait for the full synchronous check window
    // (active-memory analogue; operators may still override per plugin).
    { timeoutMs: config.checkTimeoutMs + HOOK_GRACE_MS }
  );
  return { config, handle, handlePrompt, handlers };
}

// index.ts
var index_default = definePluginEntry({
  id: "visual-memory",
  name: "Visual Memory",
  description: "Checks inbound images against the local Visual Memory register and injects results into the next agent turn.",
  register(api) {
    registerMessageHook(api);
  }
});
export {
  index_default as default
};
