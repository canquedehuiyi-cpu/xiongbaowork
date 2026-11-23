import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEADER } from "../../shared/wire-headers";

/** `POST /files/mark` and `/files/changes`: what a turn left behind. */

const TOKEN = "turn-changes-http-test-token";
const BOT = "changes-bot";

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
  root = await mkdtemp(join(tmpdir(), "turn-changes-http-"));
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

describe("POST /files/mark and /files/changes", () => {
  test("lists a file written after the mark, 404 for an unknown mark, 400 without one", async () => {
    expect((await call("/files/mark", { mark: "t1" })).status).toBe(200);
    await call("/files/write", { path: "out/deck.md", contents: "hello" });
    const changes = await call("/files/changes", { mark: "t1" });
    expect(changes.status).toBe(200);
    expect(changes.body).toMatchObject({
      files: [{ path: "out/deck.md", bytes: 5, change: "new" }],
      omitted: 0,
    });
    expect((await call("/files/changes", { mark: "t1" })).status).toBe(404);
    expect((await call("/files/mark", {})).status).toBe(400);
  });
});
