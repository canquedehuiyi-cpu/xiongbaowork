import { win32 } from "node:path";
import { APP_NAME_LIMIT, isLoopbackUrl } from "./apps";

/**
 * The MCP servers the owner already set up in other AI tools on this Windows machine (app discovery,
 * spec §2.1), read so the device can offer them without a form.
 *
 * ONLY READ, ONLY WHAT WE UNDERSTAND. Each tool's file is read as text through an injected reader;
 * a file that is missing, unreadable or not valid JSON(C) skips that one file and nothing else. From
 * each entry only `command/args/env/cwd` or a loopback `url` (`serverUrl` for Windsurf) is kept;
 * every other field is ignored, and an entry that has neither is dropped.
 *
 * WHAT IS RETURNED STAYS ON THIS MACHINE. A spec carries the command line and environment values,
 * which routinely hold API keys and project paths: `discover.ts` keeps them local and hands out only
 * names, source labels and opaque references. A Claude Code project's path is used only to walk to
 * its servers and is never part of the result.
 */

export type ConfigSource =
  | "claude-desktop"
  | "claude-code"
  | "cursor"
  | "vscode"
  | "windsurf";

export type DiscoveredSpec =
  | {
      kind: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
    }
  | { kind: "http"; url: string };

export type FoundServer = {
  source: ConfigSource;
  name: string;
  spec: DiscoveredSpec;
};

/** Where a candidate came from, as the owner and the employee read it. */
export const SOURCE_LABELS: Record<ConfigSource, string> = {
  "claude-desktop": "Claude Desktop 的配置",
  "claude-code": "Claude Code 的配置",
  cursor: "Cursor 的配置",
  vscode: "VS Code 的配置",
  windsurf: "Windsurf 的配置",
};

/** The suffix that tells two same-named candidates apart: `名称（Cursor）`. */
export const SOURCE_SHORT: Record<ConfigSource, string> = {
  "claude-desktop": "Claude Desktop",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  vscode: "VS Code",
  windsurf: "Windsurf",
};

/**
 * JSON with what VS Code and Notepad add to it: a UTF-8 BOM, `//` and `/* *\/` comments outside
 * strings, and trailing commas. Throws on anything that is still not JSON after that.
 *
 * Strict JSON is tried first: `~/.claude.json` can be tens of megabytes and has none of these, so it
 * is not walked character by character.
 */
export function parseJsonc(text: string): unknown {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(stripTrailingCommas(stripComments(body)));
  }
}

/** Comments outside strings become nothing (a line comment keeps its newline). */
function stripComments(text: string): string {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i = endOfString(text, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      parts.push(text.slice(start, i));
      const newline = text.indexOf("\n", i + 2);
      i = newline === -1 ? text.length : newline;
      start = i;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      parts.push(text.slice(start, i), " ");
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
      start = i;
      continue;
    }
    i += 1;
  }
  parts.push(text.slice(start));
  return parts.join("");
}

/** A comma outside strings that only whitespace separates from `}` or `]` is dropped. */
function stripTrailingCommas(text: string): string {
  const trailing = /,\s*([}\]])/y;
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i = endOfString(text, i);
      continue;
    }
    if (ch === ",") {
      trailing.lastIndex = i;
      if (trailing.test(text)) {
        parts.push(text.slice(start, i));
        start = i + 1;
      }
    }
    i += 1;
  }
  parts.push(text.slice(start));
  return parts.join("");
}

/** The index just past the string that opens at `open`, honouring `\"` and `\\`. */
function endOfString(text: string, open: number): number {
  let i = open + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") i += 2;
    else if (ch === '"') return i + 1;
    else i += 1;
  }
  return text.length;
}

/** A variable as Windows reads it: names in any case, an empty value counting as none. */
function envValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === name && value) return value;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `mcpServers` of a parsed file, as a one-item list when it is an object. */
function field(json: unknown, ...keys: string[]): unknown[] {
  let value: unknown = json;
  for (const key of keys) {
    if (!isObject(value)) return [];
    value = value[key];
  }
  return isObject(value) ? [value] : [];
}

/**
 * The files to read, in the order sources are offered (a server found in two tools is kept from the
 * first). A file under a folder whose variable is missing is not listed.
 */
