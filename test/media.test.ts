import { test } from "node:test";
import assert from "node:assert/strict";
import { isImageFact, localImagePaths } from "../src/media.ts";

test("kind=image fact with local path is a checkable image", () => {
  assert.equal(isImageFact({ kind: "image", path: "/tmp/a.jpg" }), true);
  assert.deepEqual(localImagePaths([{ kind: "image", path: "/tmp/a.jpg" }]), ["/tmp/a.jpg"]);
});

test("contentType image/* without kind counts as image", () => {
  assert.equal(isImageFact({ contentType: "image/jpeg" }), true);
  assert.deepEqual(localImagePaths([{ contentType: "image/png", path: "/tmp/b.png" }]), ["/tmp/b.png"]);
});

test("non-image kinds are never images", () => {
  for (const kind of ["audio", "video", "document", "sticker", "unknown"]) {
    assert.equal(isImageFact({ kind, contentType: "image/jpeg" }), false, `kind=${kind}`);
  }
  assert.deepEqual(localImagePaths([{ kind: "audio", path: "/tmp/x.ogg", contentType: "image/jpeg" }]), []);
});

test("image fact without local path is not checkable", () => {
  assert.deepEqual(localImagePaths([{ kind: "image", url: "https://example.com/x.jpg" }]), []);
});

test("media undefined or empty yields no images", () => {
  assert.deepEqual(localImagePaths(undefined), []);
  assert.deepEqual(localImagePaths([]), []);
});

test("multiple images keep source order", () => {
  const media = [
    { kind: "image", path: "/tmp/1.jpg" },
    { kind: "document", path: "/tmp/doc.pdf" },
    { kind: "image", path: "/tmp/2.jpg" },
  ];
  assert.deepEqual(localImagePaths(media), ["/tmp/1.jpg", "/tmp/2.jpg"]);
});
