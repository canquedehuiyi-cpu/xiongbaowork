import { lstat, mkdir, rename } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { browserRuntimeFromEnv } from "../agent-computer/src/browser-runtime";
import {
  type InstalledBrowser,
  installedBrowser,
  NO_INSTALLED_BROWSER,
} from "../agent-computer/src/installed-browser";
import {
  applyEnvironmentAliases,
  reportEnvironmentAliases,
} from "../shared/env-aliases";

type Environment = Record<string, string | undefined>;

/** Where this helper keeps its computer's profiles and files, and how it starts that computer. */
export type LocalChromeConfiguration = {
  root: string;
  port: number;
  env: Environment;
  /**
   * The default folder before v0.2.16, under a directory named for the product's earlier name, when the root is
   * the default rather than one the operator named. See {@link adoptLegacyLocalComputer}.
   */
  legacyRoot?: string;
};

/** The data home directory each platform gives an app called `name` (`linuxName` on Linux). */
function dataHomeFor(
  env: Environment,
  platform: string,
  userHome: string,
  name: string,
  linuxName: string,
): string {
  const path = platform === "win32" ? win32 : posix;
  return platform === "darwin"
    ? path.join(userHome, "Library", "Application Support", name)
    : platform === "win32"
      ? path.join(
          env.LOCALAPPDATA || path.join(userHome, "AppData", "Local"),
          name,
        )
      : path.join(
          env.XDG_DATA_HOME || path.join(userHome, ".local", "share"),
          linuxName,
        );
}

/** The same configuration with its profiles and files under another root. */
function withRoot(
  config: LocalChromeConfiguration,
  root: string,
  platform: string,
): LocalChromeConfiguration {
  const path = platform === "win32" ? win32 : posix;
  return {
    ...config,
    root: path.normalize(root),
    env: {
      ...config.env,
      PROFILES_DIR: path.join(root, "profiles"),
      WORKSPACE_DIR: path.join(root, "workspace"),
    },
  };
}

/** Resolve only app-owned paths; inherited container or personal-profile paths are never reused. */
export function localChromeConfiguration(
  env: Environment,
  platform: string = process.platform,
  userHome = homedir(),
): LocalChromeConfiguration {
  if (!env.COMPUTER_TOKEN?.trim()) {
    throw new Error(
      "COMPUTER_TOKEN is required. Use the same secret as the local XiongBao API.",
    );
  }
  if (
    env.COMPUTER_BROWSER_BACKEND?.trim() &&
    env.COMPUTER_BROWSER_BACKEND.trim() !== "local-chrome"
  ) {
    throw new Error(
      "This helper requires COMPUTER_BROWSER_BACKEND=local-chrome; unset the managed backend setting.",
    );
  }
  const path = platform === "win32" ? win32 : posix;
  const named = env.XIONGBAO_LOCAL_COMPUTER_DIR?.trim();
  const root =
    named ||
    path.join(
      dataHomeFor(env, platform, userHome, "XiongBao", "xiongbao"),
      "local-computer",
    );
  if (!path.isAbsolute(root))
    throw new Error("XIONGBAO_LOCAL_COMPUTER_DIR must be an absolute path.");
  const port = env.PORT?.trim() || "4101";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("PORT must be a whole number between 1 and 65535.");
  }
  const childEnv: Environment = {
    ...env,
    COMPUTER_BROWSER_BACKEND: "local-chrome",
    COMPUTER_BROWSER_MODE: env.COMPUTER_BROWSER_MODE?.trim() || "headed",
    COMPUTER_SANDBOX: "on",
    PORT: port,
    PROFILES_DIR: path.join(root, "profiles"),
    WORKSPACE_DIR: path.join(root, "workspace"),
  };
  browserRuntimeFromEnv(childEnv, platform);
  return {
    root: path.normalize(root),
    port: Number(port),
    env: childEnv,
    // legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
    ...(named
      ? {}
      : {
          legacyRoot: path.join(
            dataHomeFor(env, platform, userHome, "OpenBot", "openbot"),
            "local-computer",
          ),
        }),
  };
}

async function present(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * The default folder from before v0.2.16, with the browser profiles and files already in it, moved to where the
 * default is now.
 *
 * Moved only when nothing is at the new place, so it happens once and a second start finds nothing to do; with
 * both there, the new one is used and the old one is left for the operator. A rename is all or nothing, so a move
 * that fails leaves the folder exactly where it was, and this run uses it there (a browser still holding it open
 * on Windows refuses the rename); the next start tries again.
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
 */
export async function adoptLegacyLocalComputer(
  config: LocalChromeConfiguration,
  platform: string = process.platform,
  move: (from: string, to: string) => Promise<void> = rename,
): Promise<LocalChromeConfiguration> {
  const legacy = config.legacyRoot;
  if (!legacy || !(await present(legacy))) return config;
  if (await present(config.root)) {
    console.warn(
      `Both ${legacy} and ${config.root} exist; using ${config.root} and leaving the other as it is.`,
    );
    return config;
  }
  const path = platform === "win32" ? win32 : posix;
  try {
    await mkdir(path.dirname(config.root), { recursive: true, mode: 0o700 });
    await move(legacy, config.root);
  } catch (error) {
    console.warn(
      `Could not move ${legacy} to ${config.root} (${error instanceof Error ? error.message : String(error)}); using it where it is for now.`,
    );
    return withRoot(config, legacy, platform);
  }
  console.info(`Moved ${legacy} to ${config.root}.`);
  return config;
}

/**
 * The installed browser this computer can open windows in: Google Chrome, else Microsoft Edge, each
 * at Playwright's stable-channel location and never an executable from a tool input.
 *
 * Edge because it ships with Windows, so a machine without Chrome still has a browser Google or
 * Microsoft keeps patched. A Bot's browser here is Chrome: with only Edge installed the helper
 * starts, and a Bot's browser does not open.
 */
export async function requireInstalledBrowser(
  env: Environment,
  platform: string = process.platform,
): Promise<InstalledBrowser> {
  const found = await installedBrowser(env, platform);
  if (!found) throw new Error(NO_INSTALLED_BROWSER);
  return found;
}

export async function requireAvailablePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) =>
      reject(
        new Error(
          `Cannot listen on 127.0.0.1:${port}; free that port or set PORT explicitly.`,
          { cause: error },
        ),
      ),
    );
    probe.listen(port, "127.0.0.1", () =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
  });
}

async function main(): Promise<void> {
  // A standalone process: it runs the alias step itself, so a data directory still named under the
  // old prefix (OPENBOT_LOCAL_COMPUTER_DIR) is found where it was.
  // legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
  const environment = { ...process.env };
  reportEnvironmentAliases(applyEnvironmentAliases(environment));
  const config = await adoptLegacyLocalComputer(
    localChromeConfiguration(environment),
  );
  await requireInstalledBrowser(config.env);
  await requireAvailablePort(config.port);
  await mkdir(config.root, { recursive: true, mode: 0o700 });
  for (const directory of [config.env.PROFILES_DIR, config.env.WORKSPACE_DIR]) {
    if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const computerDirectory = join(import.meta.dir, "..", "agent-computer");
  console.info(
    `Starting local Chrome computer at http://127.0.0.1:${config.port}; data: ${config.root}`,
  );
  const child = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts"], {
    cwd: computerDirectory,
    env: config.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    process.exitCode = await child.exited;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Local Chrome startup failed.",
    );
    process.exitCode = 1;
  }
}