export function configFiles(env: Record<string, string | undefined>): {
  source: ConfigSource;
  path: string;
  read: (json: unknown) => unknown[];
}[] {
  const appData = envValue(env, "APPDATA");
  const home = envValue(env, "USERPROFILE");
  const files: {
    source: ConfigSource;
    path: string;
    read: (json: unknown) => unknown[];
  }[] = [];
  if (appData) {
    files.push({
      source: "claude-desktop",
      path: win32.join(appData, "Claude", "claude_desktop_config.json"),
      read: (json) => field(json, "mcpServers"),
    });
  }
  if (home) {
    files.push(
      {
        source: "claude-code",
        path: win32.join(home, ".claude.json"),
        read: (json) => {
          const projects = isObject(json) ? json.projects : undefined;
          return [
            ...field(json, "mcpServers"),
            // A project's key is its path: walked through, never kept.
            ...(isObject(projects)
              ? Object.values(projects).flatMap((project) =>
                  field(project, "mcpServers"),
                )
              : []),
          ];
        },
      },
      {
        source: "cursor",
        path: win32.join(home, ".cursor", "mcp.json"),
        read: (json) => field(json, "mcpServers"),
      },
    );
  }
  if (appData) {
    files.push(
      {
        source: "vscode",
        path: win32.join(appData, "Code", "User", "mcp.json"),
        read: (json) => field(json, "servers"),
      },
      {
        source: "vscode",
        path: win32.join(appData, "Code", "User", "settings.json"),
        read: (json) => [
          ...field(json, "mcp", "servers"),
          ...field(json, "mcp.servers"),
        ],
      },
    );
  }
  if (home) {
    files.push({
      source: "windsurf",
      path: win32.join(home, ".codeium", "windsurf", "mcp_config.json"),
      read: (json) => field(json, "mcpServers"),
    });
  }
  return files;
}

/** One entry as we understand it, or undefined for one we do not. */
function specOf(value: unknown): DiscoveredSpec | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.command === "string" && value.command.trim()) {
    const args = value.args ?? [];
    if (
      !Array.isArray(args) ||
      !args.every((arg): arg is string => typeof arg === "string")
    ) {
      return undefined;
    }
    const env: Record<string, string> = {};
    if (isObject(value.env)) {
      for (const [key, item] of Object.entries(value.env)) {
        if (typeof item === "string") env[key] = item;
      }
    }
    const cwd = typeof value.cwd === "string" ? value.cwd.trim() : "";
    return {
      kind: "stdio",
      command: value.command.trim(),
      args: [...args],
      env,
      ...(cwd ? { cwd } : {}),
    };
  }
  const url = typeof value.url === "string" ? value.url : value.serverUrl;
  if (typeof url === "string" && isLoopbackUrl(url.trim())) {
    return { kind: "http", url: url.trim() };
  }
  return undefined;
}

/** The servers of one `{ name: entry }` map, in its order. */
export function serversFromConfig(
  source: ConfigSource,
  entries: Record<string, unknown>,
): FoundServer[] {
  const found: FoundServer[] = [];
  for (const [key, value] of Object.entries(entries)) {
    // A name ends up on approval cards and in the model's context: no line breaks or other controls.
    const plain = key.replace(/\p{Cc}+/gu, " ").trim();
    const name = [...plain].slice(0, APP_NAME_LIMIT).join("").trim();
    if (!name) continue;
    const spec = specOf(value);
    if (spec) found.push({ source, name, spec });
  }
  return found;
}

/** Every server of every file that could be read and parsed, in source order. */
export function readConfigServers(opts: {
  env: Record<string, string | undefined>;
  readText: (path: string) => string | undefined;
}): FoundServer[] {
  const found: FoundServer[] = [];
  for (const file of configFiles(opts.env)) {
    try {
      const text = opts.readText(file.path);
      if (text === undefined) continue;
      for (const entries of file.read(parseJsonc(text))) {
        if (isObject(entries))
          found.push(...serversFromConfig(file.source, entries));
      }
    } catch {
      // This file only: unreadable or not JSON(C), the other tools are still offered.
    }
  }
  return found;
}
