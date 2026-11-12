import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CredentialStore } from "../src/credentials";
import { DATA_DIR_ENV, main, type Options, parseArgs } from "../src/index";

const SERVER = ["--server", "https://bot.example.com"];
const root = mkdtempSync(join(tmpdir(), "openbot-runner-data-dir-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function parsed(argv: string[], env: Record<string, string> = {}): Options {
  const result = parseArgs([...SERVER, ...argv], env, "/launch");
  if (typeof result === "string") throw new Error(result);
  return result;
}

test("without a data directory, every path is where the runner has always put it: the launch directory", () => {
  const { paths, browser } = parsed([]);
  expect(paths).toEqual({
    dataDir: "/launch",
    explicitDataDir: false,
    workspaceDir: "/launch/runner-workspace",
    stateFile: "/launch/runner-state.json",
    journalFile: "/launch/runner-state.json.actions.sqlite",
  });
  expect(browser.profileRoot).toBe("/launch/runner-browser-profiles");
  // A relative --state still means the launch directory, exactly as before.
  expect(parsed(["--state", "my-state.json"]).paths.stateFile).toBe(
    "/launch/my-state.json",
  );
});

test("--data-dir moves the state, the journal, the workspace and the browser profiles under it", () => {
  const { paths, browser } = parsed(["--data-dir", "/var/lib/runner"]);
  expect(paths).toEqual({
    dataDir: "/var/lib/runner",
    explicitDataDir: true,
    workspaceDir: "/var/lib/runner/runner-workspace",
    stateFile: "/var/lib/runner/runner-state.json",
    journalFile: "/var/lib/runner/runner-state.json.actions.sqlite",
  });
  expect(browser.profileRoot).toBe("/var/lib/runner/runner-browser-profiles");
  // Relative paths are taken inside it, so nothing lands in the launch directory by accident.
  const relative = parsed([
    "--data-dir",
    "data",
    "--state",
    "s.json",
    "--browser-profile",
    "profiles",
  ]);
  expect(relative.paths.dataDir).toBe("/launch/data");
  expect(relative.paths.stateFile).toBe("/launch/data/s.json");
  expect(relative.paths.journalFile).toBe("/launch/data/s.json.actions.sqlite");
  expect(relative.browser.profileRoot).toBe("/launch/data/profiles");
  // An absolute path is what the person asked for.
  expect(
    parsed(["--data-dir", "/d", "--state", "/elsewhere/s.json"]).paths
      .stateFile,
  ).toBe("/elsewhere/s.json");
});

test("the environment variable is the same switch, and the flag wins over it", () => {
  expect(parsed([], { [DATA_DIR_ENV]: "/from/env" }).paths).toMatchObject({
    dataDir: "/from/env",
    explicitDataDir: true,
    stateFile: "/from/env/runner-state.json",
  });
  expect(
    parsed(["--data-dir", "/from/flag"], { [DATA_DIR_ENV]: "/from/env" }).paths
      .dataDir,
  ).toBe("/from/flag");
  // Blank is unset, not "the root of the filesystem".
  expect(parsed([], { [DATA_DIR_ENV]: "  " }).paths.dataDir).toBe("/launch");
});

test("a data directory flag with nothing after it, or a token inside the workspace, is refused", () => {
  expect(parseArgs([...SERVER, "--data-dir"], {}, "/launch")).toBe(
    "--data-dir needs a directory.",
  );
  expect(
    parseArgs(
      [...SERVER, "--data-dir", "/d", "--state", "runner-workspace/s.json"],
      {},
      "/launch",
    ),
  ).toBe(
    "--state cannot be inside the runner's workspace, where the file tools reach.",
  );
  expect(
    parseArgs(
      [
        ...SERVER,
        "--data-dir",
        "/d",
        "--browser-profile",
        "runner-workspace/p",
      ],
      {},
      "/launch",
    ),
  ).toBe(
    "--browser-profile cannot be inside the runner's workspace, where the file tools reach.",
  );
});

test("main keeps its token in whatever store it is handed, and never opens the default file instead", async () => {
  const dataDir = join(root, "seam");
  const asked: string[] = [];
  const store =
    (stored: Awaited<ReturnType<CredentialStore["load"]>>) =>
    (stateFile: string): CredentialStore => {
      asked.push(stateFile);
      return {
        location: "test keychain",
        load: async () => stored,
        save: async () => {
          throw new Error("Nothing was paired, so nothing is saved.");
        },
      };
    };

  // Nothing stored and no code: the runner says it needs pairing, before dialling anything.
  expect(await main([...SERVER, "--data-dir", dataDir], store(null))).toBe(2);
  // Stored for another deployment: refused, again before dialling.
  expect(
    await main(
      [...SERVER, "--data-dir", dataDir],
      store({ deviceId: "d", token: "t", server: "https://other.example.com" }),
    ),
  ).toBe(2);
  expect(asked).toEqual([
    join(dataDir, "runner-state.json"),
    join(dataDir, "runner-state.json"),
  ]);
  expect(existsSync(join(dataDir, "runner-state.json"))).toBeFalse();
});

test("parseArgs takes --desktop-helper and --desktop-engine, and refuses an unknown engine", () => {
  // By default: agent-desktop next to the runner's own executable, its state inside the data directory.
  const plain = parsed(["--data-dir", "/d"]).desktop;
  expect(plain).toEqual({
    helper: join(
      dirname(process.execPath),
      `agent-desktop${process.platform === "win32" ? ".exe" : ""}`,
    ),
    stateDir: join("/d", "agent-desktop-state"),
  });
  expect(parsed([]).desktop.stateDir).toBe("/launch/agent-desktop-state");

  const flags = parsed([
    "--desktop-helper",
    "/opt/app/agent-desktop",
    "--desktop-engine",
    "agent-desktop",
  ]).desktop;
  expect(flags).toEqual({
    helper: "/opt/app/agent-desktop",
    engine: "agent-desktop",
    stateDir: "/launch/agent-desktop-state",
  });
  expect(parsed(["--desktop-engine", "legacy"]).desktop.engine).toBe("legacy");
  // A relative helper is taken from the launch directory, like a browser executable.
  expect(parsed(["--desktop-helper", "bin/ad"]).desktop.helper).toBe(
    "/launch/bin/ad",
  );

  // The environment is the same switch, and the flag wins over it.
  const env = {
    OPENBOT_DESKTOP_HELPER: "/env/agent-desktop",
    OPENBOT_DESKTOP_ENGINE: "agent-desktop",
  };
  expect(parsed([], env).desktop).toMatchObject({
    helper: "/env/agent-desktop",
    engine: "agent-desktop",
  });
  expect(
    parsed(["--desktop-helper", "/flag/ad", "--desktop-engine", "legacy"], env)
      .desktop,
  ).toMatchObject({ helper: "/flag/ad", engine: "legacy" });

  const refused = "--desktop-engine must be legacy or agent-desktop.";
  expect(parseArgs([...SERVER, "--desktop-engine", "uia"], {}, "/launch")).toBe(
    refused,
  );
  expect(
    parseArgs(
      [...SERVER],
      { OPENBOT_DESKTOP_ENGINE: "AgentDesktop" },
      "/launch",
    ),
  ).toBe(refused);
  expect(parseArgs([...SERVER, "--desktop-engine"], {}, "/launch")).toBe(
    refused,
  );
  expect(parseArgs([...SERVER, "--desktop-helper"], {}, "/launch")).toBe(
    "--desktop-helper needs a path.",
  );
});
