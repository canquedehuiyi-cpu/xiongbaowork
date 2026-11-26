/**
 * The marker header a browser adds to voice and dictation requests so a cross-origin HTML form (which
 * cannot set custom headers) is refused. The web app now sends `x-xiongbao-*`; the `x-openbot-*` spelling is
 * still accepted so a tab left open across an upgrade keeps working until it reloads.
 *
 * Only the web app sends this header; the device app and its runner never do.
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，the marker's spelling before the rename
 */
export function hasBrowserMarker(
  header: (name: string) => string | undefined,
  kind: "voice" | "dictation",
): boolean {
  return (
    header(`x-xiongbao-${kind}`) === "1" || header(`x-openbot-${kind}`) === "1"
  );
}
