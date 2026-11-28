import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { audienceOf, guardSubpage, shows } from "@/lib/settings/audience";

const settled = { user: true, capabilities: true };

test("读不到版本按团队版，管理员看得到团队节", () => {
  const a = audienceOf({ role: "admin" }, undefined, settled);
  expect(a).toEqual({
    edition: "team",
    isAdmin: true,
    maySetUp: true,
    ready: true,
  });
  expect(shows({ who: "team-admin", edition: "team" }, a)).toBe(true);
});

test("ready 之前受众受限的节不画，所有人的节照画", () => {
  const a = audienceOf(
    { role: "admin" },
    { edition: "team" },
    { user: true, capabilities: false },
  );
  expect(a.ready).toBe(false);
  expect(shows({ who: "team-admin", edition: "team" }, a)).toBe(false);
  expect(shows({ who: "everyone", edition: "personal" }, a)).toBe(false);
  expect(shows({ who: "everyone", edition: "both" }, a)).toBe(true);
});

test("用户还没读完时同样不画管理员节", () => {
  const a = audienceOf(
    undefined,
    { edition: "team" },
    { user: false, capabilities: true },
  );
  expect(a.ready).toBe(false);
  expect(shows({ who: "team-admin", edition: "team" }, a)).toBe(false);
});

test("个人版没有团队节；团队版成员没有管理员节也没有个人版节", () => {
  const personal = audienceOf(
    { role: "admin" },
    { edition: "personal" },
    settled,
  );
  expect(shows({ who: "team-admin", edition: "team" }, personal)).toBe(false);
  expect(shows({ who: "team-admin", edition: "both" }, personal)).toBe(false);
  expect(shows({ who: "everyone", edition: "personal" }, personal)).toBe(true);
  const member = audienceOf(
    { role: "user" },
    { edition: "team", localEvaluation: true },
    settled,
  );
  expect(member.maySetUp).toBe(true);
  expect(shows({ who: "team-admin", edition: "team" }, member)).toBe(false);
  expect(shows({ who: "everyone", edition: "personal" }, member)).toBe(false);
});

test("管理员被降级后重新读取，团队节随之消失", () => {
  const before = audienceOf({ role: "admin" }, { edition: "team" }, settled);
  const after = audienceOf({ role: "user" }, { edition: "team" }, settled);
  expect(shows({ who: "team-admin", edition: "team" }, before)).toBe(true);
  expect(shows({ who: "team-admin", edition: "team" }, after)).toBe(false);
});

test("版本读取失败按团队版：个人版节消失，管理员节仍按角色", () => {
  const admin = audienceOf({ role: "admin" }, undefined, settled);
  const member = audienceOf({ role: "user" }, undefined, settled);
  expect(shows({ who: "everyone", edition: "personal" }, admin)).toBe(false);
  expect(shows({ who: "team-admin", edition: "team" }, member)).toBe(false);
  expect(member.maySetUp).toBe(false);
});

describe("guardSubpage", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function seed(role: string | null, edition: "team" | "personal" | "fail") {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      currentUserQueryOptions().queryKey,
      role === null ? null : ({ role } as never),
    );
    if (edition === "fail") {
      globalThis.fetch = (() => Promise.reject(new Error("boom"))) as never;
    } else {
      queryClient.setQueryData(deploymentCapabilitiesQueryOptions().queryKey, {
        edition,
        localEvaluation: false,
      } as never);
    }
    return queryClient;
  }

  async function run(
    rule: "team-admin" | "personal" | "team-admin-or-personal",
    queryClient: QueryClient,
  ): Promise<string | null> {
    try {
      await guardSubpage(rule, "/topic")({ context: { queryClient } });
      return null;
    } catch (e) {
      return (e as { options?: { to?: string } }).options?.to ?? "unknown";
    }
  }

  test("团队版成员打开团队管理员子页，送回给定的 fallback", async () => {
    expect(await run("team-admin", seed("user", "team"))).toBe("/topic");
  });
  test("团队版管理员通过", async () => {
    expect(await run("team-admin", seed("admin", "team"))).toBeNull();
  });
  test("个人版打开团队管理员子页，送回 /settings", async () => {
    expect(await run("team-admin", seed("admin", "personal"))).toBe(
      "/settings",
    );
  });
  test("读不到版本按团队版", async () => {
    expect(await run("team-admin", seed("user", "fail"))).toBe("/topic");
    expect(await run("personal", seed("admin", "fail"))).toBe("/topic");
  });
  test("personal 规则：团队版送回 fallback，个人版通过", async () => {
    expect(await run("personal", seed("admin", "team"))).toBe("/topic");
    expect(await run("personal", seed("user", "personal"))).toBeNull();
  });
  test("team-admin-or-personal：个人版人人通过，团队版只有管理员", async () => {
    expect(
      await run("team-admin-or-personal", seed("user", "personal")),
    ).toBeNull();
    expect(
      await run("team-admin-or-personal", seed("admin", "team")),
    ).toBeNull();
    expect(await run("team-admin-or-personal", seed("user", "team"))).toBe(
      "/topic",
    );
  });
});
