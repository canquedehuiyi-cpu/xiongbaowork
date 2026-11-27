import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OLD_ENV_PREFIX } from "../../scripts/brand/guard/words";

/*
 * The dev server (`vite.config.ts`) and the installed app's server (`serve.ts`) never run the API
 * server's entry, so each refuses on its own a root `.env` that still sets the deployment's address
 * only under its name before v0.2.16 (the old prefix, spelled below as the input under test), as the
 * API server refuses it. Each is asked in a process of its own, as the other suites here ask a server,
 * so neither this suite's DOM nor its environment is involved.
 */
const APP = join(import.meta.dir, "..");
const OLD = OLD_ENV_PREFIX;

function run(script: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--no-env-file", "-e", script],
    cwd: APP,
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  const line = result.stdout
    .toString()
    .split("\n")
    .find((text) => text.startsWith("ANSWERS "));
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    answer: line ? JSON.parse(line.slice("ANSWERS ".length)) : undefined,
  };
}

describe("address settings", () => {
  test("the dev server opens to the network for an address beyond this machine, and refuses an old name", () => {
    const { answer, stderr } = run(`
      import { answersBeyondThisMachine } from "./vite.config.ts";
      let refused = "";
      try { answersBeyondThisMachine({ ${OLD}APP_URL: "http://192.168.1.10:3010" }); }
      catch (error) { refused = error.message; }
      console.log("ANSWERS " + JSON.stringify({
        renamed: answersBeyondThisMachine({ XIONGBAO_PUBLIC_URL: "http://192.168.1.10:3001" }),
        loopback: answersBeyondThisMachine({ XIONGBAO_APP_URL: "http://localhost:3010" }),
        none: answersBeyondThisMachine({}),
        refused,
      }));
    `);
    expect(answer, stderr).toMatchObject({
      renamed: true,
      loopback: false,
      none: false,
    });
    expect(answer.refused).toContain(`${OLD}APP_URL`);
    expect(answer.refused).toContain("XIONGBAO_APP_URL");
  }, 60_000);

  test("the installed app's server listens beyond this machine for a new-name address and refuses an old one", () => {
    const hosts = `
      import "./serve.ts";
      import { appListenHosts } from "@xiongbao/shared/this-machine";
      console.log("ANSWERS " + JSON.stringify(appListenHosts(process.env)));
      process.exit(0);
    `;
    expect(
      run(hosts, { XIONGBAO_PUBLIC_URL: "http://192.168.1.10:3001" }).answer,
    ).toEqual(["::"]);
    const refused = run(hosts, {
      [`${OLD}PUBLIC_URL`]: "http://192.168.1.10:3001",
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.answer).toBeUndefined();
    expect(refused.stderr).toContain(`${OLD}PUBLIC_URL`);
  }, 60_000);
});
