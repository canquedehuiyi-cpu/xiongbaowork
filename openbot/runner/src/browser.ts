import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { BrowserContext, Page } from "playwright-core";
import {
  cutAtCodeUnits,
  parseAriaSnapshot,
  type SnapshotElement,
} from "../../agent-computer/src/aria-snapshot";
import { chooseLivePage } from "../../agent-computer/src/live-page";
import { checkNavigationTarget } from "../../server/src/computer/target";

/**
 * A real browser on the owner's own machine, driven for one named coworker (C3).
 *
 * The container's computer (`agent-computer`) answers HTTP and holds every Bot's browser in one pod.
 * A runner is the opposite shape: it lives on a laptop, has no port, and drives the machine's own
 * browser. The contract the server sends down the socket is the same either way, which is the whole
 * point of the transport seam — the gateway already decided and recorded this action before framing
 * it, so nothing here judges permission.
 *
 * What is genuinely different, and what this file therefore exists to get right:
 *
 *  - **Who it belongs to.** A container's Bots are separated by a directory name the container made
 *    up. Here the same process serves several coworkers on a machine that has their real logins on
 *    it, so a profile is keyed by a hash of the injected `tenantId` and `botId` only. A caller's own
 *    path or identity never selects one, and a missing identity is refused rather than defaulted:
 *    "the shared profile" on a person's laptop is a room where every coworker's cookies are one jar.
 *  - **Nothing durable about the process.** A laptop sleeps, an app updates, the runner is restarted
 *    by hand. A generation counter kept in memory restarts at one every time, and a ref from the run
 *    before then resolves against whatever page the new run happens to be on. The counter is
 *    therefore on disk, and a run token on every ref.
 *  - **A browser somebody else installed.** There is no image to bake Chromium into and no browser is
 *    downloaded here: by default this drives the Chrome the owner installed, in a window they can see,
 *    and a machine without one is answered in words rather than by a stack trace. Nothing on this
 *    machine is a browser we shipped, so nothing here may pretend to own its updates either.
 */

/** The actions this module answers. Everything else stays with the shell and the workspace. */
export const BROWSER_ACTIONS = new Set([
  "navigate",
  "read",
  "snapshot",
  "screenshot",
  "click",
  "type",
  "key",
  "scroll",
]);

/**
 * The viewport, and the same one the container's computer uses.
 *
 * It is not a preference: a screenshot's `width`/`height` are reported from it, and a person's later
 * click coordinates are relative to it. Two different numbers on the two backends would make one
 * tool contract mean two things.
 */
const VIEWPORT = { width: 1280, height: 800 };

/** How much page text one read or navigation hands back. Bounded because it goes into a model. */
const TEXT_EXTRACT_LIMIT = 6_000;
/** A click is not a page load: a ref that no longer names anything must be refused in seconds. */
const ACTION_TIMEOUT_MS = 10_000;
const NAVIGATE_TIMEOUT_MS = 30_000;
/** A cold Chromium on a laptop, not a warm container. Generous, and still bounded. */
const LAUNCH_TIMEOUT_MS = 60_000;
/** How long a browser is given to flush its profile before a shutdown or an eviction moves on. */
const CLOSE_TIMEOUT_MS = 5_000;
/** A laptop is not a pod: two resident browsers is already a lot of memory for a person's machine. */
const MAX_LIVE_BROWSERS = 2;

/**
 * The ceiling of the generation the server stores.
 *
 * `computer_snapshot.snapshot_id` is a Postgres `integer`, so a number above this is a row that cannot
 * be written: the snapshot would be produced, handed to the model, and then fail to store, leaving
 * refs that resolve against nothing. Failing closed at the counter keeps that combination unreachable.
 */
export const MAX_SNAPSHOT_GENERATION = 2_147_483_647;

/**
 * The browser a native runner uses when the owner names none.
 *
 * Installed Chrome, in a window the person can see. Headless is the container's convenience and this
 * machine's lie: an assistant driving a browser nobody is watching cannot be stopped by the person
 * whose laptop it is, and a site that shows a challenge has nobody to answer it. A window is also the
 * only way a sign-in stays the owner's own doing.
 */
export const DEFAULT_BROWSER_CHANNEL = "chrome";

/**
 * What `playwright-core` adds by default, and this takes back.
 *
 * `launchPersistentContext` passes `--password-store=basic` and `--use-mock-keychain` on Linux and
 * macOS, because the pod it was written for has no keyring to talk to. On a person's machine those two
 * switches move saved logins out of the OS keychain and into a plaintext store in this profile
 * directory. A comment saying the sandbox stays on changes no arguments; this one does.
 */
const KEYCHAIN_DEFAULT_ARGS = [
  "--password-store=basic",
  "--use-mock-keychain",
];

/**
 * The attribute, the placeholder and the selector, restated from `agent-computer/src/secret-masking`.
 *
 * Duplicated under compulsion, not inattentively: that file types its page against `playwright`, and
 * this process has `playwright-core` and no `playwright` package at all. Even a type-only import of
 * the missing name fails to resolve, so importing the rule would make the runner unbuildable. The
 * three values are the contract a person reads on screen, so they are written down here with the same
 * spelling and the tests that cover them are in `server/tests/runner-browser.test.ts`.
 */
