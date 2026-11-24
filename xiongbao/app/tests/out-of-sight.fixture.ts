/**
 * The person is not looking at the app: its tab is hidden, or another app is in front. Notices are
 * for then; a person looking at the app sees the badge and the conversation instead. `look()` puts
 * the app back in sight.
 */
export function outOfSight() {
  let visibility: DocumentVisibilityState = "hidden";
  let focused = false;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  document.hasFocus = () => focused;
  return {
    look() {
      visibility = "visible";
      focused = true;
    },
    away() {
      visibility = "hidden";
      focused = false;
    },
  };
}
