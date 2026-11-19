import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEADER } from "../../shared/wire-headers";

/**
 * 期五 D, as the server's transport reaches it: `/files/read` with a line range, `/files/edit`,
 * `/files/grep` and `/files/glob` on a real computer, in the Bot's own workspace.
 */

const TOKEN = "coding-http-test-token";
const BOT = "coding-bot";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("The port probe did not return a TCP address."));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

let root = "";
let base = "";
let child: ReturnType<typeof Bun.spawn> | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "coding-http-"));
  for (const name of ["profiles", "workspace", "recorder"])
    await mkdir(join(root, name), { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      COMPUTER_TOKEN: TOKEN,
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      COMPUTER_PER_BOT_USERS: "off",
      PORT: String(port),
      PROFILES_DIR: join(root, "profiles"),
      WORKSPACE_DIR: join(root, "workspace"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const end = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`Computer fixture exited with ${child.exitCode}.`);
    try {
      await fetch(`${base}/health`);
      break;
    } catch {}
    if (Date.now() > end)
      throw new Error("Timed out waiting for the computer fixture.");
    await Bun.sleep(20);
  }
}, 30_000);

afterAll(async () => {
  child?.kill();
  await child?.exited;
  await rm(root, { recursive: true, force: true });
});

async function call(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      [HEADER.computerToken]: TOKEN,
      [HEADER.botId]: BOT,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as never };
}

describe("the coding routes", () => {
  test("write, read a line range, edit, search by content and by name", async () => {
    const written = await call("/files/write", {
      path: "src/app.ts",
      contents: "const a = 1;\nconst b = 2;\nconst c = 3;\n",
    });
    expect(written.status).toBe(200);

    const range = await call("/files/read", {
      path: "src/app.ts",
      offset: 2,
      limit: 1,
    });
    expect(range.body).toMatchObject({
      text: "     2\tconst b = 2;\n",
      startLine: 2,
      endLine: 2,
      totalLines: 3,
    });
    // Without a range, the read it always was; a range that is not whole numbers is ignored.
    const whole = await call("/files/read", {
      path: "src/app.ts",
      offset: "2",
    });
    expect(whole.body).toMatchObject({
      text: "const a = 1;\nconst b = 2;\nconst c = 3;\n",
    });

    const edited = await call("/files/edit", {
      path: "src/app.ts",
      old_string: "const b = 2;",
      new_string: "const b = 20;",
    });
    expect(edited).toEqual({
      status: 200,
      body: {
        path: "src/app.ts",
        edited: true,
        replacements: 1,
        bytes: 40,
      } as never,
    });
    const missing = await call("/files/edit", {
      path: "src/app.ts",
      old_string: "nowhere",
      new_string: "x",
    });
    expect(missing.status).toBe(200);
    expect(missing.body).toMatchObject({ edited: false });

    const found = await call("/files/grep", {
      pattern: "b = 2\\d",
      glob: "*.ts",
    });
    expect(found.body).toMatchObject({
      matches: 1,
      text: "src/app.ts:2:const b = 20;",
      truncated: false,
    });

    const named = await call("/files/glob", { pattern: "**/*.ts" });
    expect(named.body).toMatchObject({ paths: ["src/app.ts"] });

    expect(
      await readFile(
        join(root, "workspace", BOT, "src", "app.ts"),
        "utf8",
      ).catch(() => readFile(join(root, "workspace", "src", "app.ts"), "utf8")),
    ).toContain("const b = 20;");
  });

  test("a call without what it needs is a 400; a path outside is refused", async () => {
    expect((await call("/files/edit", { path: "a.txt" })).status).toBe(400);
    expect((await call("/files/grep", {})).status).toBe(400);
    expect((await call("/files/glob", { pattern: " " })).status).toBe(400);
    const outside = await call("/files/edit", {
      path: "../escape.txt",
      old_string: "a",
      new_string: "b",
    });
    expect(outside.status).toBe(403);
  });
});
