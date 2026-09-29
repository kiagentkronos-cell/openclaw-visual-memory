import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInjectionText, parseCheckOutput } from "../src/injection.ts";

test("hits produce compact hit block", () => {
  const outcome = parseCheckOutput(
    '{"ok":true,"hits":[{"name":"Alice","kind":"person","score":0.94,"confidence":"certain","scope":"private"}]}',
  );
  assert.equal(
    buildInjectionText(outcome),
    "[Visual Memory] Treffer: Alice (person, certain, 0.94)",
  );
});

test("multiple hits join with semicolon, public scope shown", () => {
  const outcome = parseCheckOutput(
    '{"ok":true,"hits":[{"name":"Bello","kind":"animal","score":0.87,"confidence":"possible"},{"name":"Einstein","kind":"person","score":0.91,"confidence":"certain","scope":"public"}]}',
  );
  assert.equal(
    buildInjectionText(outcome),
    "[Visual Memory] Treffer: Bello (animal, possible, 0.87); Einstein (person, certain, 0.91, public)",
  );
});

test("no hits produce explicit no-match block", () => {
  const outcome = parseCheckOutput('{"ok":true,"hits":[]}');
  assert.equal(buildInjectionText(outcome), "[Visual Memory] keine Treffer");
});

test("vm.py failure (ok=false) yields error outcome and NO injection", () => {
  const outcome = parseCheckOutput('{"ok":false,"error":"no face found"}');
  assert.equal(outcome.status, "error");
  assert.equal(buildInjectionText(outcome), undefined);
});

test("garbage stdout is an error and yields no injection", () => {
  for (const bad of ["", "   ", "not json", "42", '{"ok":true}']) {
    const outcome = parseCheckOutput(bad);
    assert.equal(outcome.status, "error", `input=${JSON.stringify(bad)}`);
    assert.equal(buildInjectionText(outcome), undefined);
  }
});

test("hit rows without a usable name are dropped, rest survives", () => {
  const outcome = parseCheckOutput(
    '{"ok":true,"hits":[{"kind":"person","score":0.5,"confidence":"certain"},{"name":"Anna","kind":"person","score":0.8,"confidence":"certain"}]}',
  );
  assert.equal(buildInjectionText(outcome), "[Visual Memory] Treffer: Anna (person, certain, 0.80)");
});

test("timeout/crash mapping: caller error outcome injects nothing", () => {
  assert.equal(buildInjectionText({ status: "error", reason: "timeout" }), undefined);
});
