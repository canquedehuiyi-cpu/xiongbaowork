import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerProbe } from "../src/learning/auto-assign";
import {
  cliEnvironment,
  cliLoginPresent,
  cmdLineSafe,
  createLearningContainer,
  ensureLearningContainer,
  type KeyIntelligence,
  keyIntelligence,
  learningSetupInstructions,
  MANAGED_API,
  npxCommand,
  runNpx,
  stopProcessTree,
} from "../src/learning/ensure-container";
import {
  type FakeIntelligence,
  fakeIntelligence,
  intelligenceError,
  RUNTIME_KEY,
} from "./support/intelligence-learning";

const SELF_HOSTED = "https://intelligence.customer.example";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

/**
 * The pid the command under the shell wrote for itself. Polled rather than slept on: the shell has
 * to start before the command can run, and a fixed wait would be a guess in both directions.
 */
async function pidFrom(marker: string): Promise<number> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const text = await readFile(marker, "utf8").catch(() => "");
    if (text.trim() !== "") return Number(text.trim());
    if (Date.now() > deadline)
      throw new Error(`the command under the shell never wrote ${marker}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Whether `pid` stopped existing within `budget`. `process.kill(pid, 0)` delivers no signal; it only
 * asks the operating system whether the process is there, so this is a liveness question.
 */
async function goneWithin(pid: number, budget: number): Promise<boolean> {
  const deadline = Date.now() + budget;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function key(answers: ContainerProbe[]): KeyIntelligence & {
  probes: number;
} {
  const view = {
    probes: 0,
    probe: async () => {
      view.probes++;
      return answers.shift() ?? "absent";
    },
    // `KeyIdentity` is the slugs *and* the display names — the CLI login it is compared against
    // reports names, never slugs — so a fixture with only two of the four describes no project.
    project: async () => ({
      organizationSlug: "team",
      projectSlug: "chosen",
      organizationName: "Team",
      projectName: "Chosen",
    }),
  };
  return view;
}

function intelligenceFetch(status: number, body: unknown) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return Response.json(body, { status });
    },
    { preconnect: () => {} },
  ) as typeof globalThis.fetch;
  return { requests, fetch };
}

const serviceToken = { token: "synthetic-service-token", projectId: "7" };

describe("creating the container with a service token", () => {
  test("posts the openbot container to the token's project and proves it with the key", async () => {
    const api = intelligenceFetch(201, {
      container: { id: "openbot", projectId: 7, name: "OpenBot" },
    });
    const runtimeKey = key(["absent", "present"]);
    expect(
      await ensureLearningContainer({
        directory: tmpdir(),
        apiUrl: SELF_HOSTED,
        nonInteractive: true,
        key: runtimeKey,
        serviceToken,
        fetch: api.fetch,
        run: async () => {
          throw new Error("No CLI with a service token");
        },
      }),
    ).toBe("created");
    expect(api.requests).toHaveLength(1);
    const request = api.requests[0] as { url: string; init: RequestInit };
    expect(request.url).toBe(
      `${SELF_HOSTED}/api/learning/projects/7/containers`,
    );
    expect(request.init.method).toBe("POST");
    const headers = request.init.headers as Record<string, string>;
    expect(headers["x-copilotkit-ei-service-token"]).toBe(serviceToken.token);
    expect(JSON.parse(String(request.init.body))).toEqual({
      id: "openbot",
      name: "XiongBao Work",
    });
    expect(runtimeKey.probes).toBe(2);
  });

  test("one that already exists is present, not an error", async () => {
    const api = intelligenceFetch(409, {
      error: { code: "LEARNING_CONTAINER_ALREADY_EXISTS" },
    });
    expect(
      await ensureLearningContainer({
        directory: tmpdir(),
        apiUrl: SELF_HOSTED,
        nonInteractive: true,
        key: key(["absent", "present"]),
        serviceToken,
        fetch: api.fetch,
      }),
    ).toBe("present");
  });

  test("a refused token says where service tokens work, and nothing is assigned", async () => {
    const api = intelligenceFetch(403, { error: { code: "FORBIDDEN" } });
    await expect(
      ensureLearningContainer({
        directory: tmpdir(),
        apiUrl: MANAGED_API,
        nonInteractive: true,
        key: key(["absent"]),
        serviceToken,
        fetch: api.fetch,
      }),
    ).rejects.toThrow("only on a CopilotKit local evaluation install");
  });

  test("a container in another project is reported, not assigned", async () => {
    const wrongProject = intelligenceFetch(201, {
      container: { id: "openbot", projectId: 8 },
    });
    await expect(
      ensureLearningContainer({
        directory: tmpdir(),
        apiUrl: SELF_HOSTED,
        nonInteractive: true,
        key: key(["absent"]),
        serviceToken,
        fetch: wrongProject.fetch,
      }),
    ).rejects.toThrow("other than the openbot container");
    const invisible = intelligenceFetch(201, {
      container: { id: "openbot", projectId: 7 },
    });
    await expect(
      ensureLearningContainer({
        directory: tmpdir(),
        apiUrl: SELF_HOSTED,
        nonInteractive: true,
        key: key(["absent", "absent"]),
        serviceToken,
        fetch: invisible.fetch,
      }),
    ).rejects.toThrow("another project");
  });

  test("a container already there never reaches Intelligence's write route", async () => {
    const api = intelligenceFetch(500, {});
    expect(
      await ensureLearningContainer({
        directory: tmpdir(),
        apiUrl: SELF_HOSTED,
        nonInteractive: true,
        key: key(["present"]),
        serviceToken,
        fetch: api.fetch,
      }),
    ).toBe("present");
    expect(api.requests).toHaveLength(0);
  });
});

describe("with no credential that can create it", () => {
  test("self-hosted without a person or a token is skipped, and the CLI is not run", async () => {
    let runs = 0;
    expect(
      await ensureLearningContainer({
        directory: tmpdir(),
        apiUrl: SELF_HOSTED,
        nonInteractive: true,
        key: key(["absent"]),
        run: async () => {
          runs++;
          return { exitCode: 0, stdout: "{}" };
        },
      }),
    ).toBe("skipped");
    expect(runs).toBe(0);
  });

  test("the instructions name the exact steps for each kind of Intelligence", () => {
    const managed = learningSetupInstructions(MANAGED_API);
    expect(managed).toContain("npx --yes copilotkit@latest login");
    expect(managed).toContain("bun scripts/setup-learning.ts");
    expect(managed).toContain("config.learning.setup.cliLoginSecret");
    expect(managed).toContain('ID "openbot"');
    const selfHosted = learningSetupInstructions(SELF_HOSTED);
    expect(selfHosted).toContain("bun scripts/setup-learning.ts");
    expect(selfHosted).toContain(
      "INTELLIGENCE_SERVICE_TOKEN and INTELLIGENCE_PROJECT_ID",
    );
  });
});

describe("the CopilotKit CLI", () => {
  test("a login is found where the CLI keeps it, and only there", async () => {
    const home = await mkdtemp(join(tmpdir(), "openbot-cli-home-"));
    directories.push(home);
    expect(cliLoginPresent({}, "darwin", home)).toBe(false);
    await mkdir(join(home, "Library/Preferences/copilotkit-auth-nodejs"), {
      recursive: true,
    });
    await writeFile(
      join(home, "Library/Preferences/copilotkit-auth-nodejs/config.json"),
      "{}",
    );
    expect(cliLoginPresent({}, "darwin", home)).toBe(true);
    expect(cliLoginPresent({}, "linux", home)).toBe(false);
    const configured = join(home, "mounted");
    expect(
      cliLoginPresent({ COPILOTKIT_CONFIG_DIR: configured }, "darwin", home),
    ).toBe(false);
    await mkdir(join(configured, "auth"), { recursive: true });
    await writeFile(join(configured, "auth/config.json"), "{}");
    expect(
      cliLoginPresent({ COPILOTKIT_CONFIG_DIR: configured }, "linux", home),
    ).toBe(true);
  });

  test("runs without this process's secrets", () => {
    const environment = cliEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/openbot",
      COPILOTKIT_CONFIG_DIR: "/var/run/copilotkit",
      INTELLIGENCE_API_KEY: "cpk-secret",
      INTELLIGENCE_SERVICE_TOKEN: "secret",
      DATABASE_URL: "postgres://secret",
      COPILOTKIT_LICENSE_TOKEN: "secret",
    });
    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/openbot",
      COPILOTKIT_CONFIG_DIR: "/var/run/copilotkit",
      COPILOTKIT_TELEMETRY_DISABLED: "1",
    });
  });

  test("is started through a shell on Windows, where npx is a .cmd", () => {
    expect(npxCommand("win32")).toEqual({ command: "npx.cmd", shell: true });
    expect(npxCommand("darwin")).toEqual({ command: "npx", shell: false });
    expect(npxCommand("linux")).toEqual({ command: "npx", shell: false });
  });

  test("passes only arguments cmd.exe would not run or expand", () => {
    expect(
      cmdLineSafe([
        "--yes",
        "copilotkit@latest",
        "project",
        "select",
        "--project",
        "a1B2c",
        "--json",
      ]),
    ).toBe(true);
    for (const unsafe of [
      "abc&calc",
      "abc|calc",
      "%PATH%",
      "a^b",
      "a b",
      'a"b',
      "a<b",
      "a>b",
      "(a)",
      "a=b",
      "",
    ])
      expect(cmdLineSafe(["project", "select", "--project", unsafe])).toBe(
        false,
      );
  });

  // Since CVE-2024-27980, spawning a .cmd without a shell throws EINVAL before anything runs.
  //
  // The explicit timeout is the point: `runNpx` allows its child two minutes (see
  // `src/learning/ensure-container.ts`), and bun's default per-test ceiling is five seconds, so the
  // case was measuring whether `cmd.exe` starts within a budget nobody chose rather than whether the
  // spawn throws EINVAL. It passed alone and timed out inside the full file, which reads as a broken
  // spawn helper and is not one.
  test.if(process.platform === "win32")(
    "starts on this Windows machine instead of throwing EINVAL",
    async () => {
      const result = await runNpx(["--version"], tmpdir());
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    },
    30_000,
  );

  test.if(process.platform === "win32")(
    "refuses an argument the Windows shell would run, without starting it",
    async () => {
      const result = await runNpx(["--version", "x&echo INJECTED"], tmpdir());
      expect(result).toEqual({ exitCode: 1, stdout: "" });
    },
  );

  // Killing cmd.exe alone leaves the command under it running with the pipes, so the shell's
  // `close` event waits for that command: it did, for 28 seconds, which is `ping -n 30` running its
  // natural course after the tree kill had already returned.
  //
  // WHAT CHANGED, AND WHY. The case used to wait for `close` within four seconds and read a later
  // one as "the tree was left behind". That conflated three different things — the kill happening,
  // the descendant dying, and bun emitting an event — and named the wrong one when it failed. It now
  // runs a command that writes its own pid and asks the operating system whether that pid still
  // exists, which is the claim itself.
  //
  // WHAT IT MEASURES ON A WINDOWS MACHINE, 2026-11-18. Called directly, awaited, with piped stdio,
  // `taskkill /pid <shell> /T /F` exits 0 and its output names both pids as terminated. Called the
  // way `stopProcessTree` calls it — fire and forget, `stdio: "ignore"` — the descendant survived in
  // every run (4/4) and only the shell went. So this case stays red here for a product-level reason,
  // not a fixture one: "stop the tree" is a request nobody checks the result of. The fix is on the
  // product side (verify, or hold the tree in a job object as `desktop-device` already does for its
  // daemon); narrowing this assertion again would only hide it.
  test.if(process.platform === "win32")(
    "a stopped command takes the processes under its shell with it",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "openbot-tree-"));
      directories.push(directory);
      const marker = join(directory, "pid");
      const script = join(directory, "sleep.mjs");
      await writeFile(
        script,
        [
          `import { writeFileSync } from "node:fs";`,
          `writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
          `setTimeout(() => {}, 30_000);`,
          ``,
        ].join("\n"),
      );

      // Through a shell, because that is the shape `runCli` has: cmd.exe holds the process, and the
      // command it started is what a bare `child.kill()` would leave running.
      const child = spawn(process.execPath, [script], {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.resume();
      child.stderr.resume();
      const grandchild = await pidFrom(marker);

      stopProcessTree(child, true);
      expect(await goneWithin(grandchild, 4_000)).toBe(true);
    },
    30_000,
  );
});