const SECRET_ATTRIBUTE = "data-openbot-secret";
const MASKED_VALUE = "[hidden: sensitive field]";
const SENSITIVE_FIELD_SELECTOR = [
  "input[type=password]",
  'input[autocomplete~="one-time-code"]',
  'input[autocomplete~="current-password"]',
  'input[autocomplete~="new-password"]',
  'input[autocomplete~="cc-number"]',
  'input[autocomplete~="cc-csc"]',
  `[${SECRET_ATTRIBUTE}]`,
].join(", ");
/** The roles whose snapshot `value` is text somebody typed. */
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

const STOPPED_BEFORE_EXECUTION =
  "The device action was stopped before execution.";
const NO_IDENTITY =
  "A browser action has to name the coworker it belongs to, and this one did not, so nothing was opened.";

/** A refusal the person reading the transcript can act on. Never a stack. */
export class BrowserFailure extends Error {
  /**
   * Whether the machine may have changed anyway.
   *
   * Set only for a call that had already reached the page when it was cancelled: the click may have
   * landed, and the safe answer is the one that stops the device until its owner looks. A navigation
   * that was cancelled costs a reload and is NOT this — marking it unknown would pause a person's
   * machine every time they pressed Stop, which is a cost with no matching benefit.
   */
  readonly outcomeUnknown: boolean;

  constructor(message: string, outcomeUnknown = false) {
    super(message);
    this.name = "BrowserFailure";
    this.outcomeUnknown = outcomeUnknown;
  }
}

export type BrowserIdentity = { tenantId: string; botId: string };

/**
 * Whose browser this is, read from the fields only the server can have written.
 *
 * The transport overwrites `tenantId` and `botId` with the device's own tenant and the Bot the
 * gateway authenticated, so by the time a frame arrives these are facts about the request rather than
 * claims inside it. There is deliberately no fallback profile: on a shared laptop, "unspecified" would
 * mean every coworker's traffic lands in one jar of cookies.
 */
export function browserIdentityOf(
  payload: Record<string, unknown>,
): BrowserIdentity {
  const tenantId =
    typeof payload.tenantId === "string" ? payload.tenantId.trim() : "";
  const botId = typeof payload.botId === "string" ? payload.botId.trim() : "";
  if (!tenantId || !botId) throw new BrowserFailure(NO_IDENTITY);
  return { tenantId, botId };
}

/**
 * The profile directory name for one coworker.
 *
 * Hashed, so a Bot id can never be a path: `../../` and a Windows drive name and an over-long name all
 * become 64 hex characters. The tenant is in the hash because a device belongs to one tenant, but a
 * Bot id is only unique per tenant, and a runner pointed at a second deployment must not meet a
 * same-named Bot's profile.
 */
function profileKeyOf(identity: BrowserIdentity): string {
  return createHash("sha256")
    .update(`${identity.tenantId}\u0000${identity.botId}`)
    .digest("hex");
}

export type BrowserRequest = {
  action: string;
  identity: BrowserIdentity;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
};

export type RunnerBrowser = {
  act: (request: BrowserRequest) => Promise<unknown>;
  close: () => Promise<void>;
};

/** The parts of a page this module drives. Enough for a test to stand in for a browser. */
type CallOptions = { timeout?: number; signal?: AbortSignal };

type OwnedLocator = {
  count(): Promise<number>;
  click(options: CallOptions): Promise<void>;
  fill(value: string, options: CallOptions): Promise<void>;
  press(key: string, options: CallOptions): Promise<void>;
  /** Whether the element is one whose contents are never read back. Fails closed when unsure. */
  holdsSecret(): Promise<boolean>;
};

type OwnedPage = {
  url(): string;
  title(): Promise<string>;
  isClosed(): boolean;
  ariaYaml(): Promise<string>;
  readableText(): Promise<string>;
  navigate(
    url: string,
    options: { timeout: number; signal?: AbortSignal },
  ): Promise<void>;
  png(maskSelector: string): Promise<Uint8Array>;
  viewportSize(): { width: number; height: number };
  byRef(rawRef: string): OwnedLocator;
  pressKey(key: string): Promise<void>;
  insertText(text: string): Promise<void>;
  wheel(deltaY: number): Promise<void>;
};

type OwnedContext = {
  pages(): OwnedPage[];
  close(): Promise<void>;
  onClose(listener: () => void): void;
};

export type BrowserLaunchOptions = {
  headless: boolean;
  timeoutMs: number;
  executablePath?: string;
  channel?: string;
};

/**
 * How a browser comes into existence.
 *
 * A seam, not an abstraction for its own sake: a test that drove a real Chrome could not assert that a
 * ref from a dead run is refused, because it would have to kill and restart a browser mid-assertion,
 * and the CI suite must never launch the machine's own browser. The real path is exercised by
 * `scripts/ci/runner-browser-probe.ts`, which says out loud that it is a real browser.
 */
export type BrowserLauncher = (
  profileDir: string,
  options: BrowserLaunchOptions,
) => Promise<OwnedContext>;

/** Exactly what `launchPersistentContext` is handed. Named so the builder can be tested. */
type PlaywrightLaunchOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
>;

/*
 * The page-side readings. Each is handed to `locator.evaluate` / `page.evaluate` and so must not
 * close over anything in this module — Playwright serialises the function and runs it in the page.
 */
function elementHoldsSecret(element: Element, selector: string): boolean {
  return element.matches(selector);
}

function pageText(): string {
  const clone = document.body?.cloneNode(true) as HTMLElement | undefined;
  if (!clone) return "";
  for (const node of clone.querySelectorAll("script, style, noscript, svg")) {
    node.remove();
  }
  return clone.innerText ?? "";
}

