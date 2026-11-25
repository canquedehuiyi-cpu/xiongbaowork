import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEADER } from "../../shared/wire-headers";

/**
 * The employee channel on a real computer process: who may speak to it. The adapters are not
 * installed here (`XIONGBAO_ACP_ADAPTERS_DIR` names an empty folder), so nothing is ever started; what
 * is checked is the door: the computer token every route needs, the seat, and that a long-lived stream
 * is not cut by the server's idle timeout.
 */

const TOKEN = "acp-http-test-token";
const BOT = "cloud-coder";

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
  root = await mkdtemp(join(tmpdir(), "acp-http-"));
  for (const name of ["profiles", "workspace", "adapters", "state"])
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
      COMPUTER_SEPARATE_WORKSPACES: "on",
      PORT: String(port),
      PROFILES_DIR: join(root, "profiles"),
      WORKSPACE_DIR: join(root, "workspace"),
      XIONGBAO_ACP_ADAPTERS_DIR: join(root, "adapters"),
      XIONGBAO_ACP_STATE_DIR: join(root, "state"),
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

const as = (headers: Record<string, string>) => headers;
const authorised = as({
  [HEADER.computerToken]: TOKEN,
  [HEADER.botId]: BOT,
  "content-type": "application/json",
});
const frame = { type: "acp.open", agentId: BOT, threadId: "th_1" };

describe("who may use the employee channel", () => {
  for (const [method, path] of [
    ["POST", "/acp/frame"],
    ["GET", "/acp/events"],
    ["POST", "/acp/ack"],
  ] as const) {
    test(`${method} ${path} is refused without the computer token, and says nothing about itself`, async () => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { [HEADER.botId]: BOT, "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify(frame) } : {}),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Not authorised." });
    });

    test(`${method} ${path} is refused with another computer's token`, async () => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...authorised,
          [HEADER.computerToken]: `${TOKEN}-of-another-computer`,
        },
        ...(method === "POST" ? { body: JSON.stringify(frame) } : {}),
      });
      expect(response.status).toBe(401);
    });
  }

  test("the stream's query token does not stand in for the header here", async () => {
    // `/stream` and `/terminal` take their token from the query (a socket cannot set headers); the
    // employee channel is plain HTTP and takes it as every other route does.
    const response = await fetch(`${base}/acp/events?token=${TOKEN}`, {
      headers: { [HEADER.botId]: BOT },
    });
    expect(response.status).toBe(401);
  });

  test("with the token but no usable employee id it is refused before anything is made", async () => {
    const response = await fetch(`${base}/acp/frame`, {
      method: "POST",
      headers: {
        [HEADER.computerToken]: TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify(frame),
    });
    expect(response.status).toBe(400);
  });

  test("a frame naming another employee than the seat is refused", async () => {
    const response = await fetch(`${base}/acp/frame`, {
      method: "POST",
      headers: authorised,
      body: JSON.stringify({ ...frame, agentId: "someone-else" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("through the real server", () => {
  test("an open with no model is taken, and the stream says it could not start", async () => {
    const stream = await fetch(`${base}/acp/events`, {
      headers: authorised,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("x-ndjson");
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const lines: Record<string, unknown>[] = [];
    let buffer = "";
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (
          let at = buffer.indexOf("\n");
          at >= 0;
          at = buffer.indexOf("\n")
        ) {
          lines.push(JSON.parse(buffer.slice(0, at)));
          buffer = buffer.slice(at + 1);
        }
      }
    })();
    const opened = await fetch(`${base}/acp/frame`, {
      method: "POST",
      headers: authorised,
      body: JSON.stringify({
        type: "acp.open",
        agentId: BOT,
        threadId: "th_1",
        harness: "claude-code",
        workdirRef: "cloud:workspace",
      }),
    });
    expect(await opened.json()).toEqual({ handled: true });
    const end = Date.now() + 8000;
    while (!lines.some((line) => line.type === "acp.error") && Date.now() < end)
      await Bun.sleep(20);
    expect(lines[0]?.type).toBe("acp.stream");
    expect(lines.find((line) => line.type === "acp.error")).toMatchObject({
      agentId: BOT,
      threadId: "th_1",
      code: "start_failed",
    });
    // The stream stays open and says it is alive: a beat comes (every 4 s) without anything asked.
    const beatBy = Date.now() + 9000;
    while (
      !lines.some((line) => line.type === "acp.beat") &&
      Date.now() < beatBy
    )
      await Bun.sleep(50);
    expect(lines.some((line) => line.type === "acp.beat")).toBe(true);
    await reader.cancel();
    await pump.catch(() => undefined);
  }, 20_000);
});
