import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Apps on this machine whose MCP tools the owner lets their 分身 call (the device-side local MCP
 * bridge, spec §3.1).
 *
 * AN APP IS REGISTERED HERE, ON THIS MACHINE, AND NOWHERE ELSE. Like a root (`roots.ts`), the owner
 * adds one with a command they type or a field in the device app's window; nothing the server sends
 * can add one. Each gets an opaque reference (`app_…`, random) and a name the owner chose. The
 * reference and the name are what the server is told (`reported()`); how to start or reach the app
 * stays in `runner-apps.json` beside the token, because a command line, its environment and its
 * working folder routinely carry API keys and the names of the owner's projects.
 *
 * TWO KINDS, BOTH LOCAL. A `stdio` app is a command this runner starts and talks to over its pipes.
 * An `http` app is one already running here, and only a loopback url is accepted (127.0.0.1,
 * localhost, [::1]): the bridge is for the owner's own computer, and an address on the network would
 * let a registered app send the model's calls, and whatever they carry, to somebody else's machine.
 *
 * A DISABLED APP IS NOT OFFERED. The owner can switch an app off without losing its settings; it is
 * then left out of `reported()`, so the server stops hearing about it on the next heartbeat.
 */

export type AppEntry =
  | {
      ref: string;
      name: string;
      kind: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
      enabled: boolean;
    }
  | { ref: string; name: string; kind: "http"; url: string; enabled: boolean };

export type AppInput = Omit<AppEntry, "ref" | "enabled"> & {
  enabled?: boolean;
};

/** A refusal a person can act on. Chinese, because the device app shows it as it stands. */
export class AppRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppRegistryError";
  }
}

/** The file beside the token that holds the apps. */
export const APPS_FILE = "runner-apps.json";
/** Few enough to carry on every heartbeat, the same ceiling as folders. */
export const MAX_APPS = 20;
/** Characters (code points), counted as `roots.ts` counts a folder's name. */
export const APP_NAME_LIMIT = 40;
/** `app_` and 22 base64url characters: 128 random bits. The server checks the same shape. */
export const APP_REF: RegExp = /^app_[A-Za-z0-9_-]{22}$/;

/** `[::1]` is how a URL spells the IPv6 loopback in its host. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function mintRef(): string {
  return `app_${randomBytes(16).toString("base64url")}`;
}

function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    LOOPBACK_HOSTS.has(url.hostname)
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

/** An entry as the file may hold it, or undefined for one that is not ours to trust. */
function readEntry(value: unknown): AppEntry | undefined {
  const raw = value as Record<string, unknown> | null;
  if (
    typeof raw?.ref !== "string" ||
    !APP_REF.test(raw.ref) ||
    typeof raw.name !== "string" ||
    typeof raw.enabled !== "boolean"
  ) {
    return undefined;
  }
  const { ref, name, enabled } = raw as {
    ref: string;
    name: string;
    enabled: boolean;
  };
  if (raw.kind === "http") {
    return typeof raw.url === "string" && isLoopbackUrl(raw.url)
      ? { ref, name, kind: "http", url: raw.url, enabled }
      : undefined;
  }
  if (
    raw.kind === "stdio" &&
    typeof raw.command === "string" &&
    Array.isArray(raw.args) &&
    raw.args.every((arg) => typeof arg === "string") &&
    isStringRecord(raw.env) &&
    (raw.cwd === undefined || typeof raw.cwd === "string")
  ) {
    return {
      ref,
      name,
      kind: "stdio",
      command: raw.command,
      args: raw.args,
      env: raw.env,
      ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
      enabled,
    };
  }
  return undefined;
}

