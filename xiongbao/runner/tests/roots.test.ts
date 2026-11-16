import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunnerExecutor } from "../src/execute";
import { heartbeatFrame, parseRootCommand, runRootCommand } from "../src/index";
import { createRootRegistry, ROOTS_FILE } from "../src/roots";

/*
 * Story F1, stage 2 (S2): the owner's read-only folders on this machine. Registered locally, reached
 * through the workspace's own confinement, read and listed and never written, and reported to the
 * server as a reference and a name without the path.
 */

const scratch = mkdtempSync(join(tmpdir(), "openbot-runner-roots-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;

/** A data directory, a folder outside it with a few files, and an executor that offers it. */
function machine() {
  made += 1;
  const base = join(scratch, `m${made}`);
  const dataDir = join(base, "data");
  const workspace = join(dataDir, "runner-workspace");
  const folder = join(base, "工作资料");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(folder, "周报"), { recursive: true });
  writeFileSync(join(folder, "周报", "第一周.md"), "# 第一周\n完成了接入。\n");
  writeFileSync(join(folder, ".env"), "TOKEN=not-a-real-one\n");
  writeFileSync(join(dataDir, "runner-state.json"), '{"token":"secret"}\n');
  const outside = join(base, "outside.txt");
  writeFileSync(outside, "outside the folder\n");
  const roots = createRootRegistry({
    dataDir,
    privatePaths: [join(dataDir, "runner-state.json"), workspace, dataDir],
  });
  const execute = createRunnerExecutor(workspace, undefined, roots);
  return { base, dataDir, workspace, folder, outside, roots, execute };
}

/** Every file under a directory with its bytes, so "nothing changed" is checked, not assumed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile())
        out[full.slice(dir.length)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

test("a registered folder gets an opaque reference; the server is told the reference and the name, never the path", () => {
  const { dataDir, folder, roots } = machine();
  const root = roots.add("工作资料", folder);
  expect(root.ref).toMatch(/^fld_[A-Za-z0-9_-]{22}$/);
  expect(root.name).toBe("工作资料");
  expect(roots.list()).toEqual([root]);
  expect(roots.reported()).toEqual([{ ref: root.ref, name: "工作资料" }]);

  const frame = heartbeatFrame(roots);
  expect(JSON.parse(frame)).toEqual({
    type: "heartbeat",
    roots: [{ ref: root.ref, name: "工作资料" }],
  });
  expect(frame).not.toContain(folder);
  expect(frame).not.toContain(scratch);

  // Kept beside the token, private like it.
  const file = join(dataDir, ROOTS_FILE);
  expect(readFileSync(file, "utf8")).toContain(folder);
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
  }
});

test("registration refuses what is not a folder, a relative path, a duplicate and anything over the runner's own files", () => {
  const { base, dataDir, workspace, folder, outside, roots } = machine();
  expect(() => roots.add("", folder)).toThrow("起个名字");
  expect(() => roots.add("x".repeat(61), folder)).toThrow("最多 60 个字");
  expect(() => roots.add("相对", "工作资料")).toThrow("绝对路径");
  expect(() => roots.add("没有", join(base, "missing"))).toThrow("找不到");
  expect(() => roots.add("文件", outside)).toThrow("不是文件夹");
  // The token, the workspace and the whole data directory, from above, at, and below.
  expect(() => roots.add("上层", base)).toThrow("数据目录");
  expect(() => roots.add("数据", dataDir)).toThrow("数据目录");
  expect(() => roots.add("工作区", workspace)).toThrow("数据目录");

  roots.add("工作资料", folder);
  expect(() => roots.add("工作资料", join(base, "工作资料", "周报"))).toThrow(
    "已经有一个",
  );
  expect(() => roots.add("另一个名字", folder)).toThrow("已经以「工作资料」");
  expect(roots.list()).toHaveLength(1);
});

test("files.read and files.list reach a root through the workspace's confinement, with the same read limit", async () => {
  const { folder, roots, execute } = machine();
  const { ref } = roots.add("工作资料", folder);

  const read = await execute({
    action: "files.read",
    payload: { root: ref, path: "周报/第一周.md" },
  });
  expect(read).toEqual({
    ok: true,
    output: {
      path: "周报/第一周.md",
      text: "# 第一周\n完成了接入。\n",
      truncated: false,
      bytes: Buffer.byteLength("# 第一周\n完成了接入。\n"),
    },
  });

  const listed = await execute({
    action: "files.list",
    payload: { root: ref },
  });
  expect(listed.ok).toBeTrue();
  const entries = (listed as { output: { entries: { path: string }[] } }).output
    .entries;
  expect(entries.map((entry) => entry.path).sort()).toEqual(
    [".env", "周报", "周报/第一周.md"].sort(),
  );

  // The per-read limit of the workspace applies unchanged.
  writeFileSync(join(folder, "big.txt"), "a".repeat(70_000));
  const big = await execute({
    action: "files.read",
    payload: { root: ref, path: "big.txt" },
  });
  expect(big).toMatchObject({
    ok: true,
    output: { truncated: true, bytes: 70_000 },
  });
  expect((big as { output: { text: string } }).output.text).toHaveLength(
    64_000,
  );
});

test("a root refuses absolute paths, '..' and a symlink that leads out of it", async () => {
  const { folder, outside, dataDir, roots, execute } = machine();
  const { ref } = roots.add("工作资料", folder);
  const read = (path: string) =>
    execute({ action: "files.read", payload: { root: ref, path } });

  expect(await read(outside)).toMatchObject({
    ok: false,
    error: expect.stringContaining("absolute"),
  });
  expect(await read("../outside.txt")).toMatchObject({
    ok: false,
    error: expect.stringContaining(".."),
  });
  symlinkSync(outside, join(folder, "link.txt"));
  symlinkSync(join(dataDir, "runner-state.json"), join(folder, "token.json"));
  expect(await read("link.txt")).toMatchObject({
    ok: false,
    error: expect.stringContaining("outside"),
  });
  expect(await read("token.json")).toMatchObject({
    ok: false,
    error: expect.stringContaining("outside"),
  });
  expect(
    await execute({
      action: "files.list",
      payload: { root: ref, path: "../" },
    }),
  ).toMatchObject({ ok: false });
});

test("every write aimed at a root is refused and nothing on disk changes", async () => {
  const { folder, workspace, roots, execute } = machine();
  const { ref } = roots.add("工作资料", folder);
  const before = snapshot(folder);
  const workspaceBefore = snapshot(workspace);

  for (const attempt of [
    {
      action: "files.write",
      payload: { root: ref, path: "周报/第一周.md", contents: "overwritten" },
    },
    {
      action: "files.write",
      payload: { root: ref, path: "new.txt", contents: "new", append: true },
    },
    { action: "files.delete", payload: { root: ref, path: "周报/第一周.md" } },
    {
      action: "files.move",
      payload: { root: ref, path: "周报/第一周.md", to: "moved.md" },
    },
    { action: "exec", payload: { root: ref, command: "rm -rf 周报" } },
    { action: "exec", payload: { cwd: ref, command: "touch made-here" } },
  ]) {
    const outcome = await execute(attempt);
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("read-only"),
    });
  }
  expect(snapshot(folder)).toEqual(before);
  // Refused, not redirected: the workspace did not get the write instead.
  expect(snapshot(workspace)).toEqual(workspaceBefore);
});

test("an unknown root is refused, including one removed a moment ago and one on a machine that offers none", async () => {
  const { folder, roots, execute, workspace } = machine();
  const { ref } = roots.add("工作资料", folder);
  expect(
    await execute({
      action: "files.read",
      payload: { root: "fld_AAAAAAAAAAAAAAAAAAAAAA", path: "周报/第一周.md" },
    }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("no folder") });
  expect(
    await execute({ action: "files.list", payload: { root: 42 } }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("no folder") });

  expect(roots.remove(ref)).toBeTrue();
  expect(
    await execute({
      action: "files.read",
      payload: { root: ref, path: "周报/第一周.md" },
    }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("no folder") });

  // An executor given no registry offers nothing, rather than reading the workspace instead.
  writeFileSync(join(workspace, "notes.md"), "workspace file");
  const bare = createRunnerExecutor(workspace);
  expect(
    await bare({
      action: "files.read",
      payload: { root: ref, path: "notes.md" },
    }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("no folder") });
  // Without a root the workspace is read exactly as before.
  expect(
    await bare({ action: "files.read", payload: { path: "notes.md" } }),
  ).toMatchObject({ ok: true, output: { text: "workspace file" } });
});

test("the server can ask a machine to forget a root, and can never add one", async () => {
  const { folder, roots, execute } = machine();
  const { ref } = roots.add("工作资料", folder);
  expect(
    await execute({
      action: "roots.add",
      payload: { path: folder, name: "x" },
    }),
  ).toMatchObject({ ok: false });
  expect(roots.list()).toHaveLength(1);
  expect(await execute({ action: "roots.forget", payload: { ref } })).toEqual({
    ok: true,
    output: { removed: true },
  });
  expect(roots.list()).toEqual([]);
  expect(await execute({ action: "roots.forget", payload: { ref } })).toEqual({
    ok: true,
    output: { removed: false },
  });
});

test("the command line adds, lists and removes folders without a server, printing one JSON line each", () => {
  const { base, folder } = machine();
  const dataDir = join(base, "cli-data");
  const lines: string[] = [];
  const run = (argv: string[]) => {
    const parsed = parseRootCommand(argv, {}, base);
    if (parsed === null || typeof parsed === "string") {
      throw new Error(`not a root command: ${parsed}`);
    }
    return runRootCommand(parsed, (line) => lines.push(line));
  };
  expect(
    parseRootCommand(["--server", "https://bot.example.com"], {}, base),
  ).toBeNull();
  expect(parseRootCommand(["--add-root", "nameonly"], {}, base)).toContain(
    "NAME=PATH",
  );
  expect(
    parseRootCommand(["--list-roots", "--remove-root", "x"], {}, base),
  ).toContain("one of");

  expect(run(["--data-dir", dataDir, "--add-root", `周报=${folder}`])).toBe(0);
  const added = JSON.parse(lines.at(-1) as string);
  expect(added).toMatchObject({
    ok: true,
    root: { name: "周报", path: folder },
  });

  expect(run(["--list-roots", "--data-dir", dataDir])).toBe(0);
  expect(JSON.parse(lines.at(-1) as string).roots).toEqual([added.root]);

  // Over the data directory is refused, with the reason, and a non-zero exit.
  expect(run(["--data-dir", dataDir, "--add-root", `数据=${dataDir}`])).toBe(2);
  expect(JSON.parse(lines.at(-1) as string)).toMatchObject({
    ok: false,
    error: expect.stringContaining("数据目录"),
  });

  expect(run(["--data-dir", dataDir, "--remove-root", "周报"])).toBe(0);
  expect(JSON.parse(lines.at(-1) as string)).toEqual({ ok: true, roots: [] });
  expect(run(["--data-dir", dataDir, "--remove-root", "周报"])).toBe(2);
});
