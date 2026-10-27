/**
 * The document ID lives in the URL (?doc=abc) so sharing the URL shares the document.
 * If there isn't one, make a random ID and put it in the URL.
 */
export function getDocId(): string {
  const params = new URLSearchParams(window.location.search);
  let docId = params.get("doc");
  if (!docId) {
    docId = Math.random().toString(36).slice(2, 8);
    params.set("doc", docId);
    window.history.replaceState(null, "", `?${params.toString()}`);
  }
  return docId;
}
