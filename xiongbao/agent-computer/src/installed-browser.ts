/**
 * Which installed, branded browser this machine has (Google Chrome, else Microsoft Edge), and the
 * Chromium switches Playwright turns off, which a Bot's launch is read against.
 *
 * The host-side local Chrome computer (`scripts/start-local-chrome-computer.ts`) refuses to start
 * without one of these browsers, rather than silently falling back to a bundled Chromium.
 *
 * Free of Playwright, so the decisions can be tested without launching anything.
 */
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { posix, win32 } from "node:path";

type Environment = Record<string, string | undefined>;

/** An installed, branded browser, in the order it is preferred. */
export type InstalledBrowser = "chrome" | "msedge";
export const INSTALLED_BROWSERS: readonly InstalledBrowser[] = [
  "chrome",
  "msedge",
];

const NAMES: Record<InstalledBrowser, string> = {
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
};

/**
 * The commands each browser's Linux packages put on the PATH, in the order they are tried: the
 * stable channel's own name first, then the one every channel's package links.
 */
export const LINUX_LAUNCHERS: Record<InstalledBrowser, readonly string[]> = {
  chrome: ["google-chrome-stable", "google-chrome"],
  msedge: ["microsoft-edge-stable", "microsoft-edge"],
};

/**
 * Where each browser installs, in the order it is looked for. Never an executable from a request.
 *
 * macOS and Windows: Playwright's own stable-channel locations, which are where the browsers'
 * installers put them.
 *
 * Linux: where Google's and Microsoft's own packages install them on every distribution (their .deb
 * and .rpm put the browser in `/opt` and link a launcher into `/usr/bin`, and the AUR builds follow
 * them), then the launcher on the PATH, for a distribution that keeps the browser somewhere of its
 * own (NixOS keeps it in the Nix store, behind a wrapper on the PATH). A launcher is the browser's
 * own script, which hands every argument on to the browser it starts.
 *
 * Never a Flatpak or a Snap. The Flatpak builds of Chrome and Edge are community wrappers that run
 * the browser in a sandbox with no access to the folders it would need here (its profile), and their exported launchers (`com.google.Chrome`) are not on the
 * list above. Neither browser is published as a Snap; the Snap Store's browser is Chromium. XiongBao
 * Desktop says so to the person when that is all a machine has.
 * https://github.com/flathub/com.google.Chrome
 */
export function browserExecutableCandidates(
  browser: InstalledBrowser,
  env: Environment,
  platform: string = process.platform,
): string[] {
  if (platform === "darwin")
    return browser === "chrome"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  if (platform === "linux") {
    const packaged =
      browser === "chrome"
        ? "/opt/google/chrome/chrome"
        : "/opt/microsoft/msedge/msedge";
    // Absolute folders only: an empty or relative PATH entry means the folder this process runs in.
    const folders = (env.PATH ?? "")
      .split(":")
      .filter((folder) => posix.isAbsolute(folder));
    return [
      ...new Set([
        packaged,
        ...folders.flatMap((folder) =>
          LINUX_LAUNCHERS[browser].map((name) => posix.join(folder, name)),
        ),
      ]),
    ];
  }
  if (platform === "win32") {
    const suffix =
      browser === "chrome"
        ? ["Google", "Chrome", "Application", "chrome.exe"]
        : ["Microsoft", "Edge", "Application", "msedge.exe"];
    return [
      env.LOCALAPPDATA,
      env.PROGRAMFILES,
      env["PROGRAMFILES(X86)"],
      ...(env.HOMEDRIVE
        ? [
            win32.join(env.HOMEDRIVE, "Program Files"),
            win32.join(env.HOMEDRIVE, "Program Files (x86)"),
          ]
        : []),
    ]
      .filter((prefix): prefix is string => Boolean(prefix))
      .map((prefix) => win32.join(prefix, ...suffix));
  }
  throw new Error(`An installed browser is not supported on ${platform}.`);
}

/** Whether an executable is there to run (on Windows, there at all), without running it. */
export async function runnable(
  path: string,
  platform: string,
): Promise<boolean> {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))
    )
      return false;
    throw error;
  }
}

/**
 * Google Chrome when it is installed, otherwise Microsoft Edge, otherwise nothing.
 *
 * Chrome first because it is what most people already use and sign in to; Edge because it ships
 * with Windows, so a Windows machine without Chrome still has a browser Google and Microsoft keep
 * patched. Never a bundled Chromium on the desktop: it does not update itself and cannot use Google
 * sign-in or sync.
 */
export async function installedBrowser(
  env: Environment,
  platform: string = process.platform,
): Promise<InstalledBrowser | null> {
  return (await installedBrowserAt(env, platform))?.browser ?? null;
}

/** The same, with the executable that is installed. */
export async function installedBrowserAt(
  env: Environment,
  platform: string = process.platform,
): Promise<{ browser: InstalledBrowser; executable: string } | null> {
  for (const browser of INSTALLED_BROWSERS) {
    for (const candidate of browserExecutableCandidates(
      browser,
      env,
      platform,
    )) {
      if (await runnable(candidate, platform))
        return { browser, executable: candidate };
    }
  }
  return null;
}

export const NO_INSTALLED_BROWSER = `Neither ${NAMES.chrome} nor ${NAMES.msedge} was found in its standard installation location. Install one of them (not as a Flatpak or a Snap) to open a browser here.`;

/**
 * Playwright's own `--disable-features` value (playwright-core 1.62.1, `chromiumSwitches.ts`, plus
 * what its launcher adds), spelled out exactly as Playwright builds it, which a Bot's browser's tests
 * read its command line against.
 */
export const PLAYWRIGHT_DISABLED_FEATURES: readonly string[] = [
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "BoundaryEventDispatchTracksNodeRemoval",
  "DestroyProfileOnBrowserClose",
  "DialMediaRouteProvider",
  "GlobalMediaControls",
  "HttpsUpgrades",
  "LensOverlay",
  "MediaRouter",
  "PaintHolding",
  "ThirdPartyStoragePartitioning",
  "BlockOriginHeaderModificationOnRedirect",
  "Translate",
  "AutoDeElevate",
  "OptimizationHints",
  "msForceBrowserSignIn",
  "msEdgeUpdateLaunchServicesPreferredVersion",
];
