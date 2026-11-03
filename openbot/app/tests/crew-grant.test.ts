import { afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  type CrewGrantOutcome,
  crewMembers,
  crewSummary,
  grantToMembers,
} from "@/lib/plugins/crew-grant";
import type { WakerGroup } from "@/lib/waker-groups/queries";

/**
 * The one group-expansion helper every grant screen goes through (spec E2).
 *
 * What it must get right, and what no screen test can see on its own: a group becomes exactly
 * members x refs writes and never a write naming the group, a refusal stops nothing, one member's
 * writes never overlap each other while different members' do, and the plugin reads are refetched
 * once — after the last write, not between them.
 */

const originalFetch = globalThis.fetch;

type Write = { kind: string; ref: string; agentId: string };
let writes: Write[] = [];
let paths = new Set<string>();
let inFlight = new Map<string, number>();
let maxPerAgent = 0;
let maxOverall = 0;
let refuse: (write: Write) => string | null = () => null;

beforeEach(() => {
  writes = [];
  paths = new Set();
  inFlight = new Map();
  maxPerAgent = 0;
  maxOverall = 0;
  refuse = () => null;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "null")) as Write;
      writes.push(body);
      inFlight.set(body.agentId, (inFlight.get(body.agentId) ?? 0) + 1);
      maxPerAgent = Math.max(maxPerAgent, inFlight.get(body.agentId) ?? 0);
      maxOverall = Math.max(
        maxOverall,
        [...inFlight.values()].reduce((sum, count) => sum + count, 0),
      );
      // Long enough that writes which could overlap do.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight.set(body.agentId, (inFlight.get(body.agentId) ?? 1) - 1);
      paths.add(String(input));
      const reason = refuse(body);
      return reason === null
        ? Response.json({ ok: true })
        : Response.json({ error: reason }, { status: 403 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const crew: WakerGroup = {
  id: "crew-1",
  name: "编程小组",
  description: null,
  members: [
    { agentId: "agent-review", position: 1 },
    { agentId: "agent-dev", position: 0 },
    { agentId: "agent-outsider", position: 2 },
    { agentId: "agent-dev", position: 3 },
  ],
};

/** A client whose single refetch is counted, and which records how many writes preceded it. */
function countingClient() {
  const queryClient = new QueryClient();
  const refetches: number[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((...args: unknown[]) => {
    refetches.push(writes.length);
    return (original as (...rest: unknown[]) => Promise<void>)(...args);
  }) as typeof queryClient.invalidateQueries;
  return { queryClient, refetches };
}

test("a crew expands to its eligible members, in the order the person arranged them, once each", () => {
  expect(crewMembers(crew, () => true)).toEqual([
    "agent-dev",
    "agent-review",
    "agent-outsider",
  ]);
  expect(crewMembers(crew, (agentId) => agentId !== "agent-outsider")).toEqual([
    "agent-dev",
    "agent-review",
  ]);
  expect(crewMembers(crew, () => false)).toEqual([]);
});

test("members x refs writes, one per grant, none naming the group, and one refetch after the last", async () => {
  const { queryClient, refetches } = countingClient();
  const outcome = await grantToMembers({
    queryClient,
    kind: "mcp",
    refs: ["github/list_issues", "github/get_issue"],
    agentIds: ["agent-dev", "agent-review"],
  });

  expect(writes).toHaveLength(4);
  expect([...paths]).toEqual(["/api/plugins/grants"]);
  expect(writes.map((write) => `${write.agentId} ${write.ref}`).sort()).toEqual(
    [
      "agent-dev github/get_issue",
      "agent-dev github/list_issues",
      "agent-review github/get_issue",
      "agent-review github/list_issues",
    ],
  );
  expect(writes.every((write) => write.kind === "mcp")).toBe(true);
  expect(writes.some((write) => write.agentId === crew.id)).toBe(false);
  // Exactly one refetch, and only once every write had been sent.
  expect(refetches).toEqual([4]);
  expect(outcome.writes).toBe(4);
  expect(outcome.members.every((member) => member.refused.length === 0)).toBe(
    true,
  );
});

test("members run side by side, but one member's writes never overlap", async () => {
  const { queryClient } = countingClient();
  await grantToMembers({
    queryClient,
    kind: "mcp",
    refs: ["a/one", "a/two", "a/three"],
    agentIds: ["agent-dev", "agent-review", "agent-ops"],
  });
  expect(writes).toHaveLength(9);
  expect(maxPerAgent).toBe(1);
  expect(maxOverall).toBeGreaterThan(1);
  // Within one member the refs land in the order asked for.
  expect(
    writes
      .filter((write) => write.agentId === "agent-review")
      .map((write) => write.ref),
  ).toEqual(["a/one", "a/two", "a/three"]);
});

test("a refusal stops nothing, and every refusal is kept with the server's own reason", async () => {
  refuse = (write) =>
    write.agentId === "agent-review" && write.ref === "a/one"
      ? "这位员工已停用。"
      : null;
  const { queryClient, refetches } = countingClient();
  const progress: number[] = [];
  const outcome = await grantToMembers({
    queryClient,
    kind: "skill",
    refs: ["a/one", "a/two"],
    agentIds: ["agent-dev", "agent-review"],
    onProgress: (settled) => progress.push(settled),
  });

  // The refused write did not stop agent-review's next one, nor agent-dev's.
  expect(writes).toHaveLength(4);
  expect(progress.sort()).toEqual([1, 2, 3, 4]);
  // Refused writes still refetch: the ones that landed must be drawn.
  expect(refetches).toEqual([4]);
  expect(outcome.members).toEqual([
    { agentId: "agent-dev", granted: ["a/one", "a/two"], refused: [] },
    {
      agentId: "agent-review",
      granted: ["a/two"],
      refused: [{ ref: "a/one", reason: "这位员工已停用。" }],
    },
  ]);
});

test("the summary counts members, and quotes the first refusal", () => {
  const allLanded: CrewGrantOutcome = {
    writes: 2,
    members: [
      { agentId: "a", granted: ["x"], refused: [] },
      { agentId: "b", granted: ["x"], refused: [] },
    ],
  };
  expect(
    crewSummary(allLanded, { label: "编程小组", what: "/weekly" }),
  ).toEqual({
    text: "编程小组：全部 2 位员工都已拿到 /weekly。",
    failed: false,
  });

  const partly: CrewGrantOutcome = {
    writes: 6,
    members: [
      { agentId: "a", granted: ["x", "y"], refused: [] },
      // One of two landing is not "has it": the member is counted as refused.
      { agentId: "b", granted: ["x"], refused: [{ ref: "y", reason: "不行" }] },
      { agentId: "c", granted: [], refused: [{ ref: "x", reason: "也不行" }] },
    ],
  };
  expect(crewSummary(partly, { what: "2 个工具" })).toEqual({
    text: "3 位里有 1 位拿到 2 个工具，2 位被拒绝（不行）。",
    failed: true,
  });
});
