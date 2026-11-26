import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/*
 * The dev server (`vite.config.ts`) and the installed app's server (`serve.ts`) never run the API
 * server's entry, so each runs the alias step itself: a root `.env` written before the rename names the
 * deployment's address under the old prefix, and both must still open to the network for it, as the
 * API server does. Each is asked in a process of its own, as the other suites here ask a server, so
 * neither this suite's DOM nor its environment is involved.
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
 */
const APP = join(import.meta.dir, "..");

function ask(script: string, env: Record<string, string> = {}): unknown {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--no-env-file", "-e", script],
    cwd: APP,
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  const line = result.stdout
    .toString()
    .split("\n")
    .find((text) => text.startsWith("ANSWERS "));
  if (!line) throw new Error(`no answer: ${result.stderr.toString()}`);
  return JSON.parse(line.slice("ANSWERS ".length));
}

describe("address settings under the old names", () => {
  test("the dev server opens to the network for an old-name address, as for a new one", () => {
    expect(
      ask(`
        import { answersBeyondThisMachine } from "./vite.config.ts";
        const given = { OPENBOT_APP_URL: "http://192.168.1.10:3010" };
        console.log("ANSWERS " + JSON.stringify({
          legacy: answersBeyondThisMachine(given),
          renamed: answersBeyondThisMachine({ XIONGBAO_PUBLIC_URL: "http://192.168.1.10:3001" }),
          loopback: answersBeyondThisMachine({ OPENBOT_APP_URL: "http://localhost:3010" }),
          none: answersBeyondThisMachine({}),
          untouched: Object.keys(given),
        }));
      `),
    ).toEqual({
      legacy: true,
      renamed: true,
      loopback: false,
      none: false,
      untouched: ["OPENBOT_APP_URL"],
    });
  }, 60_000);

  test("the installed app's server listens beyond this machine for an old-name address", () => {
    const hosts = `
      import "./serve.ts";
      import { appListenHosts } from "@xiongbao/shared/this-machine";
      console.log("ANSWERS " + JSON.stringify(appListenHosts(process.env)));
    `;
    expect(
      ask(hosts, { OPENBOT_PUBLIC_URL: "http://192.168.1.10:3001" }),
    ).toEqual(["::"]);
    expect(
      ask(hosts, { OPENBOT_PUBLIC_URL: "http://localhost:3001" }),
    ).not.toEqual(["::"]);
  }, 60_000);
});
