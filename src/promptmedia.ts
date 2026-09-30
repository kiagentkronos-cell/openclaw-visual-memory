/**
 * Inbound media-note parsing for prompt-level hook paths.
 *
 * Root-cause context (2026-09-29): on WhatsApp the `message_received` hook
 * never fires — the channel plugin suppresses it for privacy and requires
 * `channels.whatsapp.pluginHooks.messageReceived: true` (docs/channels/
 * whatsapp.md "Plugin hooks and privacy"; monitor: suppressMessageReceived
 * Hooks = true unless opted in). The channel-agnostic seam that DOES fire
 * for every admitted agent turn (webchat, WhatsApp, Discord, ...) is
 * `before_prompt_build` (agent-harness-runtime). Its event carries the
 * prompt, and the host prepends inbound media notes built by
 * auto-reply/media-note.ts:
 *
 *   [media attached: /abs/path/file.jpg (image/jpeg)]
 *   [media attached: media://inbound/uuid.jpg (image/jpeg)]
 *   [media attached: 2 files]
 *   [media attached 1/2: media://inbound/uuid.jpg (image/jpeg)]
 *
 * `media://inbound/<name>` is the host's managed-media alias for
 * <mediaDir>/inbound/<name> (~/.openclaw/media/inbound by default — the
 * same files WhatsApp wrote). This module turns those note lines back into
 * MediaFactLike entries (path + contentType + kind) so the rest of the
 * plugin can treat them exactly like typed `event.media` facts.
 *
 * The notes carry no mtime, so history re-projection of an old note cannot
 * retrigger a check through the age guard alone — the caller therefore also
 * claims image paths in the ledger (claimPath) before running a check.
 *
 * Hardening (Hyperion review 1c4c01d, Minor-1): the note text is user-prompt
 * content — anyone can type a `[media attached: /etc/passwd.jpg]` line. A
 * parsed local path is therefore only accepted when it lies BELOW an allowed
 * media store root. The check is path.resolve + prefix-test after resolve,
 * plus a realpath re-check for symlinks where realpath is available.
 * Everything else is dropped here (no fact, no ledger claim, no check).
 *
 * Root cause 2 (2026-09-30, WhatsApp silent path): on this host WhatsApp
 * inbound images are written to <workspaceDir>/media/inbound/ (e.g.
 * openclaw-media-TIMESTAMP-RAND.jpg DIRECTLY there, no openclaw-staged
 * subfolder), while the state media store is <stateDir>/media. The old gate
 * allowed ONLY the state media dir, so every real WhatsApp note resolved to
 * zero facts (prompt_fire without image_found, forever silent). The gate now
 * accepts an allow-LIST of roots (state media dir + workspace media dir);
 * absolute-path notes still need to be under one of them, so the typed-note
 * protection stays intact.
 */

import fs from "node:fs";
import path from "node:path";
import type { MediaFactLike } from "./media.ts";

/** Note line: single `[media attached: X]` or indexed `[media attached 1/2: X]`. */
const MEDIA_NOTE_LINE = /\[media attached(?:\s+\d+\/\d+)?:\s*([^\]]+)\]/gi;

const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif", ".tif", ".tiff",
]);

/** True when `resolved` is `base` itself or below it (both already resolved). */
function isUnder(base: string, resolved: string): boolean {
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return resolved === base || resolved.startsWith(prefix);
}

/**
 * Media-dir gate for note-carried local paths (Minor-1). Accepts only
 * absolute paths that canonicalize (path.resolve) to a location under one
 * of the allowed roots; a typed note pointing elsewhere (/etc/passwd.jpg,
 * /home/x/.ssh/id_rsa.jpg, `..` escapes) yields undefined. When the target
 * exists, realpath additionally pins symlinked files to an allowed root. A
 * missing file keeps the resolve-only verdict (checker.ts probes readable
 * existence later; history notes for deleted files must not be poisoned).
 */
function gateMediaPath(candidate: string, allowedDirs: string[]): string | undefined {
  if (!path.isAbsolute(candidate)) return undefined;
  const resolved = path.resolve(candidate);
  const bases = allowedDirs.map((d) => path.resolve(d)).filter((d) => d.length > 0);
  if (!bases.some((base) => isUnder(base, resolved))) return undefined;
  try {
    const real = fs.realpathSync(resolved);
    // Symlinked file: the canonical target must also lie inside a root.
    const realResolved = path.resolve(real);
    if (!bases.some((base) => isUnder(base, realResolved))) return undefined;
  } catch {
    // realpath unavailable (file missing, permissions): resolve verdict stands.
  }
  return resolved;
}

