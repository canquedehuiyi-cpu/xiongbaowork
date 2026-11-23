import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEADER } from "../../shared/wire-headers";

/** `POST /files/stat`, as the server's evidence gate reaches it: what is at a workspace path. */

const TOKEN = "files-stat-http-test-token";
const BOT = "stat-bot";

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
  root = await mkdtemp(join(tmpdir(), "files-stat-http-"));
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

describe("POST /files/stat", () => {
  test("200 for a file and a folder, 404 for nothing there, 403 for a path outside the workspace", async () => {
    const written = await call("/files/write", {
      path: "reports/a.md",
      contents: "hello",
    });
    expect(written.status).toBe(200);

    const file = await call("/files/stat", { path: "reports/a.md" });
    expect(file.status).toBe(200);
    expect(file.body).toMatchObject({ kind: "file", bytes: 5 });

    const folder = await call("/files/stat", { path: "reports" });
    expect(folder.status).toBe(200);
    expect(folder.body).toMatchObject({ kind: "folder" });

    expect(
      (await call("/files/stat", { path: "reports/none.md" })).status,
    ).toBe(404);
    expect(
      (await call("/files/stat", { path: "../../etc/passwd" })).status,
    ).toBe(403);
  });
});