export function ownedContextOf(context: BrowserContext): OwnedContext {
  /*
   * One wrapper per real page, kept.
   *
   * `pages()` hands back Playwright's page objects, and the wrapper below is a new object each time it
   * is built. The caller compares wrappers to tell whether the page it was driving has been replaced,
   * so a fresh wrapper for an unchanged page reads as a new tab: every second action would retire a
   * generation that had not changed and refuse refs that were still good.
   */
  const wrappers = new WeakMap<Page, OwnedPage>();
  const buildPage = (page: Page): OwnedPage => {
    const locatorOf = (selector: string): OwnedLocator => {
      const locator = page.locator(selector);
      return {
        count: () => locator.count(),
        click: (options) => locator.click(options),
        fill: (value, options) => locator.fill(value, options),
        press: (key, options) => locator.press(key, options),
        // Unaskable means hidden. Losing an ordinary value is a small cost; showing a password is not.
        holdsSecret: () =>
          locator
            .evaluate(elementHoldsSecret, SENSITIVE_FIELD_SELECTOR)
            .catch(() => true),
      };
    };
    return {
      url: () => page.url(),
      title: () => page.title(),
      isClosed: () => page.isClosed(),
      ariaYaml: () => page.ariaSnapshot({ mode: "ai" }),
      readableText: () => page.evaluate(pageText),
      navigate: (url, options) =>
        page
          .goto(url, {
            waitUntil: "domcontentloaded",
            timeout: options.timeout,
            ...(options.signal ? { signal: options.signal } : {}),
          })
          .then(() => undefined),
      png: (maskSelector) =>
        page.screenshot({
          type: "png",
          mask: [page.locator(maskSelector)],
        }),
      viewportSize: () => page.viewportSize() ?? VIEWPORT,
      byRef: (rawRef) => locatorOf(`aria-ref=${rawRef}`),
      pressKey: (key) => page.keyboard.press(key),
      insertText: (text) => page.keyboard.insertText(text),
      wheel: (deltaY) => page.mouse.wheel(0, deltaY),
    };
  };

  const wrapped = (page: Page): OwnedPage => {
    const held = wrappers.get(page);
    if (held) return held;
    const made = buildPage(page);
    wrappers.set(page, made);
    return made;
  };

  return {
    pages: () => context.pages().map(wrapped),
    close: () => context.close(),
    onClose: (listener) => {
      context.on("close", listener);
    },
  };
}

/**
 * The arguments a browser on this machine is started with.
 *
 * Split out from the launch itself because the promises this module makes about a person's own Chrome
 * live here rather than in the call, and a test that stands in for the browser cannot prove what the
 * real launcher passes. It is the whole of `launchPersistentContext`'s second argument, so the test
 * that reads it is reading the truth.
 */
export function playwrightLaunchOptions(
  options: BrowserLaunchOptions,
): PlaywrightLaunchOptions {
  return {
    headless: options.headless,
    timeout: options.timeoutMs,
    viewport: VIEWPORT,
    chromiumSandbox: true,
    ignoreDefaultArgs: KEYCHAIN_DEFAULT_ARGS,
    // This process owns shutdown. Playwright's own handlers kill Chromium on SIGINT before its
    // profile has flushed, which on a laptop means losing the logins of a person who is typing Ctrl-C
    // to stop the runner.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    ...(options.executablePath
      ? { executablePath: options.executablePath }
      : {}),
    ...(options.channel ? { channel: options.channel } : {}),
  };
}

/**
 * The owner's own browser, on the owner's own machine.
 *
 * `chromiumSandbox` stays on, and the container's escape hatches are absent, deliberately:
 * `--no-sandbox` exists only because Docker's default seccomp profile blocks the syscall Chromium's
 * sandbox needs, and `--disable-dev-shm-usage` only because a container has a small `/dev/shm`. A
 * laptop has neither problem. The two keychain switches Playwright adds by default are taken back in
 * `playwrightLaunchOptions`, because here they would move a person's saved logins into plaintext.
 *
 * The automation flags the container drops (`--enable-automation`, Blink's AutomationControlled) are
 * NOT dropped here either. They exist so a person who takes the wheel can sign in at a site that
 * refuses obvious automation, and this path has no takeover screen yet — that is a separate delivery
 * item. Until a human can drive this window, hiding that it is driven would buy nothing and cost an
 * honest signal.
 */
const launchOnThisMachine: BrowserLauncher = async (profileDir, options) => {
  /*
   * Asked for here, not imported at the top of the file.
   *
   * `playwright-core` is a large module and this machine's Bun is measurably slow to bring it up — on
   * Windows it did not finish loading in 149 seconds, where Node finished in under two. Imported at
   * module scope that cost would sit in front of every ordinary command this runner answers, so a
   * person running `exec` would wait for a browser they never asked for. Loaded on the way to the one
   * action that needs it, inside the launch's own bound, a browser that will not come up is refused in
   * 60 seconds and the rest of the machine keeps answering.
   */
  const { chromium } = await import("playwright-core");
  const context = await chromium.launchPersistentContext(
    profileDir,
    playwrightLaunchOptions(options),
  );
  return ownedContextOf(context);
};

