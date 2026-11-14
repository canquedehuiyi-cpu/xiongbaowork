// The headers the server puts on every call to a computer: which Bot, which person, and the computer's token.
//
// They are being renamed from `x-openbot-*` to `x-xiongbao-*`. The release before this one (0.2.11) taught the computer
// to take both names; from this one the server sends only the new ones (shared/wire-headers.ts). So every way the server
// reaches a computer is checked here for the new names and the absence of the old: the gateway's transport, the shared
// computer's provider, the egress policy push, the question of which Bots a computer carries, and the browser routes.
//
// And the two halves together: the server's own transport, calling a real `agent-computer` whose reading of the headers
// is the one 0.2.11 shipped (`git diff v0.2.11 -- agent-computer/src` touches only where the new names are imported
// from), gets in with its token and reaches the seat it named.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  disagreeingWireHeader,
  readWireHeader,
} from "../../agent-computer/src/wire-headers";
import { reservePort } from "../../tests/support/reserved-port";
import { computerCaller } from "../src/browser/routes";
import { createComputerTransport, seatHeaders } from "../src/computer/client";
import { botsOn, pushEgressPolicy } from "../src/computer/policy-network";
import {
  createSharedComputerProvider,
  sharedSeatHeaders,
} from "../src/computer/provider";

/** The wire contract, spelled out rather than read from the module under test. */
const NEW = {
  botId: "x-xiongbao-bot-id",
  personId: "x-xiongbao-person-id",
  computerToken: "x-xiongbao-computer-token",
};
const OLD = [
  "x-openbot-bot-id",
  "x-openbot-person-id",
  "x-openbot-computer-token",
];

const TOKEN = "wire-headers-server-token";

type Sent = { url: string; headers: Headers };

/** A fetch that records what it was sent and answers `body`. */
function recording(body: unknown = {}) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

/** None of the old names is on `headers`, under any spelling. */
function expectNoOldNames(headers: Headers) {
  for (const name of OLD) expect(headers.get(name)).toBeNull();
  for (const [name] of headers) expect(name).not.toMatch(/^x-openbot-/);
}

describe("the seat headers", () => {
  test("a Bot alone goes in the new Bot header", () => {
    const headers = new Headers(seatHeaders("sales"));
    expect(headers.get(NEW.botId)).toBe("sales");
    expect(headers.get(NEW.personId)).toBeNull();
    expectNoOldNames(headers);
  });

  test("a Bot and a person go in the new Bot and person headers", () => {
    const headers = new Headers(
      seatHeaders({ botId: "sales", personId: "user_ada" }),
    );
    expect(headers.get(NEW.botId)).toBe("sales");
    expect(headers.get(NEW.personId)).toBe("user_ada");
    expectNoOldNames(headers);
  });

  test("the shared computer's seat names its Bot and, for a person's seat, the person", () => {
    const person = new Headers(
      sharedSeatHeaders({
        botId: "sales",
        key: { kind: "person", personId: "user_ada" },
      }),
    );
    expect(person.get(NEW.botId)).toBe("sales");
    expect(person.get(NEW.personId)).toBe("user_ada");
    expectNoOldNames(person);

    const bot = new Headers(
      sharedSeatHeaders({
        botId: "sales",
        key: { kind: "bot", botId: "sales" },
      }),
    );
    expect(bot.get(NEW.botId)).toBe("sales");
    expect(bot.get(NEW.personId)).toBeNull();
    expectNoOldNames(bot);
  });
});

describe("every call the server makes to a computer", () => {
  test("the gateway's transport sends the token and the seat under the new names", async () => {
    const { sent, fetchImpl } = recording();
    const transport = createComputerTransport({ token: TOKEN, fetchImpl });
    await transport.call("http://computer.test", "sales", "/snapshot");
    await transport.post(
      { url: "http://computer.test", token: "its-own-token" },
      { botId: "sales", personId: "user_ada" },
      "/click",
      { ref: "e1" },
    );

    expect(sent).toHaveLength(2);
    const [call, post] = sent as [Sent, Sent];
    expect(call.headers.get(NEW.computerToken)).toBe(TOKEN);
    expect(call.headers.get(NEW.botId)).toBe("sales");
    expectNoOldNames(call.headers);
    expect(post.headers.get(NEW.computerToken)).toBe("its-own-token");
    expect(post.headers.get(NEW.botId)).toBe("sales");
    expect(post.headers.get(NEW.personId)).toBe("user_ada");
    expectNoOldNames(post.headers);
  });

  test("the shared computer's provider sends its token and the seat under the new names", async () => {
    const { sent, fetchImpl } = recording({ cleared: true });
    const provider = createSharedComputerProvider({
      baseUrl: "http://computer.test",
      token: TOKEN,
      fetchImpl,
    });
    await provider.reset({
      key: { kind: "person", personId: "user_ada" },
      botId: "sales",
    });

    expect(sent.length).toBeGreaterThan(0);
    for (const { headers } of sent) {
      expect(headers.get(NEW.computerToken)).toBe(TOKEN);
      expect(headers.get(NEW.botId)).toBe("sales");
      expect(headers.get(NEW.personId)).toBe("user_ada");
      expectNoOldNames(headers);
    }
  });

  test("the egress policy push names its Bot and token under the new names", async () => {
    const { sent, fetchImpl } = recording();
    await pushEgressPolicy(
      "http://computer.test",
      "sales",
      { mode: "allow_all", rules: [] },
      { token: TOKEN, fetchImpl },
    );

    expect(sent).toHaveLength(1);
    const [{ headers }] = sent as [Sent];
    expect(headers.get(NEW.computerToken)).toBe(TOKEN);
    expect(headers.get(NEW.botId)).toBe("sales");
    expectNoOldNames(headers);
  });

  test("asking a person's computer which Bots it carries sends the token under the new name", async () => {
    const { sent, fetchImpl } = recording({ computers: [{ botId: "sales" }] });
    expect(
      await botsOn(
        {
          key: { kind: "person", personId: "user_ada" },
          status: "running",
          url: "http://computer.test",
        },
        { token: TOKEN, fetchImpl },
      ),
    ).toEqual(["sales"]);

    expect(sent).toHaveLength(1);
    const [{ headers }] = sent as [Sent];
    expect(headers.get(NEW.computerToken)).toBe(TOKEN);
    expectNoOldNames(headers);
  });

  test("the browser routes' computer calls send the token and the browser under the new names", async () => {
    const { sent, fetchImpl } = recording({ ok: true });
    const ask = computerCaller({ fetchImpl });
    await ask(
      "http://computer.test",
      { botId: "sales", personId: "user_ada" },
      "/bot-browser",
      { token: TOKEN },
    );

    expect(sent).toHaveLength(1);
    const [{ headers }] = sent as [Sent];
    expect(headers.get(NEW.computerToken)).toBe(TOKEN);
    expect(headers.get(NEW.botId)).toBe("sales");
    expect(headers.get(NEW.personId)).toBe("user_ada");
    expectNoOldNames(headers);
  });
});

