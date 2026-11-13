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
import { matchesToken, offeredToken } from "../src/authorisation";
import { startEgressFilter, stopEgressFilter } from "../src/egress";
import {
  disagreeingWireHeader,
  HEADER,
  LEGACY_HEADER,
  readWireHeader,
} from "../src/wire-headers";

/**
 * The headers the server sends a computer, under their new names and their old ones.
 *
 * A computer is upgraded before the server that talks to it, so for a release it has to take both.
 * Taking both is where a check can open: a request carrying a wrong token under one name and the right
 * one under the other must never get in because one of the two matched. So the rule is one value per
 * header. The new name is read when it has one, the old name otherwise, and a request whose two names
 * carry different values is refused rather than resolved.
 */

const SECRET = "a-long-development-secret";
const OTHER = "a-different-long-secret!!";
const url = new URL("http://computer.test/snapshot");

describe("reading a header under either name", () => {
  test("only the new header", () => {
    const headers = new Headers({ [HEADER.botId]: "sales" });
    expect(readWireHeader(headers, "botId")).toBe("sales");
  });

  test("only the old header", () => {
    const headers = new Headers({ [LEGACY_HEADER.botId]: "sales" });
    expect(readWireHeader(headers, "botId")).toBe("sales");
  });

  test("both, new wins", () => {
    const headers = new Headers({
      [HEADER.personId]: "person-new",
      [LEGACY_HEADER.personId]: "person-old",
    });
    expect(readWireHeader(headers, "personId")).toBe("person-new");
  });

  test("blank new falls back to old", () => {
    const headers = new Headers({
      [HEADER.botId]: "   ",
      [LEGACY_HEADER.botId]: " sales ",
    });
    expect(readWireHeader(headers, "botId")).toBe("sales");
  });

  test("whitespace is trimmed, and nothing under either name is undefined", () => {
    expect(
      readWireHeader(new Headers({ [HEADER.botId]: "  sales  " }), "botId"),
    ).toBe("sales");
    expect(readWireHeader(new Headers(), "botId")).toBeUndefined();
    expect(
      readWireHeader(
        new Headers({ [HEADER.botId]: " ", [LEGACY_HEADER.botId]: "" }),
        "botId",
      ),
    ).toBeUndefined();
  });

  test("the names are the agreed ones", () => {
    expect(HEADER).toEqual({
      botId: "x-xiongbao-bot-id",
      personId: "x-xiongbao-person-id",
      computerToken: "x-xiongbao-computer-token",
      egress: "x-xiongbao-egress",
    });
    expect(Object.keys(LEGACY_HEADER)).toEqual(Object.keys(HEADER));
  });
});

describe("two names that disagree", () => {
  test("different values under the two names are named", () => {
    const headers = new Headers({
      [HEADER.botId]: "sales",
      [LEGACY_HEADER.botId]: "research",
    });
    expect(disagreeingWireHeader(headers)).toBe("botId");
  });

  test("the same value under both, once trimmed, is not a disagreement", () => {
    const headers = new Headers({
      [HEADER.botId]: "sales",
      [LEGACY_HEADER.botId]: " sales ",
      [HEADER.personId]: "p1",
      [LEGACY_HEADER.personId]: "p1",
    });
    expect(disagreeingWireHeader(headers)).toBeUndefined();
  });

  test("a blank name next to a filled one is not a disagreement", () => {
    expect(
      disagreeingWireHeader(
        new Headers({ [HEADER.botId]: " ", [LEGACY_HEADER.botId]: "sales" }),
      ),
    ).toBeUndefined();
    expect(
      disagreeingWireHeader(new Headers({ [HEADER.personId]: "p1" })),
    ).toBeUndefined();
  });
});

