import { afterEach, describe, expect, test } from "bun:test";
import Arcade, { APIError } from "@arcadeai/arcadejs";
import { useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import { BrokerRefusalError } from "../src/plugins/broker";
import type { AccountRef } from "../src/plugins/shared-accounts";

/**
 * 单用户安装拥有自己的 Arcade 项目，连接之前把项目的用户验证地址指向自己（上游
 * `arcade-verifier-address.integration.test.ts` 的要点，在 adapter 这一层重写）。
 *
 * 为什么：同意完成后 Arcade 把浏览器送到项目里填的验证地址。那个地址不是这台安装时，人会落到一个不存在
 * 的页面上，或者落到另一台安装上。单用户安装就是自己项目的管理员，所以每次铸授权之前读一下、不对就改；
 * 要登录的部署把项目当作共享的，只读、不改，地址不对就在任何同意开始之前拒绝。改不了、改了读回来不对，
 * 也都在铸授权之前拒绝：没有人被送去一个回不来的同意页面。
 */
type Methods = Record<string, (...args: unknown[]) => unknown>;
const restores: (() => void)[] = [];
function stub(
  on: Methods,
  name: string,
  impl: (...args: unknown[]) => unknown,
) {
  const was = on[name];
  on[name] = impl;
  restores.push(() => {
    on[name] = was;
  });
}
afterEach(() => {
  while (restores.length) restores.pop()?.();
  useArcadeClient(null);
});

const HERE = "https://one.example/api/plugins/arcade/verify";
const ELSEWHERE = "http://localhost:3001/api/plugins/arcade/verify";
const SETTINGS = "/v1/admin/settings/session_verification";
const account: AccountRef = {
  holder: "person",
  userId: "dev-local-user",
  vendorUserId: "dev-local-user:own",
};

/** Arcade 项目的验证设置与授权端点；记下每一次读、写和铸授权的先后。 */
function project(initial: string | null, options: { takesPut?: boolean } = {}) {
  let verifier = initial;
  const calls: string[] = [];
  const client = Arcade.prototype as unknown as Methods;
  stub(client, "get", (path) => {
    calls.push(`GET ${String(path)}`);
    return Promise.resolve({
      verifier_url: verifier,
      unsafe_skip_verification: false,
    });
  });
  stub(client, "put", (path, request) => {
    const body = (request as { body: { verifier_url: string } }).body;
    calls.push(`PUT ${String(path)} ${body.verifier_url}`);
    if (options.takesPut === false) {
      return Promise.reject(
        new APIError(
          403,
          { name: "forbidden", message: "not an admin key" },
          undefined,
          new Headers(),
        ),
      );
    }
    verifier = body.verifier_url;
    return Promise.resolve({ verifier_url: verifier });
  });
  stub(
    Object.getPrototypeOf(new Arcade({ apiKey: "never-dialled" }).tools),
    "authorize",
    () => {
      calls.push("MINT");
      return Promise.resolve({
        id: "ar_1",
        status: "pending",
        url: "https://consent.example/x",
      });
    },
  );
  return { calls, verifier: () => verifier };
}

const authorize = (options: {
  verifierUrl?: string;
  repointVerifier?: boolean;
}) =>
  createArcadeClient("never-dialled", options).broker.authorize({
    account,
    toolkit: "Github",
    returnUrl: "https://one.example/settings",
    action: "Github.CreateIssue",
  });

describe("an install that owns its Arcade project", () => {
  test("points the verifier at itself before the consent is minted", async () => {
    const arcade = project(ELSEWHERE);
    const minted = await authorize({
      verifierUrl: HERE,
      repointVerifier: true,
    });
    expect(minted.authorizationId).toBe("ar_1");
    expect(arcade.verifier()).toBe(HERE);
    expect(arcade.calls).toEqual([
      `GET ${SETTINGS}`,
      `PUT ${SETTINGS} ${HERE}`,
      `GET ${SETTINGS}`,
      "MINT",
    ]);
  });

  test("reads a verifier that already names it and leaves it alone", async () => {
    const arcade = project(HERE);
    await authorize({ verifierUrl: HERE, repointVerifier: true });
    expect(arcade.calls).toEqual([`GET ${SETTINGS}`, "MINT"]);
  });

  test("refuses the Connect when Arcade will not take the setting, and mints nothing", async () => {
    const arcade = project(ELSEWHERE, { takesPut: false });
    await expect(
      authorize({ verifierUrl: HERE, repointVerifier: true }),
    ).rejects.toBeInstanceOf(BrokerRefusalError);
    expect(arcade.calls).not.toContain("MINT");
    expect(arcade.verifier()).toBe(ELSEWHERE);
  });
});

describe("a deployment that signs people in treats the project as shared", () => {
  test("never changes the verifier, and refuses before any consent when it names somewhere else", async () => {
    const arcade = project(ELSEWHERE);
    await expect(
      authorize({ verifierUrl: HERE, repointVerifier: false }),
    ).rejects.toBeInstanceOf(BrokerRefusalError);
    expect(arcade.calls).toEqual([`GET ${SETTINGS}`]);
    expect(arcade.verifier()).toBe(ELSEWHERE);
  });

  test("connects normally when the shared project already names it", async () => {
    const arcade = project(HERE);
    await authorize({ verifierUrl: HERE });
    expect(arcade.calls).toEqual([`GET ${SETTINGS}`, "MINT"]);
  });
});

describe("a deployment that does not know its own address", () => {
  test("neither reads nor writes the project's verifier", async () => {
    const arcade = project(ELSEWHERE);
    await authorize({});
    expect(arcade.calls).toEqual(["MINT"]);
  });
});
