import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunCli } from "../server/src/learning/ensure-container";
import { setupComposio } from "./setup-composio";

/**
 * `bun run setup:composio`（`scripts/start.sh` 也调用它）认得 Arcade（上游 `setup-composio.test.ts` 里
 * 关于 Arcade 的用例）。
 *
 * 为什么：只配了 ARCADE_API_KEY 的部署用 `start.sh` 启动时，助手以前照样开通一个 Composio 项目、把 key
 * 写进 `.env`，随后服务端发现两个 key 都配了却没有指明提供商，拒绝启动。选了 Arcade 的部署不应该被
 * 自动开通 Composio；明确选了 Composio 的仍然开通，Arcade 的 key 原样留着。
 */
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(content: string) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-composio-arcade-"));
  directories.push(directory);
  const envPath = join(directory, ".env");
  const identityPath = join(directory, ".env.openbot-installation-id");
  await writeFile(envPath, content);
  const calls: string[][] = [];
  const provision: RunCli = async (args) => {
    calls.push(args);
    await writeFile(
      envPath,
      `${await readFile(envPath, "utf8")}\nCOMPOSIO_API_KEY=synthetic-project-key\n`,
      { mode: 0o600 },
    );
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        type: "completed",
        installation_id: args[4],
        project_id: "project-synthetic",
        environment_file_written: true,
        reused: false,
      }),
    };
  };
  return {
    envPath,
    identityPath,
    calls,
    provision,
    options: { directory, environment: {} },
  };
}

test.each([
  [
    "explicit Arcade",
    "OPENBOT_BROKER_PROVIDER=arcade\nARCADE_API_KEY=existing-arcade\n",
    {},
  ],
  ["automatic Arcade", "ARCADE_API_KEY=existing-arcade\n", {}],
  [
    "an Arcade file key behind a blank exported value",
    "ARCADE_API_KEY=existing-arcade\n",
    { ARCADE_API_KEY: "   " },
  ],
  [
    "an Arcade selection written in capitals",
    "OPENBOT_BROKER_PROVIDER=ARCADE\n",
    {},
  ],
] as const)(
  "preserves %s without invoking the CLI or allocating an identity",
  async (_, content, environment) => {
    const f = await fixture(content);
    expect(
      await setupComposio({ ...f.options, environment, runCli: f.provision }),
    ).toBe("preserved");
    // 没有写进 Composio 的 key：服务端不会看到两个 key 而拒绝启动。
    expect(await readFile(f.envPath, "utf8")).toBe(content);
    expect(f.calls).toEqual([]);
    expect(await Bun.file(f.identityPath).exists()).toBe(false);
  },
);

test("an explicit Composio selection can prepare its key while retaining an Arcade key", async () => {
  const content =
    "OPENBOT_BROKER_PROVIDER=composio\nARCADE_API_KEY=existing-arcade\n";
  const f = await fixture(content);
  expect(await setupComposio({ ...f.options, runCli: f.provision })).toBe(
    "configured",
  );
  expect(await readFile(f.envPath, "utf8")).toStartWith(content);
  expect(f.calls).toHaveLength(1);
});

test("an invalid provider is reported without provisioning", async () => {
  const f = await fixture("OPENBOT_BROKER_PROVIDER=invalid\n");
  await expect(
    setupComposio({ ...f.options, runCli: f.provision }),
  ).rejects.toThrow("must be composio or arcade");
  expect(f.calls).toEqual([]);
});
