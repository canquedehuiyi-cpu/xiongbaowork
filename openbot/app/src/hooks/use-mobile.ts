import * as React from "react";

const MOBILE_BREAKPOINT = 768;

const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribe(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/*
 * The media query itself answers, read on the first render too: a phone draws its own layout from
 * the start instead of flashing the desktop one for a frame, and a test can stand in for a phone by
 * answering this one query.
 */
function isMobileNow() {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(MOBILE_QUERY).matches
    : false;
}

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, isMobileNow, () => false);
}
