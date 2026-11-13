import { afterEach, expect, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import {
  createGroupWithChatMutationOptions,
  crewForChannelMutationOptions,
  renameCrewMutationOptions,
  retireCrewMutationOptions,
  setCrewMembersMutationOptions,
  startCrewChatMutationOptions,
} from "@/lib/waker-groups/mutations";
import {
  CREW_STATUS_WORDS,
  CrewRequestError,
  crewStatus,
  type MemberStep,
  OWNER_GONE,
  type WakerGroup,
} from "@/lib/waker-groups/queries";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const members = (count: number) =>
  Array.from({ length: count }, (_, position) => ({
    agentId: `a${position}`,
    position,
  }));

const group: WakerGroup = {
  id: "g-1",
  name: "编程群组",
  description: null,
  members: members(2),
  channelId: "c-1",
};

type Call = { method: string; url: string; body: unknown };

/** Records what each write sent, answers every request with one canned response. */
function serve(status: number, body: unknown) {
  const calls: Call[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json(body, { status });
  }) as typeof fetch;
  return calls;
}

// biome-ignore lint/suspicious/noExplicitAny: one runner for every mutation's own input and result type
type Loose = any;
const run = (options: Loose, queryClient: QueryClient, variables: unknown) =>
  new MutationObserver<Loose, Error, Loose>(queryClient, options).mutate(
    variables,
  );

test("crewStatus reads the five shapes a group can be in", () => {
  expect(crewStatus({ members: members(2), channelId: "c" })).toBe("chat");
  expect(crewStatus({ members: [], channelId: null })).toBe("pending_members");
  expect(crewStatus({ members: members(1), channelId: null })).toBe(
    "pending_members",
  );
  expect(crewStatus({ members: members(21), channelId: null })).toBe(
    "too_many",
  );
  expect(crewStatus({ members: members(2) })).toBe("not_started");
});

test("crewStatus trusts the server's chatStatus", () => {
  expect(
    crewStatus({
      members: members(3),
      channelId: null,
      chatStatus: "pending_members",
    }),
  ).toBe("pending_members");
});

test("the status words are the ones the screens show", () => {
  expect(CREW_STATUS_WORDS).toEqual({
    pending_members: "待补成员",
    too_many: "待调整成员（超过 20 位）",
    not_started: "未开始聊天",
  });
});

test("the four new writes send exactly what the server expects", async () => {
  const queryClient = new QueryClient();

  let calls = serve(201, { group, channel: { id: "c-1" } });
  await run(createGroupWithChatMutationOptions(queryClient), queryClient, {
    name: "编程群组",
    description: "写代码",
    agentIds: ["a0", "a1"],
  });
  expect(calls[0]).toEqual({
    method: "POST",
    url: "/api/waker-groups",
    body: { name: "编程群组", description: "写代码", agentIds: ["a0", "a1"] },
  });

  calls = serve(200, { group });
  await run(renameCrewMutationOptions(queryClient), queryClient, {
    groupId: "g-1",
    name: "新名字",
    description: "新用途",
  });
  expect(calls[0]).toEqual({
    method: "PATCH",
    url: "/api/waker-groups/g-1",
    body: { name: "新名字", description: "新用途" },
  });

  calls = serve(201, { group, channel: { id: "c-1" } });
  await run(startCrewChatMutationOptions(queryClient), queryClient, "g-1");
  expect(calls[0]).toEqual({
    method: "POST",
    url: "/api/waker-groups/g-1/chat",
    body: null,
  });

  calls = serve(200, { group });
  await run(crewForChannelMutationOptions(queryClient), queryClient, "c-1");
  expect(calls[0]).toEqual({
    method: "POST",
    url: "/api/waker-groups/for-channel/c-1",
    body: null,
  });
});

test("a group write reads the groups and the channels again", async () => {
  const queryClient = new QueryClient();
  const invalidated: unknown[] = [];
  queryClient.invalidateQueries = (async (filters?: { queryKey?: unknown }) => {
    invalidated.push(filters?.queryKey);
  }) as typeof queryClient.invalidateQueries;
  serve(200, { ok: true });
  await run(retireCrewMutationOptions(queryClient), queryClient, "g-1");
  expect(invalidated).toContainEqual(["waker-groups"]);
  expect(invalidated).toContainEqual(["channels"]);
});

