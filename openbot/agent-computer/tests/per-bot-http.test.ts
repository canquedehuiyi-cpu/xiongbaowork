import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The per-employee switch, as the HTTP surface shows it.
 *
 * Two real computers: one with `COMPUTER_PER_BOT_USERS=on` and nothing that can give an employee its
 * own user (a temporary workspace, which is not the helper's `/workspace`, and no helper), one with
 * the switch off. What matters is that an employee who cannot have its own user is refused with a
 * 503, never quietly handed the shared workspace or the shared shell, and that with the switch off
 * /health is exactly what it was.
 */

const TOKEN = "per-bot-http-test-token";
const UNREADY = "员工独立电脑未就绪";

type Computer = {
  base: string;
  root: string;
  child: ReturnType<typeof Bun.spawn>;
};

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

async function startComputer(perBotUsers: "on" | "off"): Promise<Computer> {
  const root = await mkdtemp(join(tmpdir(), `per-bot-http-${perBotUsers}-`));
  await mkdir(join(root, "workspace"), { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      COMPUTER_PER_BOT_USERS: perBotUsers,
      PORT: String(port),
      PROFILES_DIR: join(root, "profiles"),
      WORKSPACE_DIR: join(root, "workspace"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const end = Date.now() + 15_000;
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
  return { base, root, child };
}

async function stopComputer(computer: Computer | undefined) {
  if (!computer) return;
  computer.child.kill();
  await computer.child.exited;
  await rm(computer.root, { recursive: true, force: true });
}

function call(
  computer: Computer,
  path: string,
  options: { bot?: string; body?: unknown; method?: string } = {},
) {
  return fetch(`${computer.base}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      "x-openbot-computer-token": TOKEN,
      ...(options.bot ? { "x-openbot-bot-id": options.bot } : {}),
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

const linux = process.platform === "linux";

describe.skipIf(!linux)(
  "switched on, with no way to give an employee its own user",
  () => {
    let computer: Computer | undefined;

    beforeAll(async () => {
      computer = await startComputer("on");
    }, 30_000);

    afterAll(async () => {
      await stopComputer(computer);
    });

    test("/health is a 503 that says why", async () => {
      const response = await fetch(`${computer!.base}/health`);
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.status).toBe("unready");
      expect(body.perBotUsers).toEqual({
        enabled: true,
        ready: false,
        reason: "每员工模式要求工作目录为 /workspace",
      });
      // Everything else is still there, in the published shape.
      expect(Object.keys(body)).toEqual([
        "status",
        "browser",
        "profile",
        "identity",
        "browserMode",
        "browserBackend",
        "browserChannel",
        "perBotUsers",
      ]);
    });

    test.each([
      ["/files/read", { path: "notes.txt" }],
      ["/files/list", {}],
      ["/files/write", { path: "from-a.txt", contents: "a" }],
      ["/exec", { command: "echo ran > ran-by-a.txt" }],
    ])(
      "%s for an employee is a 503, not the shared computer",
      async (path, body) => {
        const response = await call(computer!, path, { bot: "bot-a", body });
        expect(response.status).toBe(503);
        expect(
          ((await response.json()) as { error: string }).error,
        ).toStartWith(UNREADY);
      },
    );

    test("/files/download for an employee is a 503", async () => {
      const response = await call(computer!, "/files/download?path=notes.txt", {
        bot: "bot-a",
      });
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: string }).error).toStartWith(
        UNREADY,
      );
    });

    test("nothing a refused employee asked for reached the shared workspace", async () => {
      const response = await call(computer!, "/files/list", { body: {} });
      expect(response.status).toBe(200);
      const listed = (await response.json()) as { entries: { path: string }[] };
      const paths = listed.entries.map((entry) => entry.path);
      expect(paths).not.toContain("from-a.txt");
      expect(paths).not.toContain("ran-by-a.txt");
    });

    test("the default employee, and a call without the header, still work", async () => {
      const write = await call(computer!, "/files/write", {
        body: { path: "shared.txt", contents: "shared" },
      });
      expect(write.status).toBe(200);
      const read = await call(computer!, "/files/read", {
        bot: "shared",
        body: { path: "shared.txt" },
      });
      expect(read.status).toBe(200);
      expect(((await read.json()) as { text: string }).text).toBe("shared");
      const exec = await call(computer!, "/exec", {
        body: { command: "cat shared.txt" },
      });
      expect(exec.status).toBe(200);
      expect(((await exec.json()) as { stdout: string }).stdout).toBe("shared");
    });
  },
);

describe("switched off", () => {
  let computer: Computer | undefined;

  beforeAll(async () => {
    computer = await startComputer("off");
  }, 30_000);

  afterAll(async () => {
    await stopComputer(computer);
  });

  test("/health is exactly what it was: no per-employee field", async () => {
    const response = await fetch(`${computer!.base}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(Object.keys(body)).toEqual([
      "status",
      "browser",
      "profile",
      "identity",
      "browserMode",
      "browserBackend",
      "browserChannel",
    ]);
  });

  test("an employee shares the workspace and the shell, as before", async () => {
    const write = await call(computer!, "/files/write", {
      bot: "bot-a",
      body: { path: "a.txt", contents: "from a" },
    });
    expect(write.status).toBe(200);
    const exec = await call(computer!, "/exec", {
      bot: "bot-b",
      body: { command: "cat a.txt" },
    });
    expect(exec.status).toBe(200);
    expect(((await exec.json()) as { stdout: string }).stdout).toBe("from a");
  });
});
