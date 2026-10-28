import { isDocId } from "@collab/shared";

/**
 * The id to use for a `?doc=` value from the URL: the value itself if the server would accept
 * it, otherwise a fresh random one. (The server silently ignores a join it doesn't accept, so
 * an over-long or odd id from a hand-edited URL would otherwise leave the page "Connecting…"
 * forever.)
 */
export function pickDocId(fromUrl: string | null): string {
  return isDocId(fromUrl) ? fromUrl : Math.random().toString(36).slice(2, 8);
}

/**
 * The document ID lives in the URL (?doc=abc) so sharing the URL shares the document.
 * If there isn't a usable one, make a random ID and put it in the URL.
 */
export function getDocId(): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("doc");
  const docId = pickDocId(fromUrl);
  if (docId !== fromUrl) {
    params.set("doc", docId);
    window.history.replaceState(null, "", `?${params.toString()}`);
  }
  return docId;
}
