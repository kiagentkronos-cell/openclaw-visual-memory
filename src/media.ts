/**
 * Media classification for inbound hook facts.
 *
 * Decides which typed media facts are locally-checkable images.
 * Rules (from the hook docs):
 * - kind === "image" wins; otherwise contentType starting with "image/"
 * - a fact needs a local `path` to be checkable (url-only is not readable)
 * - kind audio/video/document/sticker/unknown are never images
 */

export interface MediaFactLike {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: string;
}

/** True when the fact should be treated as an image attachment. */
export function isImageFact(fact: MediaFactLike): boolean {
  if (fact.kind !== undefined) {
    return fact.kind === "image";
  }
  return typeof fact.contentType === "string" && fact.contentType.toLowerCase().startsWith("image/");
}

/** Locally readable image paths from an ordered media-fact list. */
export function localImagePaths(media: MediaFactLike[] | undefined): string[] {
  if (!Array.isArray(media)) {
    return [];
  }
  const paths: string[] = [];
  for (const fact of media) {
    if (isImageFact(fact) && typeof fact.path === "string" && fact.path.length > 0) {
      paths.push(fact.path);
    }
  }
  return paths;
}
