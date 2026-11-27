import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OLD_PRODUCT_LOWER } from "../../scripts/brand/guard/words";
import { matchesToken, offeredToken } from "../src/authorisation";
import { startEgressFilter, stopEgressFilter } from "../src/egress";
import { HEADER, readWireHeader } from "../src/wire-headers";

/**
 * The headers the server sends a computer. Only the `x-xiongbao-*` names count: the old product's
 * `x-…-*` names the computer took for a few releases are gone, so a request that carries only those has no
 * token, no Bot and no person.
 */

// The names this computer used to take, written out so the tests can show they grant nothing.
const OLD = {
  botId: `x-${OLD_PRODUCT_LOWER}-bot-id`,
  personId: `x-${OLD_PRODUCT_LOWER}-person-id`,
  computerToken: `x-${OLD_PRODUCT_LOWER}-computer-token`,
  egress: `x-${OLD_PRODUCT_LOWER}-egress`,
} as const;

const SECRET = "a-long-development-secret";
const OTHER = "a-different-long-secret!!";
const url = new URL("http://computer.test/snapshot");

describe("reading a header", () => {
  test("the header is read", () => {
    const headers = new Headers({ [HEADER.botId]: "sales" });
    expect(readWireHeader(headers, "botId")).toBe("sales");
  });

  test("an old name is not read, with or without the new one", () => {
    expect(
      readWireHeader(new Headers({ [OLD.botId]: "sales" }), "botId"),
    ).toBeUndefined();
    expect(
      readWireHeader(new Headers({ [OLD.personId]: "person-old" }), "personId"),
    ).toBeUndefined();
    expect(
      readWireHeader(
        new Headers({
          [HEADER.personId]: "person-new",
          [OLD.personId]: "person-old",
        }),
        "personId",
      ),
    ).toBe("person-new");
    expect(
      readWireHeader(
        new Headers({ [HEADER.botId]: "   ", [OLD.botId]: " sales " }),
        "botId",
      ),
    ).toBeUndefined();
  });

  test("whitespace is trimmed, and nothing is undefined", () => {
    expect(
      readWireHeader(new Headers({ [HEADER.botId]: "  sales  " }), "botId"),
    ).toBe("sales");
    expect(readWireHeader(new Headers(), "botId")).toBeUndefined();
    expect(
      readWireHeader(new Headers({ [HEADER.botId]: " " }), "botId"),
    ).toBeUndefined();
  });

  test("the names are the agreed ones", () => {
    expect(HEADER).toEqual({
      botId: "x-xiongbao-bot-id",
      personId: "x-xiongbao-person-id",
      computerToken: "x-xiongbao-computer-token",
      egress: "x-xiongbao-egress",
    });
  });
});

describe("the computer token", () => {
  const accepted = (init: Record<string, string>) =>
    matchesToken(SECRET, offeredToken(new Headers(init), url));

  test("the header is accepted", () => {
    expect(accepted({ [HEADER.computerToken]: SECRET })).toBeTrue();
  });

  test("the old header alone is not accepted", () => {
    expect(accepted({ [OLD.computerToken]: SECRET })).toBeFalse();
  });

  test("a wrong token is not rescued by a right old header or a right bearer token", () => {
    expect(OTHER).toHaveLength(SECRET.length);
    expect(
      accepted({
        [HEADER.computerToken]: OTHER,
        [OLD.computerToken]: SECRET,
      }),
    ).toBeFalse();
    expect(
      accepted({
        [HEADER.computerToken]: OTHER,
        authorization: `Bearer ${SECRET}`,
      }),
    ).toBeFalse();
  });
});

describe("egress refusal", () => {
  afterEach(async () => {
    await stopEgressFilter();
  });

  function ask(port: number, request: string) {
    return new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(request));
      let seen = "";
      socket.on("data", (chunk) => {
        seen += chunk.toString();
        if (seen.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(seen.split("\r\n\r\n")[0] ?? "");
        }
      });
      socket.on("error", reject);
    });
  }

  test("an egress refusal carries the header", async () => {
    // Nothing pushed, so the filter refuses everything: a tunnel and a plain request each take their
    // own refusal path.
    const filter = await startEgressFilter({ env: {} });
    const where = "127.0.0.1:9";
    const tunnel = await ask(
      filter.port,
      `CONNECT ${where} HTTP/1.1\r\nHost: ${where}\r\n\r\n`,
    );
    const plain = await ask(
      filter.port,
      `GET http://${where}/ HTTP/1.1\r\nHost: ${where}\r\nConnection: close\r\n\r\n`,
    );
    for (const head of [tunnel, plain]) {
      expect(head).toStartWith("HTTP/1.1 403");
      const lower = head.toLowerCase();
      expect(lower).toContain(`\r\n${HEADER.egress}: refused`);
      expect(lower).not.toContain(`\r\n${OLD.egress}:`);
    }
  });
});

