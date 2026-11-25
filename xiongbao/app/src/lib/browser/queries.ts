export const browserKeys = {
  all: ["browser"] as const,
};

/** How often a browser's state is asked again while it is on screen, the same once a second the computer's control
 * state is read. */
export const BROWSER_POLL_MS = 1000;