describe("what the server sends, as the computer reads it", () => {
  test("each header reads back as sent, and none of them disagrees with itself", async () => {
    const { sent, fetchImpl } = recording();
    const transport = createComputerTransport({ token: TOKEN, fetchImpl });
    await transport.call(
      "http://computer.test",
      { botId: "sales", personId: "user_ada" },
      "/snapshot",
    );

    const [{ headers }] = sent as [Sent];
    expect(readWireHeader(headers, "computerToken")).toBe(TOKEN);
    expect(readWireHeader(headers, "botId")).toBe("sales");
    expect(readWireHeader(headers, "personId")).toBe("user_ada");
    expect(disagreeingWireHeader(headers)).toBeUndefined();
  });
});

/**
 * A real computer, as 0.2.11 reads its headers. Separate workspaces, so which Bot a request named shows up as which
 * folder it reached.
 */
describe("a real computer called by the server's transport", () => {
  let base = "";
  let root = "";
  let child: ReturnType<typeof Bun.spawn> | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "server-wire-headers-"));
    for (const name of ["profiles", "workspace", "recorder"])
      await mkdir(join(root, name));
    const port = await reservePort();
    base = `http://127.0.0.1:${port}`;
    child = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts"], {
      cwd: fileURLToPath(new URL("../../agent-computer", import.meta.url)),
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
        OPENBOT_RECORDER_DIR: join(root, "recorder"),
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadline = Date.now() + 20_000;
    while (
      !(await fetch(`${base}/health`).then(
        (response) => response.ok,
        () => false,
      ))
    ) {
      if (Date.now() > deadline || child.exitCode !== null)
        throw new Error("The computer did not start.");
      await Bun.sleep(50);
    }
  }, 30_000);

  afterAll(async () => {
    child?.kill();
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  });

  const transport = () =>
    createComputerTransport({ token: TOKEN, allowPrivateHosts: true });

  async function listed(seat: string): Promise<string[]> {
    const body = await transport().post<{ entries: { path: string }[] }>(
      base,
      seat,
      "/files/list",
      {},
    );
    return body.entries.map((entry) => entry.path);
  }

  test("the right token gets in, and the Bot it named is the folder it reaches", async () => {
    await transport().post(base, "bot-a", "/files/write", {
      path: "from-the-server.txt",
      contents: "a",
    });
    expect(await listed("bot-a")).toContain("from-the-server.txt");
    expect(await listed("bot-b")).not.toContain("from-the-server.txt");
  });

  test("a wrong token under the new name is refused", async () => {
    const wrong = createComputerTransport({
      token: "not-the-token",
      allowPrivateHosts: true,
    });
    await expect(
      wrong.post(base, "bot-a", "/files/list", {}),
    ).rejects.toThrow();
    // The refusal is the computer's, not a failure to reach it: the same call with no token at all is refused the same way,
    // and the right one (above) gets in.
    const response = await fetch(`${base}/files/list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...seatHeaders("bot-a"),
        [NEW.computerToken]: "not-the-token",
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });
});

describe("the computer image", () => {
  test("ships the shared header names its source imports", () => {
    const dockerfile = readFileSync(
      fileURLToPath(
        new URL("../../agent-computer/Dockerfile", import.meta.url),
      ),
      "utf8",
    );
    const finalStage = dockerfile.split(/^FROM\s.*$/m).pop() ?? "";
    expect(
      finalStage
        .split("\n")
        .filter(
          (line) => /^COPY\s/.test(line) && line.trimEnd().endsWith("/shared/"),
        )
        .flatMap((line) => line.trim().split(/\s+/).slice(1, -1)),
    ).toContain("shared/wire-headers.ts");
  });
});