export function createAppRegistry(opts: { dataDir: string }): {
  /** Every app with its command: for printing on this machine, never for the server. */
  list(): AppEntry[];
  /** What the server is told: reference and name of the enabled apps. */
  reported(): { ref: string; name: string }[];
  add(input: AppInput): AppEntry;
  /** By reference or by name. False when there is nothing by that name to remove. */
  remove(target: string): boolean;
  setEnabled(target: string, enabled: boolean): AppEntry;
  byRef(ref: string): AppEntry | undefined;
  byName(name: string): AppEntry | undefined;
} {
  const file = join(opts.dataDir, APPS_FILE);

  const list = (): AppEntry[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // No file yet, or one that is not ours: no apps, which is the safe reading of both.
      return [];
    }
    const apps = (parsed as { apps?: unknown } | null)?.apps;
    if (!Array.isArray(apps)) return [];
    return apps.flatMap((app) => readEntry(app) ?? []);
  };

  /** Written whole, to a temporary file renamed over the old one, and private like the token. */
  const save = (apps: AppEntry[]) => {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ apps }, null, 2)}\n`, {
      mode: 0o600,
    });
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // A filesystem without modes still got a file it created private.
    }
    renameSync(temporary, file);
  };

  const sameName = (a: string, b: string) =>
    a.toLowerCase() === b.toLowerCase();
  const byRef = (ref: string) => list().find((app) => app.ref === ref);
  const byName = (name: string) =>
    list().find((app) => sameName(app.name, name.trim()));
  /** A reference names exactly one app; anything else is a name. */
  const find = (target: string) => {
    const wanted = target.trim();
    return APP_REF.test(wanted) ? byRef(wanted) : byName(wanted);
  };

  return {
    list,
    reported: () =>
      list()
        .filter((app) => app.enabled)
        .map(({ ref, name }) => ({ ref, name })),
    byRef,
    byName,

    add(input) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const length = [...name].length;
      if (length < 1 || length > APP_NAME_LIMIT) {
        throw new AppRegistryError(`名称需要 1–${APP_NAME_LIMIT} 个字。`);
      }
      const apps = list();
      if (apps.some((app) => sameName(app.name, name))) {
        throw new AppRegistryError(`已经有一个叫「${name}」的应用了（重名）。`);
      }
      if (apps.length >= MAX_APPS) {
        throw new AppRegistryError(`最多添加 ${MAX_APPS} 个本机应用。`);
      }
      const enabled = input.enabled ?? true;
      let entry: AppEntry;
      if (input.kind === "http") {
        const url = typeof input.url === "string" ? input.url.trim() : "";
        if (!isLoopbackUrl(url)) {
          throw new AppRegistryError(
            "网址只能填本机地址（127.0.0.1、localhost 或 [::1]，以 http:// 或 https:// 开头）。",
          );
        }
        entry = { ref: mintRef(), name, kind: "http", url, enabled };
      } else if (input.kind === "stdio") {
        const command =
          typeof input.command === "string" ? input.command.trim() : "";
        if (!command) throw new AppRegistryError("请填写启动应用的命令。");
        if (
          !Array.isArray(input.args) ||
          !input.args.every((arg) => typeof arg === "string")
        ) {
          throw new AppRegistryError("命令的参数需要是文字列表。");
        }
        if (!isStringRecord(input.env)) {
          throw new AppRegistryError("环境变量需要是「名称: 值」的文字对。");
        }
        const cwd = input.cwd?.trim();
        entry = {
          ref: mintRef(),
          name,
          kind: "stdio",
          command,
          args: [...input.args],
          env: { ...input.env },
          ...(cwd ? { cwd } : {}),
          enabled,
        };
      } else {
        throw new AppRegistryError("应用的类型只能是 stdio 或 http。");
      }
      save([...apps, entry]);
      return entry;
    },

    remove(target) {
      const app = find(target);
      if (!app) return false;
      save(list().filter((other) => other.ref !== app.ref));
      return true;
    },

    setEnabled(target, enabled) {
      const app = find(target);
      if (!app)
        throw new AppRegistryError(`没有叫「${target.trim()}」的应用。`);
      const updated: AppEntry = { ...app, enabled };
      save(list().map((other) => (other.ref === app.ref ? updated : other)));
      return updated;
    },
  };
}