describe("creating a container with the runtime key", () => {
  const served: FakeIntelligence[] = [];
  afterEach(() => {
    for (const intelligence of served.splice(0)) intelligence.stop();
  });
  const serve = (
    version: Parameters<typeof fakeIntelligence>[0],
    containers: string[] = [],
  ) => {
    const intelligence = fakeIntelligence(version, { containers });
    served.push(intelligence);
    return intelligence;
  };
  const credentials = (intelligence: FakeIntelligence) => ({
    directory: tmpdir(),
    apiUrl: intelligence.url,
    nonInteractive: true,
    key: keyIntelligence(intelligence.url, RUNTIME_KEY, "ws://127.0.0.1:9"),
  });
  const person = { id: "user-4f2a9c", name: "Ada" };

  test("makes a person's space in the key's own project, naming no project", async () => {
    const intelligence = serve("current");
    expect(
      await createLearningContainer({
        ...credentials(intelligence),
        container: person,
        // Never reached: the key could do it.
        serviceToken,
      }),
    ).toBe("created");
    const posts = intelligence.requests.filter((r) => r.method === "POST");
    expect(posts).toEqual([
      {
        method: "POST",
        path: "/api/v1/learning/containers",
        auth: `Bearer ${RUNTIME_KEY}`,
        body: { id: "user-4f2a9c", name: "Ada" },
      },
    ]);
    expect(intelligence.containers.has("user-4f2a9c")).toBe(true);
  });

  test("one already there is present, whether Intelligence says 200 or 409", async () => {
    expect(
      await createLearningContainer({
        ...credentials(serve("current", ["user-4f2a9c"])),
        container: person,
      }),
    ).toBe("present");
    // An Intelligence that reports a taken id as a conflict instead.
    const conflict = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => intelligenceError("LEARNING_CONTAINER_ALREADY_EXISTS"),
    });
    try {
      const url = `http://127.0.0.1:${conflict.port}`;
      expect(
        await createLearningContainer({
          directory: tmpdir(),
          apiUrl: url,
          nonInteractive: true,
          key: keyIntelligence(url, RUNTIME_KEY, "ws://127.0.0.1:9"),
          container: person,
        }),
      ).toBe("present");
    } finally {
      conflict.stop(true);
    }
  });

  test("on Intelligence 0.15.1, which has no such route, the other credentials are tried", async () => {
    const intelligence = serve("0.15.1");
    // Nothing else here: skipped, as before, rather than an error.
    expect(
      await createLearningContainer({
        ...credentials(intelligence),
        container: person,
      }),
    ).toBe("skipped");
    // A service token is the next one tried.
    const token = intelligenceFetch(201, {
      container: { id: "user-4f2a9c", projectId: 7, name: "Ada" },
    });
    expect(
      await createLearningContainer({
        ...credentials(intelligence),
        container: person,
        serviceToken,
        fetch: token.fetch,
      }),
    ).toBe("created");
    expect(token.requests.map((r) => r.url)).toEqual([
      `${intelligence.url}/api/learning/projects/7/containers`,
    ]);
  });

  test("ensuring the openbot default proves it with the key afterwards", async () => {
    const intelligence = serve("current");
    expect(await ensureLearningContainer(credentials(intelligence))).toBe(
      "created",
    );
    expect(intelligence.containers.has("openbot")).toBe(true);
  });

  test("Learning switched off in Intelligence is said, not reported as unreachable", async () => {
    await expect(
      ensureLearningContainer(credentials(serve("learning-off"))),
    ).rejects.toThrow("Learning is switched off in the back end");
  });
});