describe("the computer token under either name", () => {
  const accepted = (init: Record<string, string>) =>
    matchesToken(SECRET, offeredToken(new Headers(init), url));

  test("the new header alone is accepted", () => {
    expect(accepted({ [HEADER.computerToken]: SECRET })).toBeTrue();
  });

  test("the old header alone is still accepted", () => {
    expect(accepted({ [LEGACY_HEADER.computerToken]: SECRET })).toBeTrue();
  });

  test("the same token under both names is accepted", () => {
    expect(
      accepted({
        [HEADER.computerToken]: SECRET,
        [LEGACY_HEADER.computerToken]: SECRET,
      }),
    ).toBeTrue();
  });

  test("a request with a wrong new token and a right old token is refused", () => {
    expect(OTHER).toHaveLength(SECRET.length);
    expect(
      accepted({
        [HEADER.computerToken]: OTHER,
        [LEGACY_HEADER.computerToken]: SECRET,
      }),
    ).toBeFalse();
  });

  test("a request with a right new token and a wrong old token is refused too", () => {
    // Either way round, two tokens that differ are one forged and one not, and nothing says which.
    expect(
      accepted({
        [HEADER.computerToken]: SECRET,
        [LEGACY_HEADER.computerToken]: OTHER,
      }),
    ).toBeFalse();
  });

  test("a disagreement is not rescued by a right bearer token", () => {
    expect(
      accepted({
        [HEADER.computerToken]: OTHER,
        [LEGACY_HEADER.computerToken]: OTHER.toUpperCase(),
        authorization: `Bearer ${SECRET}`,
      }),
    ).toBeFalse();
  });

  test("a wrong new token is not rescued by a right bearer token", () => {
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

  test("egress refusal carries both header names", async () => {
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
      expect(lower).toContain(`\r\n${LEGACY_HEADER.egress}: refused`);
    }
  });
});

/**
 * The same rules on a real computer, where the dispatcher is what applies them. Separate workspaces,
 * so which Bot a request named shows up as which folder it reached.
 */
describe("a computer taking both names", () => {
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

  test("a right new token gets in, and so does a right old one", async () => {
    expect(
      (await post("/files/list", { [HEADER.computerToken]: TOKEN }, {})).status,
    ).toBe(200);
    expect(
      (await post("/files/list", { [LEGACY_HEADER.computerToken]: TOKEN }, {}))
        .status,
    ).toBe(200);
  });

  test("tokens that disagree are a 401, whichever name holds the right one", async () => {
    for (const [fresh, legacy] of [
      ["wrong-token", TOKEN],
      [TOKEN, "wrong-token"],
    ]) {
      const response = await post(
        "/files/list",
        {
          [HEADER.computerToken]: fresh as string,
          [LEGACY_HEADER.computerToken]: legacy as string,
        },
        {},
      );
      expect(response.status).toBe(401);
    }
  });

  test("the Bot named under the new name is the one the old name reaches", async () => {
    const write = await post(
      "/files/write",
      { [HEADER.computerToken]: TOKEN, [HEADER.botId]: "bot-a" },
      { path: "a.txt", contents: "a" },
    );
    expect(write.status).toBe(200);
    expect(
      await listed({
        [LEGACY_HEADER.computerToken]: TOKEN,
        [LEGACY_HEADER.botId]: "bot-a",
      }),
    ).toContain("a.txt");
    expect(
      await listed({ [HEADER.computerToken]: TOKEN, [HEADER.botId]: "bot-b" }),
    ).not.toContain("a.txt");
  });

  test("Bots that disagree are a 400 and reach no folder", async () => {
    for (const name of ["botId", "personId"] as const) {
      const response = await post(
        "/files/write",
        {
          [HEADER.computerToken]: TOKEN,
          [HEADER[name]]: "bot-a",
          [LEGACY_HEADER[name]]: "bot-b",
        },
        { path: `disagreed-${name}.txt`, contents: "x" },
      );
      expect(response.status).toBe(400);
    }
    for (const bot of ["bot-a", "bot-b"])
      expect(
        await listed({ [HEADER.computerToken]: TOKEN, [HEADER.botId]: bot }),
      ).not.toContain("disagreed-botId.txt");
  });
});