test("setCrewMembers returns chatError with the group", async () => {
  const queryClient = new QueryClient();
  const calls = serve(200, {
    group,
    chatError: "成员已保存，但群聊没能开始，请稍后点「开始聊天」再试。",
  });
  const result = await run(
    setCrewMembersMutationOptions(queryClient),
    queryClient,
    { groupId: "g-1", agentIds: ["a0", "a1"] },
  );
  expect(calls[0]).toEqual({
    method: "PUT",
    url: "/api/waker-groups/g-1/members",
    body: { agentIds: ["a0", "a1"] },
  });
  expect(result.group).toEqual(group);
  expect(result.chatError).toBe(
    "成员已保存，但群聊没能开始，请稍后点「开始聊天」再试。",
  );
});

test("an owner-gone 409 is told by its code", async () => {
  const queryClient = new QueryClient();
  serve(409, {
    error: "这个群组的聊天你已经不在里面了，暂时不能调整。",
    code: OWNER_GONE,
  });
  const error = await run(
    startCrewChatMutationOptions(queryClient),
    queryClient,
    "g-1",
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CrewRequestError);
  expect((error as CrewRequestError).code).toBe(OWNER_GONE);
  expect((error as CrewRequestError).status).toBe(409);
  expect((error as CrewRequestError).message).toBe(
    "这个群组的聊天你已经不在里面了，暂时不能调整。",
  );
});

test("a part-way 409 carries done, and the lists are read again", async () => {
  const queryClient = new QueryClient();
  const invalidated: unknown[] = [];
  queryClient.invalidateQueries = (async (filters?: { queryKey?: unknown }) => {
    invalidated.push(filters?.queryKey);
  }) as typeof queryClient.invalidateQueries;
  const done: MemberStep[] = [{ op: "add", agentIds: ["a"] }];
  serve(409, { error: "群组成员只改了一部分，请刷新后再试。", done });
  const error = await run(
    setCrewMembersMutationOptions(queryClient),
    queryClient,
    { groupId: "g-1", agentIds: ["a", "b"] },
  ).catch((caught: unknown) => caught);
  expect((error as CrewRequestError).done).toEqual(done);
  expect((error as CrewRequestError).code).toBeUndefined();
  expect(invalidated).toContainEqual(["waker-groups"]);
  expect(invalidated).toContainEqual(["channels"]);
});

test("an owner-gone 409 from setCrewMembers also reads the lists again", async () => {
  // The translation had already run, so the roster changed even though the body carries no `done`.
  const queryClient = new QueryClient();
  const invalidated: unknown[] = [];
  queryClient.invalidateQueries = (async (filters?: { queryKey?: unknown }) => {
    invalidated.push(filters?.queryKey);
  }) as typeof queryClient.invalidateQueries;
  serve(409, {
    error: "这个群组的聊天你已经不在里面了，暂时不能调整。",
    code: OWNER_GONE,
  });
  const error = await run(
    setCrewMembersMutationOptions(queryClient),
    queryClient,
    { groupId: "g-1", agentIds: ["a", "b"] },
  ).catch((caught: unknown) => caught);
  expect((error as CrewRequestError).code).toBe(OWNER_GONE);
  expect((error as CrewRequestError).done).toBeUndefined();
  expect(invalidated).toContainEqual(["waker-groups"]);
  expect(invalidated).toContainEqual(["channels"]);
});

test("a plain 409 with no code and no done also reads the lists again", async () => {
  const queryClient = new QueryClient();
  const invalidated: unknown[] = [];
  queryClient.invalidateQueries = (async (filters?: { queryKey?: unknown }) => {
    invalidated.push(filters?.queryKey);
  }) as typeof queryClient.invalidateQueries;
  serve(409, { error: "群组刚被别人改过，请刷新后再试。" });
  const error = await run(
    setCrewMembersMutationOptions(queryClient),
    queryClient,
    { groupId: "g-1", agentIds: ["a", "b"] },
  ).catch((caught: unknown) => caught);
  expect((error as CrewRequestError).status).toBe(409);
  expect((error as CrewRequestError).code).toBeUndefined();
  expect((error as CrewRequestError).done).toBeUndefined();
  expect(invalidated).toContainEqual(["waker-groups"]);
  expect(invalidated).toContainEqual(["channels"]);
});

test("a 403 from PATCH keeps the server's words", async () => {
  const queryClient = new QueryClient();
  serve(403, { error: "只有发起人能调整这个群组。" });
  const error = await run(renameCrewMutationOptions(queryClient), queryClient, {
    groupId: "g-1",
    name: "x",
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CrewRequestError);
  expect((error as CrewRequestError).status).toBe(403);
  expect((error as CrewRequestError).message).toBe(
    "只有发起人能调整这个群组。",
  );
});
