import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reservePort } from "../../tests/support/reserved-port";
import {
  FORWARD_MAX_REQUEST_BYTES,
  FORWARD_MAX_RESPONSE_BYTES,
  forwardHttp,
  validForwardPath,
} from "../src/forward";
import type { ForwardVerdict } from "../src/listeners";

/**
 * The computer's forwarding to a program an employee runs on its loopback.
 *
 * The computer is started as a child process (as file-download-http.test.ts does); the employee's
 * program is a small loopback server in this process. Switched on with XIONGBAO_FORWARD_HTTP=1.
 */

const asked = process.env.XIONGBAO_FORWARD_HTTP === "1";
const TOKEN = "forward-http-test-token";
const BOT = "forward-http";
const AUTH = {
  "x-xiongbao-bot-id": BOT,
  "x-xiongbao-computer-token": TOKEN,
};

let root = "";
let computerPort = 0;
let base = "";
let child: ReturnType<typeof Bun.spawn> | undefined;
let program: ReturnType<typeof Bun.serve> | undefined;
let programPort = 0;
const seenByProgram: { headers: Record<string, string> }[] = [];

beforeAll(async () => {
  if (!asked) return;
  program = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws" && server.upgrade(request)) return undefined;
      if (
        url.pathname === "/ws-close" &&
        server.upgrade(request, { data: { closeAtOnce: true } })
      )
        return undefined;
      if (url.pathname === "/redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "/elsewhere", "set-cookie": "a=b" },
        });
      if (url.pathname === "/big") {
        const total = Number(url.searchParams.get("n"));
        const chunk = new Uint8Array(1024 * 1024).fill(7);
        let sent = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              const size = Math.min(chunk.byteLength, total - sent);
              if (size <= 0) {
                controller.close();
                return;
              }
              controller.enqueue(chunk.subarray(0, size));
              sent += size;
            },
          }),
        );
      }
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        headers[name] = value;
      });
      seenByProgram.push({ headers });
      const body = await request.arrayBuffer();
      return Response.json({
        method: request.method,
        path: url.pathname + url.search,
        headers,
        bodyBytes: body.byteLength,
        text: body.byteLength < 100 ? new TextDecoder().decode(body) : "",
      });
    },
    websocket: {
      maxPayloadLength: 64 * 1024 * 1024,
      open(ws) {
        if ((ws.data as { closeAtOnce?: boolean } | undefined)?.closeAtOnce)
          setTimeout(() => ws.close(), 50);
      },
      message(ws, message) {
        ws.send(message);
      },
    },
  });
  programPort = program.port as number;

  root = await mkdtemp(join(tmpdir(), "forward-http-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  computerPort = await reservePort();
  base = `http://127.0.0.1:${computerPort}`;
  child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      PORT: String(computerPort),
      PROFILES_DIR: join(root, "profiles"),
      WORKSPACE_DIR: workspace,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  const end = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`Computer fixture exited with ${child.exitCode}.`);
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    if (Date.now() > end)
      throw new Error("Timed out waiting for the computer fixture.");
    await Bun.sleep(10);
  }
});

afterAll(async () => {
  if (!asked) return;
  program?.stop(true);
  child?.kill();
  if (child) await child.exited;
  await rm(root, { recursive: true, force: true });
});