/**
 * The same rules on a real computer, where the dispatcher is what applies them. Separate workspaces,
 * so which Bot a request named shows up as which folder it reached.
 */
describe("a computer reading the headers", () => {
  const TOKEN = "wire-headers-test-token";
  let base = "";
  let root = "";
  let child: ReturnType<typeof Bun.spawn> | undefined;

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

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "wire-headers-"));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = Bun.spawn([process.execPath, "src/index.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        COMPUTER_TOKEN: TOKEN,
        COMPUTER_BROWSER_BACKEND: "managed",
        COMPUTER_BROWSER_MODE: "headless",
        COMPUTER_PER_BOT_USERS: "off",
        COMPUTER_SEPARATE_WORKSPACES: "on",
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
  }, 30_000);

  afterAll(async () => {
    child?.kill();
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  });

  function post(path: string, headers: Record<string, string>, body: unknown) {
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  async function listed(headers: Record<string, string>) {
    const response = await post("/files/list", headers, {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entries: { path: string }[] };
    return body.entries.map((entry) => entry.path);
  }

  test("a right token gets in, and the old name alone does not", async () => {
    expect(
      (await post("/files/list", { [HEADER.computerToken]: TOKEN }, {})).status,
    ).toBe(200);
    expect(
      (await post("/files/list", { [OLD.computerToken]: TOKEN }, {})).status,
    ).toBe(401);
  });

  test("a wrong token is a 401, even beside a right old name", async () => {
    const response = await post(
      "/files/list",
      {
        [HEADER.computerToken]: "wrong-token",
        [OLD.computerToken]: TOKEN,
      },
      {},
    );
    expect(response.status).toBe(401);
  });

  test("the Bot is the one the new header names, and the old name names none", async () => {
    const write = await post(
      "/files/write",
      { [HEADER.computerToken]: TOKEN, [HEADER.botId]: "bot-a" },
      { path: "a.txt", contents: "a" },
    );
    expect(write.status).toBe(200);
    expect(
      await listed({ [HEADER.computerToken]: TOKEN, [HEADER.botId]: "bot-a" }),
    ).toContain("a.txt");
    expect(
      await listed({ [HEADER.computerToken]: TOKEN, [HEADER.botId]: "bot-b" }),
    ).not.toContain("a.txt");
    // The old name is not read: the request reaches the default Bot's folder, not bot-a's.
    expect(
      await listed({ [HEADER.computerToken]: TOKEN, [OLD.botId]: "bot-a" }),
    ).not.toContain("a.txt");
  });

  /** A request written by hand, so a header can appear twice: fetch would join them first. */
  function raw(lines: string[]) {
    const { port } = new URL(base);
    return new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1", () =>
        socket.write(
          [
            "POST /files/list HTTP/1.1",
            `Host: 127.0.0.1:${port}`,
            "Content-Type: application/json",
            "Content-Length: 2",
            "Connection: close",
            ...lines,
            "",
            "{}",
          ].join("\r\n"),
        ),
      );
      let seen = "";
      socket.on("data", (chunk) => {
        seen += chunk.toString();
      });
      socket.on("end", () => resolve(seen.split("\r\n")[0] ?? ""));
      socket.on("error", reject);
    });
  }

  test("a token header sent twice, wrong then right, is a 401", async () => {
    // Control: the same hand-written request with one right token gets in.
    expect(await raw([`${HEADER.computerToken}: ${TOKEN}`])).toStartWith(
      "HTTP/1.1 200",
    );
    expect(
      await raw([
        `${HEADER.computerToken}: wrong-token`,
        `${HEADER.computerToken}: ${TOKEN}`,
      ]),
    ).toStartWith("HTTP/1.1 401");
  });
});
