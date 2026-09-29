import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promptImageFacts } from "../src/promptmedia.ts";

const MEDIA_DIR = "/home/tester/.openclaw/media";

test("extracts an absolute image path with mime from the media note", () => {
  const prompt = [
    "[media attached: /home/tester/.openclaw/media/inbound/381271d0.jpg (image/jpeg)]",
    "Wer ist auf dem Foto?",
  ].join("\n");
  const facts = promptImageFacts(prompt, MEDIA_DIR);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.path, "/home/tester/.openclaw/media/inbound/381271d0.jpg");
  assert.equal(facts[0]!.kind, "image");
});

test("resolves media://inbound refs against the media dir", () => {
  const prompt = '[media attached: media://inbound/abc123.jpg (image/jpeg)]';
  const facts = promptImageFacts(prompt, MEDIA_DIR);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.path, path.join(MEDIA_DIR, "inbound", "abc123.jpg"));
  assert.equal(facts[0]!.kind, "image");
});

test("multi-file header lists each file with indexed lines", () => {
  const prompt = [
    "[media attached: 2 files]",
    "[media attached 1/2: media://inbound/one.jpg (image/jpeg)]",
    "[media attached 2/2: media://inbound/two.ogg (audio/ogg)]",
    "hi",
  ].join("\n");
  const facts = promptImageFacts(prompt, MEDIA_DIR);
  const images = facts.filter((f) => f.kind === "image");
  assert.equal(images.length, 1);
  assert.equal(images[0]!.path, path.join(MEDIA_DIR, "inbound", "one.jpg"));
});

test("audio and document notes are never images", () => {
  const prompt = "[media attached: media://inbound/voice.ogg (audio/ogg)]\nhallo";
  const facts = promptImageFacts(prompt, MEDIA_DIR);
  assert.equal(facts.filter((f) => f.kind === "image").length, 0);
});

test("extension-only facts without mime count as images", () => {
  const prompt = "[media attached: /tmp/photo.PNG]";
  const facts = promptImageFacts(prompt, MEDIA_DIR);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.kind, "image");
});

test("no media note means no facts", () => {
  assert.deepEqual(promptImageFacts("ganz normaler text", MEDIA_DIR), []);
});