function forward(path: string, init: RequestInit = {}, authenticated = true) {
  return fetch(`${base}${path}`, {
    ...init,
    redirect: "manual",
    headers: {
      ...(authenticated ? AUTH : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

describe.skipIf(!asked)("/forward/<port>/<path>", () => {
  test("GET reaches the employee's program on the path and query", async () => {
    const response = await forward(`/forward/${programPort}/echo/a?x=1&y=2`);
    expect(response.status).toBe(200);
    const seen = (await response.json()) as { method: string; path: string };
    expect(seen.method).toBe("GET");
    expect(seen.path).toBe("/echo/a?x=1&y=2");
  });

  test("POST carries its body and method; a bare port is the root path", async () => {
    const posted = await forward(`/forward/${programPort}/in`, {
      method: "POST",
      body: "hello program",
    });
    const seen = (await posted.json()) as { method: string; text: string };
    expect(seen.method).toBe("POST");
    expect(seen.text).toBe("hello program");
    const root = await forward(`/forward/${programPort}`);
    expect(((await root.json()) as { path: string }).path).toBe("/");
  });

  test("no token is 401 and reaches nothing", async () => {
    const before = seenByProgram.length;
    const response = await forward(`/forward/${programPort}/echo`, {}, false);
    expect(response.status).toBe(401);
    expect(seenByProgram.length).toBe(before);
  });

  test("the computer's token, bearer and seat headers never reach the program; others do, Host is its own", async () => {
    const response = await forward(`/forward/${programPort}/echo`, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-openbot-computer-token": TOKEN,
        "x-openbot-bot-id": BOT,
        "x-xiongbao-person-id": "somebody",
        "x-custom": "kept",
        "proxy-authorization": "Basic abc",
        "keep-alive": "timeout=5",
      },
    });
    const { headers } = (await response.json()) as {
      headers: Record<string, string>;
    };
    expect(headers["x-custom"]).toBe("kept");
    expect(headers.host).toBe(`127.0.0.1:${programPort}`);
    for (const name of [
      "authorization",
      "x-xiongbao-computer-token",
      "x-xiongbao-bot-id",
      "x-xiongbao-person-id",
      "x-openbot-computer-token",
      "x-openbot-bot-id",
      "proxy-authorization",
      "keep-alive",
    ])
      expect(headers[name]).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain(TOKEN);
  });

  test("the program's redirect is returned as it is, not followed", async () => {
    const response = await forward(`/forward/${programPort}/redirect`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/elsewhere");
    expect(response.headers.get("set-cookie")).toBe("a=b");
  });

  test("a port with no listener, the computer's own port, a reserved port and odd spellings are 403 with one body", async () => {
    const free = await reservePort();
    const bodies: string[] = [];
    for (const port of [
      free,
      computerPort,
      80,
      22,
      "+8080",
      "0x1F90",
      "abc",
      "99999",
    ]) {
      const response = await forward(`/forward/${port}/x`);
      expect(response.status).toBe(403);
      bodies.push(await response.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });

  test("a path that could leave the host is 400", async () => {
    const response = await forward(`/forward/${programPort}//evil.example/x`);
    expect(response.status).toBe(400);
  });

  test("a request body over the limit is 413; one at the limit goes through", async () => {
    const over = await forward(`/forward/${programPort}/in`, {
      method: "POST",
      body: new Uint8Array(FORWARD_MAX_REQUEST_BYTES + 1),
    });
    expect(over.status).toBe(413);
    const at = await forward(`/forward/${programPort}/in`, {
      method: "POST",
      body: new Uint8Array(FORWARD_MAX_REQUEST_BYTES),
    });
    expect(at.status).toBe(200);
    expect(((await at.json()) as { bodyBytes: number }).bodyBytes).toBe(
      FORWARD_MAX_REQUEST_BYTES,
    );
  });

  test("a response over the limit is cut at the limit", async () => {
    const response = await forward(
      `/forward/${programPort}/big?n=${FORWARD_MAX_RESPONSE_BYTES + 5 * 1024 * 1024}`,
    );
    expect(response.status).toBe(200);
    let received = 0;
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
    }
    expect(received).toBe(FORWARD_MAX_RESPONSE_BYTES);
  }, 60_000);
});

describe.skipIf(!asked)("/forward-ws/<port>/<path>", () => {
  function open(path: string, headers: Record<string, string> = AUTH) {
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${computerPort}${path}`, {
        headers,
      } as never);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => resolve(socket);
      socket.onerror = () => reject(new Error("not opened"));
    });
  }

  test("echoes text and binary both ways", async () => {
    const socket = await open(`/forward-ws/${programPort}/ws`);
    const got: (string | ArrayBuffer)[] = [];
    socket.onmessage = (event) => got.push(event.data);
    socket.send("ping");
    socket.send(new Uint8Array([1, 2, 3]));
    const end = Date.now() + 5000;
    while (got.length < 2 && Date.now() < end) await Bun.sleep(10);
    expect(got[0]).toBe("ping");
    expect([...new Uint8Array(got[1] as ArrayBuffer)]).toEqual([1, 2, 3]);
    socket.close();
  });

  test("the program closing its side closes the client's", async () => {
    const socket = await open(`/forward-ws/${programPort}/ws-close`);
    const closed = new Promise<boolean>((resolve) => {
      socket.onclose = () => resolve(true);
    });
    expect(
      await Promise.race([closed, Bun.sleep(5000).then(() => false)]),
    ).toBe(true);
  });

  test("no token, no listener, the computer's port and a bad port are refused at the upgrade", async () => {
    await expect(open(`/forward-ws/${programPort}/ws`, {})).rejects.toThrow();
    const free = await reservePort();
    await expect(open(`/forward-ws/${free}/ws`)).rejects.toThrow();
    await expect(open(`/forward-ws/${computerPort}/stream`)).rejects.toThrow();
    await expect(open(`/forward-ws/0x1F90/ws`)).rejects.toThrow();
  });

  test("a message over 16 MB closes the socket", async () => {
    const socket = await open(`/forward-ws/${programPort}/ws`);
    const closed = new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
    });
    socket.send(new Uint8Array(17 * 1024 * 1024));
    const code = await Promise.race([closed, Bun.sleep(10_000).then(() => -1)]);
    expect(code).not.toBe(-1);
  }, 20_000);
});

describe("forwardHttp without a computer", () => {
  const request = () => new Request("http://computer/forward/1/x");

  test("every refusal answers 403 with the same body", async () => {
    const verdicts: ForwardVerdict[] = [
      "out-of-range",
      "no-listener",
      "not-yours",
      "self",
    ];
    const answers = await Promise.all(
      verdicts.map(async (verdict) => {
        const response = await forwardHttp({
          request: request(),
          port: 3000,
          path: "/",
          verdict,
        });
        return [response.status, await response.text()] as const;
      }),
    );
    for (const [status] of answers) expect(status).toBe(403);
    expect(new Set(answers.map(([, text]) => text)).size).toBe(1);
  });

  test.each(["x", "//evil", "/a\\b", "/a\u0001b", "/a\nb", "/a\u007fb", ""])(
    "path %p is refused with 400 and not forwarded",
    async (path) => {
      expect(validForwardPath(path)).toBe(false);
      const response = await forwardHttp({
        request: request(),
        port: 3000,
        path,
        verdict: "ok",
      });
      expect(response.status).toBe(400);
    },
  );

  test("ordinary paths are valid", () => {
    for (const path of ["/", "/a/b?c=d&e=%2F", "/@scope/x", "/a:b"])
      expect(validForwardPath(path)).toBe(true);
  });

  test("a program that answers a recheck of not-ok is dropped", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("secret"),
    });
    try {
      const response = await forwardHttp({
        request: request(),
        port: server.port as number,
        path: "/",
        verdict: "ok",
        recheck: () => "not-yours",
      });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("secret");
    } finally {
      server.stop(true);
    }
  });

  test("a closed port is 502", async () => {
    const port = await reservePort();
    const response = await forwardHttp({
      request: request(),
      port,
      path: "/",
      verdict: "ok",
    });
    expect(response.status).toBe(502);
  });
});
