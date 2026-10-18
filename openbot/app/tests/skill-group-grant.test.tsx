import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillAgents } from "@/components/skills/skill-agents";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { type WakerGroup, wakerGroupKeys } from "@/lib/waker-groups/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * Spec E2's other half: a group is a way to say WHICH coworkers hold a skill, on the skill screen too
 * — not only on the connector one.
 *
 * What is worth asserting is what a batch write can get wrong and nothing else catches: whose name
 * counts toward the number on the chip (only Agents this person owns — the server refuses the rest),
 * how many writes one click makes, and what a refusal leaves on screen. A grant that vanished without
 * a sentence is the failure mode here, because the chip's count is the only story the person has.
 */
let registeredHere = false;
beforeAll(() => {
  // One happy-dom global per process: registering twice throws in `beforeAll`, which silently deletes
  // this file's tests from the run — and not unregistering deletes the next file's.
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  // Drain React before the document goes away, for the reason recorded in `settle-react-work.ts`.
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
let writes: { path: string; body: unknown }[] = [];
let refuse = false;

const agent = (id: string, name: string, mine: boolean): AgentProfile =>
  ({ id, name, mine, hidden: false, pinned: false }) as unknown as AgentProfile;

const crew: WakerGroup = {
  id: "crew-1",
  name: "编程小组",
  description: null,
  // One member already holding the skill, one this person can grant to, one belonging to somebody else.
  members: [
    { agentId: "agent-dev", position: 0 },
    { agentId: "agent-review", position: 1 },
    { agentId: "agent-outsider", position: 2 },
  ],
};

function draw() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.list(false), [
    agent("agent-dev", "阿开", true),
    agent("agent-review", "阿审", true),
    agent("agent-outsider", "邻组的", false),
  ]);
  queryClient.setQueryData(wakerGroupKeys.list(), [crew]);
  return render(
    <QueryClientProvider client={queryClient}>
      <SkillAgents grantedTo={["agent-dev"]} slug="weekly-report" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  writes = [];
  refuse = false;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    if ((init?.method ?? "GET") === "POST") {
      writes.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return refuse
        ? Response.json(
            { error: "You do not own that Agent." },
            { status: 400 },
          )
        : Response.json({ ok: true });
    }
    return Response.json({ agents: [], groups: [] });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("the chip counts the members a person may actually grant to", async () => {
  const view = draw();
  // 3 members, 1 already holding it, 1 owned by somebody else: the number is the write it will do.
  const chip = await view.findByRole("button", {
    name: "把 /weekly-report 交给编程小组",
  });
  expect(chip.textContent).toBe("编程小组 · 1");
});

test("one click on the group writes one grant per grantable member", async () => {
  const view = draw();
  await userEvent.click(
    await view.findByRole("button", {
      name: "把 /weekly-report 交给编程小组",
    }),
  );

  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.path).toBe("/api/plugins/grants");
  expect(writes[0]?.body).toEqual({
    kind: "skill",
    ref: "weekly-report",
    agentId: "agent-review",
  });
  expect(
    await view.findByText("编程小组：全部 1 位员工都已拿到 /weekly-report。"),
  ).toBeTruthy();
});

test("a refused grant is said, with the server's own reason", async () => {
  refuse = true;
  const view = draw();
  await userEvent.click(
    await view.findByRole("button", {
      name: "把 /weekly-report 交给编程小组",
    }),
  );

  const line = await view.findByRole("alert");
  expect(line.textContent).toContain("1 位里有 0 位拿到 /weekly-report");
  expect(line.textContent).toContain("You do not own that Agent.");
});
