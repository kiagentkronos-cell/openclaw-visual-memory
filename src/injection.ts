/**
 * Injection block builder.
 *
 * Turns vm.py `check` results into the compact context block that is queued
 * for the next agent turn. Format (fixed contract, tested):
 *
 *   [Visual Memory] Treffer: Alice (person, certain, 0.94); Bello (animal, possible, 0.87)
 *   [Visual Memory] keine Treffer
 *
 * Failure policy: when the CLI call failed (ok=false, timeout, crash, invalid
 * JSON) the plugin injects NOTHING — a failed check must never look like a
 * "no hits" result (rule: never invent). This module therefore returns
 * undefined for failures; the caller logs.
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
  if (obj.ok !== true || !Array.isArray(obj.hits)) {
    return { status: "error", reason: "vm.py reported failure" };
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
 * Returns undefined when nothing must be injected (error case).
 */
export function buildInjectionText(outcome: VmCheckOutcome): string | undefined {
  if (outcome.status !== "ok") {
    return undefined;
  }
  if (outcome.hits.length === 0) {
    return `${INJECTION_PREFIX} keine Treffer`;
  }
  const formatted = outcome.hits.map(formatHit).join("; ");
  return `${INJECTION_PREFIX} Treffer: ${formatted}`;
}
