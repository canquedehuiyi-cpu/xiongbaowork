import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { ACP_MANIFEST } from "../runner/src/acp/manifest";

/*
 * 期八·二: Claude Code runs on the employee's own computer, so the computer's image carries it (and only it:
 * 2026-11-19, Codex employees run only on their owner's own paired computer). Three things have to hold and
 * nothing runs inside that image in a unit test, so they are held here: the adapter (and with it Claude
 * Code) is installed when the image is built, at the exact version the launch manifest names, from a
 * lockfile; and every module the computer's ACP host
 * imports at run time is copied into the image, because one that is missed dies on the computer's first
 * start, which no other test would see.
 */

const root = join(import.meta.dir, "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const dockerfile = read("agent-computer", "Dockerfile");

describe("the adapters are installed when the image is built", () => {
  const manifest = JSON.parse(
    read("docker", "acp-adapters", "package.json"),
  ) as {
    dependencies: Record<string, string>;
  };

  test("only Claude Code's adapter is pinned, to the exact version the launch manifest names", () => {
    expect(manifest.dependencies).toEqual({
      "@agentclientprotocol/claude-agent-acp": "0.107.0",
    });
    for (const version of Object.values(manifest.dependencies))
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    // What a device runs through `npx` and what the image installs are one version.
    expect(ACP_MANIFEST["claude-code"].adapter.args).toContain(
      "@agentclientprotocol/claude-agent-acp@0.107.0",
    );
  });

  test("the lockfile resolves the adapter, and the Claude Code it brings, to that version, with no Codex in it", () => {
    const lock = read("docker", "acp-adapters", "bun.lock");
    expect(lock).toContain('"@agentclientprotocol/claude-agent-acp@0.107.0"');
    // Claude Code comes with the adapter's SDK.
    expect(lock).toContain('"@anthropic-ai/claude-agent-sdk@');
    expect(lock.toLowerCase()).not.toContain("codex");
  });

  test("a step of its own installs them from the lockfile, ahead of the source copies, and checks what it installed", () => {
    const lines = dockerfile.split("\n");
    const copy = lines.findIndex((line) =>
      line.startsWith("COPY docker/acp-adapters/package.json"),
    );
    const install =
      copy +
      1 +
      lines
        .slice(copy + 1)
        .findIndex(
          (line) => /^RUN\b/.test(line) && line.includes("bun install"),
        );
    expect(copy).toBeGreaterThan(0);
    expect(lines[copy]).toContain("docker/acp-adapters/bun.lock");
    expect(lines[copy - 1]).toBe("WORKDIR /opt/xiongbao-acp");
    expect(lines[install]).toContain("--frozen-lockfile");
    // The step is the lines of that RUN, continuation lines included.
    const run: string[] = [];
    for (let at = install; at < lines.length; at += 1) {
      run.push(lines[at] ?? "");
      if (!(lines[at] ?? "").endsWith("\\")) break;
    }
    const text = run.join("\n");
    expect(text).toContain('"0.107.0"');
    expect(text).toContain("claude-agent-acp");
    // No Codex in the computer's image, in the step or anywhere in the Dockerfile's commands.
    expect(dockerfile).not.toMatch(/^(?!#).*codex/im);
    // Nothing is downloaded when an employee starts: the launch is the installed copy, never `npx`.
    expect(dockerfile).not.toMatch(/\bnpx\b.*codex-acp/);
    // Before the sources that change: editing the computer's source does not install it all again.
    const sources = lines.findIndex((line) =>
      line.startsWith("COPY agent-computer/src"),
    );
    expect(install).toBeLessThan(sources);
    expect(dockerfile).toContain(
      "ENV XIONGBAO_ACP_ADAPTERS_DIR=/opt/xiongbao-acp",
    );
  });
});

function listFiles(directory: string): string[] {
  return readdirSync(join(root, directory)).flatMap((name) => {
    const path = `${directory}/${name}`;
    return statSync(join(root, path)).isDirectory() ? listFiles(path) : [path];
  });
}

/** Every repository file the final stage copies, with the path it has in the image. */
function imageFiles(): Map<string, string> {
  const finalStage = dockerfile.split(/^FROM\s.*$/m).pop() ?? "";
  const copied = new Map<string, string>();
  let workdir = "/";
  for (const line of finalStage.split("\n")) {
    if (line.startsWith("WORKDIR "))
      workdir = posix.resolve("/", line.slice(8).trim());
    if (!/^COPY\s/.test(line) || line.includes("--from")) continue;
    const parts = line.trim().split(/\s+/).slice(1);
    // A relative destination is relative to the WORKDIR in force.
    const destination =
      posix.resolve(workdir, parts.pop() as string) +
      (line.trim().endsWith("/") ? "/" : "");
    for (const source of parts) {
      if (!existsSync(join(root, source))) continue;
      if (statSync(join(root, source)).isDirectory()) {
        for (const file of listFiles(source))
          copied.set(
            file,
            posix.join(destination, file.slice(source.length + 1)),
          );
      } else
        copied.set(
          source,
          destination.endsWith("/")
            ? posix.join(destination, posix.basename(source))
            : destination,
        );
    }
  }
  return copied;
}

/** The relative modules a file imports at run time: not `import type`, not an all-type import list. */
function runtimeImports(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(
    /^(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+"(\.[^"]+)"/gm,
  )) {
    if (match[1]) continue;
    const names = (match[2] ?? "").replace(/[{}]/g, "").split(",");
    if (
      names.every(
        (name) => name.trim() === "" || name.trim().startsWith("type "),
      )
    )
      continue;
    found.push(match[3] as string);
  }
  for (const match of source.matchAll(/^import\s+"(\.[^"]+)"/gm))
    found.push(match[1] as string);
  return found;
}

describe("the computer's ACP host has everything it imports in the image", () => {
  const copied = imageFiles();
  const entry = "agent-computer/src/acp-cloud.ts";

  test("the files it needs are copied, and by name the ones the host is built on", () => {
    for (const file of [
      entry,
      "runner/src/acp/host.ts",
      "runner/src/acp/client.ts",
      "runner/src/acp/manifest.ts",
      "runner/src/idle.ts",
      "runner/src/mcp-client.ts",
      "runner/src/bundled-runtime.ts",
      "shared/acp.ts",
    ])
      expect(copied.has(file)).toBe(true);
    // Not the MCP bridge: the idle time is its own file for exactly that reason.
    expect(copied.has("runner/src/app-host.ts")).toBe(false);
    expect(copied.has("runner/src/index.ts")).toBe(false);
  });

  test("every module a copied file imports at run time is copied to where the import looks", () => {
    const missing: string[] = [];
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const here = copied.get(file) as string;
      for (const spec of runtimeImports(read(file))) {
        // The import as the image resolves it, then back to the repository file it names.
        const wanted = `${posix.normalize(posix.join(posix.dirname(here), spec))}.ts`;
        const target = [...copied].find(([, image]) => image === wanted);
        if (!target) missing.push(`${file} imports ${spec} (${wanted})`);
        else walk(target[0]);
      }
    };
    walk(entry);
    expect(missing).toEqual([]);
    // And the walk reached the host, so the check above looked at something.
    expect(seen.has("runner/src/acp/host.ts")).toBe(true);
    expect(seen.has("runner/src/mcp-client.ts")).toBe(true);
  });
});

describe("the server image, which runs the computer too, has the host's files", () => {
  const root_ = read("Dockerfile");
  test("runner/src/acp and the three runner modules it needs are copied to /app/runner/src", () => {
    // The computer resolves `../../runner/src/...` from /app/agent-computer/src; without them it dies at start.
    expect(root_).toContain("COPY runner/src/acp /out/runner/src/acp");
    expect(root_).toContain(
      "COPY runner/src/idle.ts runner/src/mcp-client.ts runner/src/bundled-runtime.ts /out/runner/src/",
    );
    expect(root_).toContain(
      "COPY --from=runtime-src /out/runner/src runner/src",
    );
    // shared/ is copied whole there, which carries shared/acp.ts.
    expect(root_).toContain("COPY shared /out/shared");
  });
});
