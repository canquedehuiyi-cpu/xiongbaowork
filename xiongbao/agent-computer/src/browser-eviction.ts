/**
 * Which Bots' browsers to close, and when, and which of a Bot's tabs.
 *
 * Its own file, with no Playwright import, for the reason `authorisation.ts` and `bot-id.ts` are:
 * `profiles.ts` imports Playwright at module scope, so anything living there needs a browser merely
 * to be imported by a test. A decision this size should be testable without one, and `profiles.ts`
 * owns the launching, so a test that went through it would be testing Playwright rather than the
 * choice being made.
 *
 * The choice is worth testing on its own. There was no cap and no timeout: a context was started the
 * first time each Bot was used and kept, and the only things that dropped one were an explicit stop,
 * a browser that had already died, and shutdown. A deployment where every employee has a Bot trends
 * toward one resident Chromium per employee in a single container, at a few hundred MB each, until
 * it is killed for memory and relaunches its way back to the same state.
 *
 * Closing one loses nothing. The profile is on disk, so the Bot's logins survive and its next request
 * starts where it left off, which is already what `stop` means here.
 */

/** Enough of a live entry for either decision. Keeps this file independent of what else is on one. */
export type Evictable = { usedAt: number };

/**
 * Which to close because there are too many running.
 *
 * Least recently used first: the Bot that has been quiet longest. Applied after a launch, so the Bot
 * that just asked is the most recently used and is therefore never the one closed.
 */
export function chooseEvictions(
  running: Iterable<[string, Evictable]>,
  max: number,
): string[] {
  const entries = [...running];
  if (entries.length <= max) return [];
  // A cap of zero keeps nothing, the newest included; that is the mistake reading the setting guards.
  const newest = max > 0 ? newestOf(entries) : undefined;

  return inClosingOrder(entries, newest)
    .slice(0, entries.length - max)
    .map(([botId]) => botId);
}

/** The most recently used, which is the one a launch has just added. Ties go to the later entry. */
function newestOf(
  entries: [string, Evictable][],
): [string, Evictable] | undefined {
  if (entries.length === 0) return undefined;
  return entries.reduce((latest, entry) =>
    entry[1].usedAt >= latest[1].usedAt ? entry : latest,
  );
}

/**
 * The order browsers are closed in when some have to go: least recently used first. `spare` is left
 * out, which is the newest.
 */
function inClosingOrder(
  entries: [string, Evictable][],
  spare: [string, Evictable] | undefined,
): [string, Evictable][] {
  return entries
    .filter((entry) => entry !== spare)
    .sort(([, a], [, b]) => a.usedAt - b.usedAt);
}

/**
 * How long after its last use a browser still counts as in use, and so is never closed for memory.
 *
 * A browser's use is recorded when something asks for its page: a Bot's step, a person's input, the
 * live screen. Between two steps a Bot asks for nothing while its model works out the next one, which
 * can take tens of seconds, and nothing here can tell that pause from a Bot that has finished.
 * Closing the browser then closes it in the middle of a run: the page the Bot was on is gone, and its
 * next step starts a cold browser, which is the very jump in memory the close was meant to head off.
 * A minute covers a model's turn between steps. It also covers a browser that has just launched, so
 * the next launch never closes the one before it, which is what would otherwise turn a full computer
 * into a loop of each Bot's launch closing the last Bot's browser.
 */
export const RECENTLY_USED_MS = 60_000;

/**
 * Which to close next because the computer's memory runs high (`container-memory.ts`).
 *
 * One at a time, because the caller reads memory again after each close and stops as soon as it is
 * enough: a count says in advance how many have to go, and bytes do not. Least recently used first,
 * the cap's order, so the two never disagree about who goes first.
 *
 * Never a browser in use, which here means four things:
 *   - The one being launched. The caller runs this before a launch and passes only the browsers
 *     already running, so the Bot that asked is not among them.
 *   - The most recently used of those, however long ago that was. So at least one browser is always
 *     left, because one browser that is on its own too big for the computer is the limit's problem,
 *     and closing it would only start it again on its next step.
 *   - Any used within `recentlyUsedMs` ({@link RECENTLY_USED_MS}), which is a Bot in the middle of a
 *     run or a browser that has just started.
 *   - Any `spared` names, which is a Bot whose wheel a person holds or has been asked to take: closing
 *     it closes it under somebody's hands, or under a page the Bot is waiting for somebody to work.
 */
export function chooseForMemory(
  running: Iterable<[string, Evictable]>,
  now: number,
  {
    recentlyUsedMs = RECENTLY_USED_MS,
    spared = () => false,
  }: {
    recentlyUsedMs?: number;
    spared?: (botId: string) => boolean;
  } = {},
): string | undefined {
  const entries = [...running];
  const cutoff = now - recentlyUsedMs;
  return inClosingOrder(entries, newestOf(entries))
    .filter(([botId, entry]) => entry.usedAt <= cutoff && !spared(botId))
    .map(([botId]) => botId)
    .at(0);
}

/**
 * Which to close because nothing has touched them.
 *
 * The other half of the answer: a deployment under the cap still holds a browser for a Bot used once
 * last Tuesday, and that memory is doing nothing for anybody. A timeout of zero or less switches this
 * off, so a deployment can keep browsers resident if it would rather.
 */
export function chooseIdle(
  running: Iterable<[string, Evictable]>,
  idleTimeoutMs: number,
  now: number,
): string[] {
  if (idleTimeoutMs <= 0) return [];
  const cutoff = now - idleTimeoutMs;

  return [...running]
    .filter(([, entry]) => entry.usedAt <= cutoff)
    .map(([botId]) => botId);
}

/** Enough of a tab for the choice. Keeps this file independent of what else is on a page. */
export type IdleTab = {
  /** When the Bot or a person last acted on it, it navigated, or it was the page in front. */
  usedAt: number;
  /** The page the Bot is on, which is the one the live screen shows and its next action lands in. */
  front: boolean;
  /** A page that is never the Bot's to lose: an extension's own or DevTools. */
  kept?: boolean;
};

/**
 * Which of a Bot's background tabs to close because nothing has touched them.
 *
 * A Bot is always on its newest page (`chooseLivePage`): a window a site opens is where its work
 * went, and it has no way back to an older tab except that newer ones close. So a tab left behind
 * (the page a sign-in popup was opened from, a link that opened in a new tab and was never closed)
 * holds a renderer and its memory for nothing, for as long as the browser stays up. Closed past a
 * timeout rather than at once, because an opener whose popup is still mid sign-in is waiting for
 * that popup to come back to it.
 *
 * Never the page in front, which is the one the Bot is on, so closing tabs never moves it: it stays
 * the newest open page, which is what the Bot follows. And never anything when which page is in
 * front is not exactly one, because then any tab could be the one the Bot is on. That also means the
 * last tab is never closed, since a single tab is the one in front. A timeout of zero or less
 * switches this off.
 */
export function chooseIdleTabs<T extends IdleTab>(
  tabs: readonly T[],
  idleTimeoutMs: number,
  now: number,
): T[] {
  if (idleTimeoutMs <= 0) return [];
  if (tabs.filter((tab) => tab.front).length !== 1) return [];
  const cutoff = now - idleTimeoutMs;
  return tabs.filter((tab) => !tab.front && !tab.kept && tab.usedAt <= cutoff);
}
