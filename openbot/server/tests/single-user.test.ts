import { describe, expect, test } from "bun:test";
import { singleUserEnabled } from "../src/auth/dev-actor";

/**
 * Whether this deployment lets every visitor in as one administrator.
 *
 * The most dangerous boolean in the codebase and it had no test. It used to be locked with
 * `NODE_ENV === "production"`, which is exactly the wrong way round: `NODE_ENV` is unset unless
 * somebody sets it, so a container on a VM with a hand-written env file and no identity provider
 * served the whole internet as an administrator, silently, because nothing was wrong from the
 * outside. It now takes an explicit flag and refuses to start without one.
 *
 * The cases below are the four a deployment can actually be in.
 *
 * This function still reads only the flag, which is what these cases pin, and `NODE_ENV` still
 * decides nothing here. Whether a deployment may HAVE no sign-in is a second question, asked by
 * `singleUserAllowed` in config.ts, which refuses it on any address other people can reach. The old
 * lock is not back: that one granted permission from a variable unset by default, and this one only
 * ever adds a refusal.
 */
describe("running with no sign-in", () => {
  test("a configured provider always wins, whatever else is set", () => {
    // A provider means sign-in, so the flag cannot half-disable it. Asserted with the flag on,
    // because the dangerous reading is "the flag opens a deployment that has a provider".
    expect(singleUserEnabled({ OPENBOT_SINGLE_USER: "true" }, true)).toBe(
      false,
    );
    expect(singleUserEnabled({}, true)).toBe(false);
  });

  test("no provider and the flag set runs open, because somebody said so", () => {
    expect(singleUserEnabled({ OPENBOT_SINGLE_USER: "true" }, false)).toBe(
      true,
    );
  });

  test("the older name for the flag still works, so an existing .env keeps running", () => {
    expect(singleUserEnabled({ OPENBOT_DEV_NO_AUTH: "true" }, false)).toBe(
      true,
    );
  });

  test("no provider and no flag refuses to start", () => {
    // The whole point. Not a warning, not a default: a deployment that would admit everybody as an
    // administrator does not come up, and says what to configure.
    expect(() => singleUserEnabled({}, false)).toThrow(
      /No identity provider is configured/,
    );
  });

  test("NODE_ENV decides nothing, in either direction", () => {
    // The previous lock. A server with NODE_ENV unset was the case it had to catch and the case it
    // let through, so neither value may change the answer now.
    expect(() =>
      singleUserEnabled({ NODE_ENV: "development" }, false),
    ).toThrow();
    expect(() =>
      singleUserEnabled({ NODE_ENV: "production" }, false),
    ).toThrow();
    expect(
      singleUserEnabled(
        { NODE_ENV: "production", OPENBOT_SINGLE_USER: "true" },
        false,
      ),
    ).toBe(true);
  });

  test("a flag set to anything but true is not a yes", () => {
    // Read exactly, so `OPENBOT_SINGLE_USER=false` and a stray `1` both refuse rather than opening.
    for (const value of ["false", "1", "yes", "TRUE", ""]) {
      expect(() =>
        singleUserEnabled({ OPENBOT_SINGLE_USER: value }, false),
      ).toThrow();
    }
  });
});

/*
 * M3: the routes this fork appends in index.ts (the board, quota, devices, models, platform and the
 * rest) mounted `createDevRequireUser()` with no access, which is the strictest reading: this machine
 * only. Inside the image that refused every request, because the engine's proxy is the peer of all of
 * them, while upstream's own routes (app.ts) were handed the deployment's access and answered. The
 * image smoke check caught it as eight 403s. Every single-user guard takes the deployment's access.
 */
describe("every single-user guard takes the deployment's access", () => {
  test("index.ts never mounts the guard without it", async () => {
    const source = await Bun.file(
      new URL("../src/index.ts", import.meta.url),
    ).text();
    expect(source).not.toMatch(/createDevRequireUser\(\s*\)/);
    expect(source).toContain("createDevRequireUser(config.singleUserAccess)");
  });

  test("in a container, a caller from the engine's network is the administrator; on a machine, it is not", async () => {
    const { Hono } = await import("hono");
    const { createDevRequireUser } = await import("../src/auth/dev-actor");
    const answer = async (access: {
      thisMachineOnly: boolean;
      hosts: string[];
    }) => {
      const app = new Hono();
      app.use("*", createDevRequireUser(access));
      app.get("/api/tasks", (context) => context.json({ ok: true }));
      return (
        await app.request(
          "http://127.0.0.1:3772/api/tasks",
          { headers: { host: "127.0.0.1:3772" } },
          { caller: { address: "172.17.0.1" } },
        )
      ).status;
    };
    expect(await answer({ thisMachineOnly: false, hosts: ["localhost"] })).toBe(
      200,
    );
    expect(await answer({ thisMachineOnly: true, hosts: ["localhost"] })).toBe(
      403,
    );
  });
});
