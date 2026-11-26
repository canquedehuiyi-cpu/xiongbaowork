/**
 * The marker header a browser adds to voice and dictation requests so a cross-origin HTML form (which
 * cannot set custom headers) is refused: `x-xiongbao-voice` or `x-xiongbao-dictation`, set to `1`.
 *
 * Only the web app sends this header; the device app and its runner never do.
 */
export function hasBrowserMarker(
  header: (name: string) => string | undefined,
  kind: "voice" | "dictation",
): boolean {
  return header(`x-xiongbao-${kind}`) === "1";
}