/**
 * The snapshot generations, on disk.
 *
 * Why not a number in memory: every restart of this process would begin again at one, and a restart is
 * the normal case on a laptop rather than the exception. The server keeps one live snapshot row per
 * computer and refuses a ref whose generation does not match, and a device runner has no provider that
 * can tell it which run a page belongs to — so a recycled `1` is a ref that resolves, which is the
 * failure shape this exists to prevent.
 *
 * Why SQLite and not a text file: two runners can be pointed at one profile root, and the claim has to
 * be atomic or both hand out the same generation. The journal beside it already makes the same trade.
 */
type CounterStore = {
  /** The generations already issued for this profile. Zero means never used. */
  open: (profileKey: string, profileWasOnDisk: boolean) => number;
  next: (profileKey: string) => number;
  close: () => void;
};

/**
 * A number that cannot be issued.
 *
 * `file` is named because the only honest advice is about the row that is wrong, and it is not in the
 * browser's profile directory: every coworker's counter lives in one SQLite file beside them all.
 * Telling the person to delete a profile would destroy their logins and leave the damaged row exactly
 * where it is, which is why this says what has to be repaired instead.
 */
function unusable(generation: unknown, file: string): number {
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  ) {
    throw new BrowserFailure(
      `This browser's element-list counter is damaged, so no snapshot can be trusted and nothing was opened. The number for this coworker is in ${file}, and a person who administers this machine has to put a usable one back. This runner will not reset it itself: a smaller number would let an element list taken before the damage name a page it was never read from.`,
    );
  }
  if (generation > MAX_SNAPSHOT_GENERATION) {
    throw new BrowserFailure(
      `This browser has handed out more element lists than the computer contract can number, so nothing was opened. The counter in ${file} has gone past ${MAX_SNAPSHOT_GENERATION}, the largest snapshot id the server can store. It is not reset here, because restarting below the numbers already in circulation is how an old element list resolves against the wrong page: widening that column is a change to the server, and a person who administers this machine can move the counter file aside once it exists.`,
    );
  }
  return generation;
}

/**
 * The counter row is gone while the browser profile is not.
 *
 * The one case this refuses rather than reconstructs. Guessing a starting number would admit every ref
 * the server is still holding, which is the stale resolution the counter exists to make impossible, and
 * deleting the profile to "fix" it would sign the person out of their own logins for a bookkeeping
 * problem. So the answer is the repair, not the wreck.
 */
function missingCounter(file: string): never {
  throw new BrowserFailure(
    `This coworker's browser profile is on this machine but its element-list counter is missing or damaged, so the numbers would restart below the lists the server is still holding. Nothing was opened. The row belongs in ${file}; a person who administers this machine has to restore it, and until then every snapshot ref for this coworker has to be re-taken.`,
  );
}


function openCounterStore(file: string): CounterStore {
  mkdirSync(dirname(file) || ".", { recursive: true });
  // An owned, empty file with the mode set before anything is written into it: this holds a
  // coworker's browsing state reference, and the journal beside it is kept to the same rule.
  writeFileSync(file, "", { flag: "a", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // A filesystem without modes still got a file it created private.
  }
  const database = new Database(file, { create: true, strict: true });
  database.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;",
  );
  database.exec(
    "CREATE TABLE IF NOT EXISTS snapshot_counters (profile TEXT PRIMARY KEY, generation INTEGER NOT NULL);",
  );
  const read = database.query<{ kind: string; generation: number }, [string]>(
    "SELECT typeof(generation) AS kind, generation FROM snapshot_counters WHERE profile = ?",
  );
  const create = database.query(
    "INSERT INTO snapshot_counters(profile, generation) VALUES (?, 0) ON CONFLICT(profile) DO NOTHING",
  );
  const step = database.query<{ generation: number }, [string]>(
    "UPDATE snapshot_counters SET generation = generation + 1 WHERE profile = ? RETURNING generation",
  );

  return {
    open(profileKey, profileWasOnDisk) {
      let row: { kind: string; generation: number } | null = null;
      try {
        row = read.get(profileKey);
      } catch {
        unusable(undefined, file);
      }
      if (!row) {
        if (profileWasOnDisk) missingCounter(file);
        create.run(profileKey);
        return 0;
      }
      if (row.kind !== "integer") unusable(undefined, file);
      const held = unusable(row.generation, file);
      /*
       * Read at the ceiling is already past it: the list this profile would hand out next is the number
       * over the line. Refusing here, rather than in `next`, is what makes the answer cost no launch and
       * no action — a counter that has run out is a bookkeeping fact about a row, not about a page.
       */
      if (held >= MAX_SNAPSHOT_GENERATION) unusable(held + 1, file);
      return held;
    },
    next(profileKey) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = step.get(profileKey);
        const issued = unusable(row?.generation, file);
        database.exec("COMMIT");
        return issued;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // No transaction to undo, which is the state we wanted either way.
        }
        throw error;
      }
    },
    close: () => database.close(),
  };
}

