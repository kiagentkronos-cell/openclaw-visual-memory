/**
 * Injection block builder.
 *
 * Turns vm.py `check` results into the compact context block that is queued
 * for the next agent turn. Three modes (fixed contract, tested; operator
 * protocol change 2026-09-29 — every processed image message reports its
 * outcome so the agent can tell "checked, nothing found" from "not checked"):
 *
 *   [Visual Memory] Treffer: Alice (person, certain, 0.94); Bello (animal, possible, 0.87)
 *   [Visual Memory] keine Treffer                       (check ran, zero hits)
 *   [Visual Memory] Check nicht verf\u00fcgbar (timeout)             (status unknown — do NOT re-check manually)
 *   [Visual Memory] Check nicht verf\u00fcgbar (fehler: exit_code)
 *
 * The token in parentheses is machine-readable (timeout | fehler: <reason>);
 * the agent must treat "nicht verf\u00fcgbar" as UNKNOWN state and must not
 * re-run the check itself (that would double GPU work). Messages WITHOUT
 * images still inject nothing at all.
 */

export interface VmHit {
  name: string;
  kind: string;
  score: number;
  confidence: string;
  scope?: string;
}

/** One parsed vm.py check outcome. */
export type VmCheckOutcome =
  | { status: "ok"; hits: VmHit[] }
  | { status: "error"; reason: string };

/** Prefix used in every injected block. */
export const INJECTION_PREFIX = "[Visual Memory]";

/** Format one hit as `Name (kind, confidence, score)`; scope appended when public. */
function formatHit(hit: VmHit): string {
  const score = Number.isFinite(hit.score) ? hit.score.toFixed(2) : "?";
  const scope = hit.scope && hit.scope !== "private" ? `, ${hit.scope}` : "";
  return `${hit.name} (${hit.kind}, ${hit.confidence}, ${score}${scope})`;
}

/**
 * Parse the stdout of `vm.py check` into an outcome.
 * Expects one JSON line: {"ok":true,"hits":[...]} — anything else is an error.
 */
export function parseCheckOutput(stdout: string): VmCheckOutcome {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { status: "error", reason: "empty output" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { status: "error", reason: "invalid JSON output" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { status: "error", reason: "non-object output" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.ok !== true) {
    return { status: "error", reason: "vm.py reported failure" };
  }
  if (!Array.isArray(obj.hits)) {
    // ok=true without a hits array is a contract violation, not a vm failure.
    return { status: "error", reason: "invalid JSON output" };
  }
  const hits: VmHit[] = [];
  for (const raw of obj.hits) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const hit = raw as Record<string, unknown>;
    if (typeof hit.name !== "string" || hit.name.length === 0) {
      continue;
    }
    hits.push({
      name: hit.name,
      kind: typeof hit.kind === "string" ? hit.kind : "unknown",
      score: typeof hit.score === "number" ? hit.score : Number.NaN,
      confidence: typeof hit.confidence === "string" ? hit.confidence : "unknown",
      scope: typeof hit.scope === "string" ? hit.scope : undefined,
    });
  }
  return { status: "ok", hits };
}

/**
 * Build the next-turn injection text from a check outcome.
 * Every image message gets exactly one line — hits, "keine Treffer", or the
 * explicit "Check nicht verf\u00fcgbar" marker. Undefined only when there is
 * nothing to report at all (no image was processed); the caller never
 * receives undefined for a processed image message.
 */
export function buildInjectionText(outcome: VmCheckOutcome): string {
  if (outcome.status === "error") {
    return `${INJECTION_PREFIX} ${unavailableText(outcome.reason)}`;
  }
  if (outcome.hits.length === 0) {
    return `${INJECTION_PREFIX} keine Treffer`;
  }
  const formatted = outcome.hits.map(formatHit).join("; ");
  return `${INJECTION_PREFIX} Treffer: ${formatted}`;
}

/**
 * Internal marker for "status unknown — do not re-check manually".
 * `timeout` stays a bare token; every other failure is `fehler: <token>`.
 * The reason token is machine-readable and PII-free (see checker reasons).
 */
export function unavailableText(reason: string): string {
  const lowered = reason.toLowerCase();
  if (lowered.includes("timed out") || lowered.includes("timeout")) {
    return "Check nicht verf\u00fcgbar (timeout)";
  }
  return `Check nicht verf\u00fcgbar (fehler: ${sanitizeReasonToken(reason)})`;
}

/** Compact greppable token from a checker reason string. */
function sanitizeReasonToken(reason: string): string {
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
  // Fall back to a short sanitized prefix; never raw free text.
  return reason.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 24) || "error";
}