/** Kind guess from the file name when the note carries no mime. */
function kindFromPath(p: string): string | undefined {
  const ext = path.extname(p.trim()).toLowerCase();
  if (ext.length === 0) return undefined;
  return IMAGE_EXTENSIONS.has(ext) ? "image" : undefined;
}

/** Resolve one note payload (`X` from the brackets) into a media fact. */
function parseNotePayload(payload: string, ctx: ParseContext): MediaFactLike | undefined {
  let rest = payload.trim();
  if (rest.length === 0) return undefined;
  // A bare "N files" header line carries no path.
  if (/^\d+\s+files$/i.test(rest)) return undefined;

  // Strip an optional quoted file-name suffix (never a path).
  rest = rest.replace(/\s+"[^"]*"\s*$/, "").trim();

  // Optional " (mime)" part — may sit before or after a " | url" tail.
  let contentType: string | undefined;
  const withUrl = rest.split(/\s*\|\s*/);
  const primary = withUrl[0] ?? "";
  const url = withUrl.length > 1 ? withUrl.slice(1).join(" | ") : undefined;

  let pathPart = primary.trim();
  const mimeMatch = pathPart.match(/\s*\(([^()]*)\)\s*$/);
  if (mimeMatch) {
    contentType = mimeMatch[1]?.trim() || undefined;
    pathPart = pathPart.slice(0, mimeMatch.index).trim();
  }

  let factPath: string | undefined;
  let factUrl: string | undefined = url;
  const trimmed = pathPart.replace(/^"|"$/g, "").trim();
  if (trimmed.startsWith("media://inbound/")) {
    factPath = path.join(ctx.mediaDir, "inbound", path.basename(trimmed.slice("media://".length)));
  } else if (trimmed.includes("://")) {
    // Remote or other scheme: url-only, never a locally readable path.
    factUrl = factUrl ?? trimmed;
  } else if (trimmed.length > 0) {
    factPath = trimmed;
  } else if (factUrl) {
    // path empty, url present — url-only fact.
  } else {
    return undefined;
  }

  const kind = contentType
    ? contentType.toLowerCase().startsWith("image/")
      ? "image"
      : contentType.toLowerCase().startsWith("audio/")
        ? "audio"
        : contentType.toLowerCase().startsWith("video/")
          ? "video"
          : undefined
    : kindFromPath(factPath ?? trimmed);

  const fact: MediaFactLike = {};
  if (factPath) {
    // Minor-1 gate: only paths inside an allowed media store survive.
    const gated = gateMediaPath(factPath, ctx.allowedDirs);
    if (gated === undefined) {
      // Rejected local path: keep any independent url fact, otherwise drop
      // the note entirely (no fact, no claim, no check).
      if (!url) return undefined;
    } else {
      fact.path = gated;
    }
  }
  if (factUrl) fact.url = factUrl;
  if (contentType) fact.contentType = contentType;
  if (kind) fact.kind = kind;
  if (!fact.path && !fact.url) return undefined;
  return fact;
}

/** Parse context: alias base + allowed roots for the local-path gate. */
export interface ParseContext {
  /** Base for media://inbound aliases (the state media store). */
  mediaDir: string;
  /**
   * Roots a note-carried absolute path may lie under. On real hosts this
   * covers BOTH the state media store (<stateDir>/media) and the workspace
   * media dir (<workspaceDir>/media) — WhatsApp writes inbound images into
   * the workspace one (root cause 2, 2026-09-30).
   */
  allowedDirs: string[];
}

/** Back-compat: a bare mediaDir string is treated as the single allowed root. */
function asContext(ctx: string | ParseContext): ParseContext {
  if (typeof ctx === "string") return { mediaDir: ctx, allowedDirs: [ctx] };
  const allowedDirs = ctx.allowedDirs.length > 0 ? ctx.allowedDirs : [ctx.mediaDir];
  return { mediaDir: ctx.mediaDir, allowedDirs };
}

/**
 * Extract media facts from prompt text (and any message text the caller
 * wants scanned). Image facts have kind "image"; audio/video notes are
 * returned with their kind so callers can ignore them explicitly.
 * Order of appearance is preserved; duplicates (same path) are collapsed.
 */
export function promptMediaFacts(text: string, ctx: string | ParseContext): MediaFactLike[] {
  const context = asContext(ctx);
  const facts: MediaFactLike[] = [];
  const seen = new Set<string>();
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

/** Image-only convenience wrapper used by the prompt-build handler. */
export function promptImageFacts(text: string, ctx: string | ParseContext): MediaFactLike[] {
  return promptMediaFacts(text, ctx).filter((fact) => {
    if (fact.kind !== undefined) return fact.kind === "image";
    if (typeof fact.contentType === "string") {
      return fact.contentType.toLowerCase().startsWith("image/");
    }
    return false;
  });
}