function profileWasOnDisk(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** Bounded, because a browser that will not answer must not hold a shutdown or an eviction open. */
async function within<T>(
  work: Promise<T>,
  budgetMs: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new BrowserFailure(`${what} did not finish within ${budgetMs / 1000} seconds.`),
        ),
      budgetMs,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export type RunnerBrowserOptions = {
  /** Outside the workspace, always: `files.read` reaches everything inside a directory it can name. */
  profileRoot: string;
  /** False unless the caller says otherwise: this is a person's machine and they can see the window. */
  headless?: boolean;
  executablePath?: string;
  /** Defaults to the installed Chrome. Set when the owner named a different browser by name. */
  channel?: string;
  /**
   * Allow private and loopback addresses. Off unless asked for.
   *
   * It exists for a disposable local fixture, and it is not a production setting: a runner sits on a
   * network the owner did not segment, and a Bot that can reach `169.254.169.254`-adjacent services
   * from a laptop has a wider field than it has from a container. The cloud metadata addresses stay
   * refused whatever this says.
   */
  allowPrivateHosts?: boolean;
  maxLiveBrowsers?: number;
  launch?: BrowserLauncher;
};

type ProfileState = {
  key: string;
  /** This coworker's durable counter, taken from the profile root when the state was first built. */
  counter: CounterStore;
  /** The last generation handed out. Zero until the first element list is taken. */
  generation: number;
  /** Every ref from this profile carries this, so another coworker's handle cannot resolve here. */
  refPrefix: string;
  /** The refs of the current generation only, mapped to what Playwright named. */
  refs: Map<string, string>;
  context?: OwnedContext;
  page?: OwnedPage;
  /** Actions for one browser run one at a time, in the order they arrived. */
  queue: Promise<void>;
  usedAt: number;
};

export function createRunnerBrowser(
  options: RunnerBrowserOptions,
): RunnerBrowser {
  const profileRoot = options.profileRoot;
  const headless = options.headless ?? false;
  const allowPrivateHosts = options.allowPrivateHosts ?? false;
  const maxLiveBrowsers = options.maxLiveBrowsers ?? MAX_LIVE_BROWSERS;
  const launch = options.launch ?? launchOnThisMachine;
  const executablePath = options.executablePath?.trim() ?? "";
  const requestedChannel = options.channel?.trim() ?? "";
  /*
   * An explicit binary and a channel are two answers to the same question, and naming both is a launch
   * Playwright refuses. The path the owner typed wins, and the default is the Chrome on this machine.
   */
  const channel = executablePath
    ? ""
    : (requestedChannel || DEFAULT_BROWSER_CHANNEL);

  /*
   * The run token, on every ref this process hands out.
   *
   * A ref is opaque to the model and unforgeable by it, which is what makes a ref from last week's
   * runner an obvious refusal instead of a number that happens to still name something. A random one
   * per process, not a counter, because a counter would be guessable by the thing being refused.
   *
   * Joined with the profile's own name, because two coworkers driven by one process are two browsers
   * that happen to count their element lists from the same number: a bare run token would let one of
   * them resolve the other's handle, which is a click on somebody else's page.
   */
  const runToken = randomUUID().slice(0, 8);
  const states = new Map<string, ProfileState>();
  let counters: CounterStore | undefined;

  const refOf = (state: ProfileState, rawRef: string): string =>
    `${state.refPrefix}:${rawRef}`;

  function stateOf(identity: BrowserIdentity): ProfileState {
    const key = profileKeyOf(identity);
    const held = states.get(key);
    if (held) return held;
    // One connection for the profile root, shared by every coworker's state, and opened only now:
    // constructing a browser must not create anything on disk, because a runner that is only being
    // asked to run a command has no business making a browser's files.
    counters ??= openCounterStore(
      join(profileRoot, "openbot-snapshots.sqlite"),
    );
    const counter = counters;
    const generation = counter.open(
      key,
      profileWasOnDisk(join(profileRoot, key)),
    );
    const state: ProfileState = {
      key,
      counter,
      generation,
      refPrefix: `${runToken}-${key.slice(0, 8)}`,
      refs: new Map(),
      queue: Promise.resolve(),
      usedAt: Date.now(),
    };
    states.set(key, state);
    return state;
  }

  /** Close one coworker's browser, keeping the profile and every generation already issued. */
  async function retire(state: ProfileState): Promise<void> {
    const context = state.context;
    state.context = undefined;
    state.page = undefined;
    state.refs.clear();
    if (!context) return;
    await within(
      context.close().catch(() => undefined),
      CLOSE_TIMEOUT_MS,
      "That browser could not be closed",
    ).catch(() => undefined);
  }

  /**
   * Keep the number of resident browsers down.
   *
   * The container caps at eight because it has a pod's memory; this is a person's laptop, and every
   * resident Chromium is a few hundred megabytes and a fan that will not stop. Least recently used, so
   * the coworker who just asked is never the one closed. Closing costs nothing durable: the profile
   * stays, and so do the generations.
   */
  async function enforceCap(except: ProfileState): Promise<void> {
    const live = [...states.values()].filter(
      (state) => state.context && state !== except,
    );
    if (live.length < maxLiveBrowsers) return;
    live.sort((a, b) => a.usedAt - b.usedAt);
    for (const state of live.slice(0, live.length - maxLiveBrowsers + 1)) {
      await retire(state);
    }
  }

  async function openBrowser(state: ProfileState): Promise<OwnedPage> {
    const profileDir = join(profileRoot, state.key);
    const launchOptions: BrowserLaunchOptions = {
      headless,
      timeoutMs: LAUNCH_TIMEOUT_MS,
      ...(executablePath ? { executablePath } : {}),
      ...(channel ? { channel } : {}),
    };
    const pending = launch(profileDir, launchOptions);
    let opened: OwnedContext;
    try {
      opened = await within(
        pending,
        LAUNCH_TIMEOUT_MS,
        "The browser on this machine",
      );
    } catch (error) {
      // A launch that came back too late still owns a process. Closed rather than left resident.
      void pending.then(
        (late) => void late.close().catch(() => undefined),
        () => undefined,
      );
      throw error instanceof BrowserFailure
        ? error
        : new BrowserFailure(
            `The browser on this machine could not be started: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
    }
    state.context = opened;
    opened.onClose(() => {
      // The browser went away by itself: the owner closed the window, or Chromium crashed. Retire the
      // refs it minted so the next action says "take a new snapshot" instead of aiming at nothing.
      if (state.context === opened) {
        state.context = undefined;
        state.page = undefined;
        state.refs.clear();
      }
    });
    await enforceCap(state);
    const page = chooseLivePage(opened.pages());
    if (!page) {
      await retire(state);
      throw new BrowserFailure(
        "The browser on this machine started with no page to drive.",
      );
    }
    state.page = page;
    return page;
  }

  /**
   * The page to act on, launching this coworker's browser if it is not running.
   *
   * Re-derived from the context on every call rather than cached, because a site can open a window and
   * close it again: the newest live page is the one being driven, and when it goes the one underneath
   * comes back. Moving between pages retires the outstanding refs, since a ref names an element on the
   * document it was taken from.
   */
  async function pageOf(state: ProfileState): Promise<OwnedPage> {
    state.usedAt = Date.now();
    if (!state.context) return openBrowser(state);
    const page = chooseLivePage(state.context.pages());
    if (!page) {
      await retire(state);
      return openBrowser(state);
    }
    if (state.page !== page) {
      await bump(state);
      state.page = page;
    }
    return page;
  }

  /**
   * A new generation, and every earlier ref retired.
   *
   * Incremented before anything is handed out, so a number is never issued twice and a superseded list
   * of elements cannot be used by the caller that is holding it.
   */
  async function bump(state: ProfileState): Promise<number> {
    state.generation = state.counter.next(state.key);
    state.refs.clear();
    return state.generation;
  }

  /** A same-window navigation is invisible to page tracking, so the URL is the tell. */
  async function retireIfMoved(
    state: ProfileState,
    page: OwnedPage,
    previousUrl: string,
  ): Promise<void> {
    if (page.url() !== previousUrl) await bump(state);
  }

  /**
   * The element, or a refusal that says what to do about it.
   *
   * Three questions in the order that gives the clearest answer. Whose run minted this ref. Which
   * element list it came from. Whether that list still holds it. A "no" to any of them is a page that
   * is not the page the caller thinks it is, and clicking anyway is the failure mode that has no error
   * message at all — it clicks the wrong button.
   */
  async function locate(
    state: ProfileState,
    page: OwnedPage,
    input: Normalized,
  ): Promise<OwnedLocator> {
    const raw = checkHandle(state, input);
    const locator = page.byRef(raw);
    if ((await locator.count()) === 0) {
      throw new BrowserFailure(
        "Nothing on this page is that element any more. Take a new snapshot and use the refs it returns.",
      );
    }
    return locator;
  }

  /**
   * Whether this handle is one this browser would honour, asked of the bookkeeping alone.
   *
   * Runs before any page is opened, because a handle from another coworker or an earlier list is a
   * refusal the records already answer — and starting a Chromium to be told "take a new snapshot" burns
   * the few hundred megabytes this whole path is capped against.
   */
  function checkHandle(state: ProfileState, input: Normalized): string {
    if (!input.ref) {
      throw new BrowserFailure("That action needs the ref of an element.");
    }
    if (input.snapshotId === undefined) {
      throw new BrowserFailure(
        "That action named an element but not the list of elements it came from. Take a snapshot and send the refs it gave, with its snapshot id.",
      );
    }
    if (!input.ref.startsWith(`${state.refPrefix}:`)) {
      throw new BrowserFailure(
        "That element handle came from a browser that is not this one: another coworker's page, or a runner process that has restarted since it was handed out. Take a new snapshot.",
      );
    }
    if (input.snapshotId !== state.generation) {
      throw new BrowserFailure(
        `That list of elements is out of date: it was taken for snapshot ${input.snapshotId} and this browser is now at ${state.generation}. Take a new snapshot and use the refs from it.`,
      );
    }
    const raw = state.refs.get(input.ref);
    if (!raw) {
      throw new BrowserFailure(
        "Nothing on this page is that element. Take a new snapshot and use the refs it returns.",
      );
    }
    return raw;
  }

  /**
   * Which of these filled fields hold a secret. Asked of the page, per element.
   *
   * Only elements that carry a value are asked about, and each answer comes from the node the ref
   * resolves to right now. An element that cannot be answered for is treated as sensitive.
   */
  async function secretsOf(
    page: OwnedPage,
    elements: SnapshotElement[],
  ): Promise<Set<string>> {
    const sensitive = new Set<string>();
    await Promise.all(
      elements
        .filter(
          (element) =>
            VALUE_ROLES.has(element.role) && element.value !== undefined,
        )
        .map(async (element) => {
          const hidden = await page.byRef(element.ref).holdsSecret();
          if (hidden) sensitive.add(element.ref);
        }),
    );
    return sensitive;
  }

  function masked(
    elements: SnapshotElement[],
    sensitive: ReadonlySet<string>,
  ): SnapshotElement[] {
    return elements.map((element) =>
      sensitive.has(element.ref) && element.value !== undefined
        ? { ...element, value: MASKED_VALUE }
        : element,
    );
  }

  async function snapshot(
    state: ProfileState,
    page: OwnedPage,
  ): Promise<unknown> {
    const parsed = parseAriaSnapshot(await page.ariaYaml());
    const sensitive = await secretsOf(page, parsed.elements);
    // After the page has been read and before the refs leave this process.
    const generation = await bump(state);
    state.refs = new Map(
      parsed.elements.map((element) => [
        refOf(state, element.ref),
        element.ref,
      ]),
    );
    return {
      snapshotId: generation,
      url: page.url(),
      title: await page.title(),
      truncated: parsed.truncated,
      elements: masked(parsed.elements, sensitive).map((element) => ({
        ...element,
        ref: refOf(state, element.ref),
      })),
    };
  }

  /**
   * The normalized form of one call, produced before any browser exists.
   *
   * Deliberately first: a destination this deployment refuses must cost no launch and no queue, and a
   * malformed action must be answered with the name of the field rather than a browser error that
   * reads as a broken machine.
   */
  function interpret(
    action: string,
    payload: Record<string, unknown>,
  ): Normalized {
    const ref =
      typeof payload.ref === "string" && payload.ref ? payload.ref : undefined;
    const snapshotId =
      typeof payload.snapshotId === "number" &&
      Number.isInteger(payload.snapshotId)
        ? payload.snapshotId
        : undefined;
    /** Which element, and which list of elements it came from. Carried by every acting call. */
    const target: Normalized = {
      ...(ref ? { ref } : {}),
      ...(snapshotId !== undefined ? { snapshotId } : {}),
    };

    if (action === "navigate") {
      const raw = typeof payload.url === "string" ? payload.url.trim() : "";
      if (!raw) throw new BrowserFailure("A url is required.");
      const verdict = checkNavigationTarget(raw, { allowPrivateHosts });
      if (!verdict.allowed) throw new BrowserFailure(verdict.reason);
      return { url: verdict.url };
    }
    if (action === "type") {
      if (typeof payload.text !== "string") {
        throw new BrowserFailure("Typing needs the text to enter.");
      }
      return { ...target, text: payload.text, submit: payload.submit === true };
    }
    if (action === "key") {
      if (typeof payload.key !== "string" || !payload.key) {
        throw new BrowserFailure(
          "A key press needs a key name, such as Enter or Tab.",
        );
      }
      return { ...target, key: payload.key };
    }
    if (action === "scroll") {
      if (payload.deltaY === undefined) return { deltaY: 600 };
      if (
        typeof payload.deltaY !== "number" ||
        !Number.isFinite(payload.deltaY)
      ) {
        throw new BrowserFailure("deltaY must be a finite number of pixels.");
      }
      return { deltaY: payload.deltaY };
    }
    // `read`, `snapshot` and `screenshot` need nothing beyond an element target. Anything else is a
    // caller that has asked this browser for a thing it does not do, and must be told so by name
    // rather than answered with whichever action happened to be last.
    if (!BROWSER_ACTIONS.has(action)) {
      throw new BrowserFailure(
        `This browser does not do "${action}", and nothing was opened.`,
      );
    }
    return target;
  }

  /**
   * One call, carried out.
   *
   * Runs one at a time per coworker's browser: two snapshots of one page completing in the wrong order
   * would hand out a generation number that describes the older one, and a click queued behind a
   * navigation would land on whichever page happened to be showing.
   */
  async function perform(
    state: ProfileState,
    action: string,
    input: Normalized,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    // Checked again, because this may have waited behind another action.
    if (signal?.aborted) throw new BrowserFailure(STOPPED_BEFORE_EXECUTION);
    // Answered from the records alone, so a refused handle costs no browser.
    if (input.ref) checkHandle(state, input);
    const startedAt = Date.now();
    const page = await pageOf(state);
    /*
     * And again, after the launch.
     *
     * Opening a browser takes seconds on a laptop, and a Stop pressed during it is exactly as binding
     * as one pressed before it. Without this the action that was queued behind a cold start runs after
     * the person gave up, which is the failure this whole path exists to avoid.
     */
    if (signal?.aborted) throw new BrowserFailure(STOPPED_BEFORE_EXECUTION);
    const acting: CallOptions = {
      timeout: ACTION_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    };

    if (action === "navigate") {
      const url = input.url;
      if (!url) throw new BrowserFailure("A url is required.");
      try {
        await page.navigate(url, {
          timeout: NAVIGATE_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        // A cancelled navigation costs a reload, and reloads are harmless, so this is not an unknown.
        if (signal?.aborted) {
          throw new BrowserFailure(STOPPED_BEFORE_EXECUTION);
        }
        throw new BrowserFailure(
          `That address could not be opened: ${
            error instanceof Error && error.message
              ? error.message
              : "the browser on this machine did not say why"
          }`,
        );
      }
      if (signal?.aborted) throw new BrowserFailure(STOPPED_BEFORE_EXECUTION);
      await bump(state);
      const extract = await readable(page);
      return {
        url: page.url(),
        title: await page.title(),
        text: extract.text,
        truncated: extract.truncated,
        elapsedMs: Date.now() - startedAt,
      };
    }

    if (action === "read") {
      const extract = await readable(page);
      return {
        url: page.url(),
        title: await page.title(),
        text: extract.text,
        truncated: extract.truncated,
      };
    }

    if (action === "snapshot") return snapshot(state, page);

    if (action === "screenshot") {
      const buffer = await page.png(SENSITIVE_FIELD_SELECTOR);
      const size = page.viewportSize();
      return {
        base64: uint8ToBase64(buffer),
        width: size.width,
        height: size.height,
        capturedAt: new Date().toISOString(),
        // A blank browser and a loaded page can both be entirely white pictures. The transcript has to
        // be able to tell them apart, so the page this is a picture of travels with it.
        url: page.url(),
      };
    }

    // Everything below can change the page, so a cancellation that arrives after the call started is
    // reported as an unknown outcome and pauses the device until its owner looks.
    const mayHaveLanded = (error: unknown): never => {
      if (signal?.aborted) {
        throw new BrowserFailure(
          error instanceof Error && error.message
            ? error.message
            : "The action was stopped on the way to the page, which may still have received it.",
          true,
        );
      }
      throw error;
    };
    /*
     * A call that came back fine, on a device that has since been stopped.
     *
     * Resolving is not the same as never having been sent. Playwright's locator and keyboard calls do
     * not abort merely because the options object carried a signal, so a Stop that lands during a
     * `fill` can still be sitting in the page's input when this returns, and a form with a submit bound
     * to it can go. Saying "succeeded" would let the assistant carry on as though the person had not
     * objected; the honest answer is that the machine may have changed and has to be looked at.
     */
    const stoppedAfterLanding = (): void => {
      if (!signal?.aborted) return;
      throw new BrowserFailure(
        "The device action was stopped after it had been sent to the page, which may have taken it.",
        true,
      );
    };
    const before = page.url();

    if (action === "click") {
      const locator = await locate(state, page, input);
      try {
        await locator.click(acting);
      } catch (error) {
        mayHaveLanded(error);
      }
      stoppedAfterLanding();
      await retireIfMoved(state, page, before);
      return {
        action: "click",
        ref: input.ref,
        url: page.url(),
        elapsedMs: Date.now() - startedAt,
      };
    }

    if (action === "type") {
      const locator = await locate(state, page, input);
      if (await locator.holdsSecret()) {
        throw new BrowserFailure(
          "That field holds a secret the assistant is never given — a password, a card number or a one-time code. A person has to type it on this machine.",
        );
      }
      try {
        // `fill`, not keystrokes: it clears what is already there, which is what "put this value in
        // this box" means. Appending to a half-filled field is how a form ends up with "AlicAlice".
        await locator.fill(input.text ?? "", acting);
      } catch (error) {
        mayHaveLanded(error);
      }
      stoppedAfterLanding();
      if (input.submit) {
        try {
          await locator.press("Enter", acting);
        } catch (error) {
          mayHaveLanded(error);
        }
        stoppedAfterLanding();
      }
      await retireIfMoved(state, page, before);
      // The text itself is never echoed. This reaches the model and the audit trail, and a form field
      // is exactly where a password lives. The caller already knows what it sent.
      return {
        action: "type",
        ref: input.ref,
        characters: input.text?.length ?? 0,
        submitted: input.submit === true,
        url: page.url(),
        elapsedMs: Date.now() - startedAt,
      };
    }

    if (action === "key") {
      const key = input.key;
      if (!key) throw new BrowserFailure("A key press needs a key name.");
      try {
        if (input.ref) {
          await (await locate(state, page, input)).press(key, acting);
        } else {
          await page.pressKey(key);
        }
      } catch (error) {
        mayHaveLanded(error);
      }
      stoppedAfterLanding();
      await retireIfMoved(state, page, before);
      return {
        action: "key",
        key,
        ...(input.ref ? { ref: input.ref } : {}),
        url: page.url(),
        elapsedMs: Date.now() - startedAt,
      };
    }

    try {
      await page.wheel(input.deltaY ?? 600);
    } catch (error) {
      // A wheel is a scroll. Nothing was committed and nothing can be double-committed by trying again.
      if (signal?.aborted) throw new BrowserFailure(STOPPED_BEFORE_EXECUTION);
      throw error;
    }
    await retireIfMoved(state, page, before);
    return {
      action: "scroll",
      deltaY: input.deltaY ?? 600,
      url: page.url(),
      elapsedMs: Date.now() - startedAt,
    };
  }

  async function readable(
    page: OwnedPage,
  ): Promise<{ text: string; truncated: boolean }> {
    const raw = await page.readableText();
    const collapsed = raw.replace(/\n{3,}/g, "\n\n").trim();
    return {
      // Cut between characters, not through one: the limit counts UTF-16 code units and an emoji is
      // two, so a naive slice hands the model a lone surrogate that reads as a broken character.
      text: cutAtCodeUnits(collapsed, TEXT_EXTRACT_LIMIT),
      truncated: collapsed.length > TEXT_EXTRACT_LIMIT,
    };
  }

  async function act(request: BrowserRequest): Promise<unknown> {
    const input = interpret(request.action, request.payload);
    if (request.signal?.aborted) {
      throw new BrowserFailure(STOPPED_BEFORE_EXECUTION);
    }
    const state = stateOf(request.identity);
    const tail = state.queue.then(() =>
      perform(state, request.action, input, request.signal),
    );
    // The queue holds a settled version, so one failure cannot poison everything after it.
    state.queue = tail.then(
      () => undefined,
      () => undefined,
    );
    return tail;
  }

  return {
    act,
    async close(): Promise<void> {
      await Promise.all([...states.values()].map((state) => retire(state)));
      counters?.close();
      counters = undefined;
      states.clear();
    },
  };
}

/** Normalized, per-action, after validation. Absent means the action did not name that field. */
type Normalized = {
  url?: string;
  text?: string;
  key?: string;
  deltaY?: number;
  ref?: string;
  snapshotId?: number;
  submit?: boolean;
};

function uint8ToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
