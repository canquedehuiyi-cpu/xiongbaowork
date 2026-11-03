import { describe, expect, test } from "bun:test";
import {
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { z } from "zod";
import type { ApprovalRecord } from "../src/approvals/types";
import type { GrantedTool } from "../src/plugins/tools";
import {
  createProactiveEngine,
  PROACTIVE_RUN_KIND,
  PROACTIVE_TASK_KIND,
  PROACTIVE_TENANT_UNRESOLVED,
} from "../src/proactive/engine";
import { createPrivateShareCheck } from "../src/proactive/private-share";
import {
  createReadOnlyClassifier,
  guardProactiveCallback,
  proactiveInitiator,
  restrictCoordinationForRun,
  restrictToolsForRun,
} from "../src/proactive/restriction";
import type {
  ProactiveStore,
  StampedProactiveSetting,
  StampedProactiveSuggestion,
} from "../src/proactive/store";
import { createTurnRunner, type RunnerLike } from "../src/routines/run-turn";
import { currentTenant, runAsTenant } from "../src/tenant/context";
import type { WorkItem, WorkQueue } from "../src/work/queue";

const catalogue = (effects: Record<string, "read" | "write">) => ({
  listServers: async () => [
    {
      id: "linear",
      title: "Linear",
      tools: Object.entries(effects).map(([name, effect]) => ({
        ref: `linear/${name}`,
        effect,
        destructive: false,
      })),
    },
  ],
});

function granted(ref: string, calls: string[]): GrantedTool {
  return {
    name: `mcp__${ref.replace("/", "__")}`,
    ref,
    description: ref,
    parameters: z.object({}),
    execute: async () => {
      calls.push(ref);
      return `${ref} ran`;
    },
  };
}

describe("proactive read-only restriction", () => {
  test("a proactive run is offered only reads and a write is never dispatched", async () => {
    const calls: string[] = [];
    const effects: Record<string, "read" | "write"> = {
      list_issues: "read",
      create_issue: "write",
    };
    const load = async () => [
      granted("linear/list_issues", calls),
      granted("linear/create_issue", calls),
    ];
    const restricted = restrictToolsForRun(
      proactiveInitiator("run-1"),
      load,
      createReadOnlyClassifier(catalogue(effects)),
    );
    const tools = await restricted();
    expect(tools.map((tool) => tool.ref)).toEqual(["linear/list_issues"]);
    // A read relabelled as a write mid-run is refused on its next call.
    effects.list_issues = "write";
    expect(await tools[0]?.execute({})).toStartWith("Refused.");
    expect(calls).toEqual([]);
  });

  test("other initiators are untouched and a proactive run gets no coordination", async () => {
    const load = async () => [granted("linear/create_issue", [])];
    const classifier = createReadOnlyClassifier(catalogue({}));
    expect(restrictToolsForRun({ kind: "person" }, load, classifier)).toBe(
      load,
    );
    const coordination = async () => ["message_bot"];
    expect(
      await restrictCoordinationForRun(proactiveInitiator("r"), coordination)(),
    ).toEqual([]);
    expect(
      await restrictCoordinationForRun({ kind: "person" }, coordination)(),
    ).toEqual(["message_bot"]);
  });

  test("the remote callback door refuses writes, host tools and coordination, and fails closed", async () => {
    const classifier = createReadOnlyClassifier(
      catalogue({ list_issues: "read", create_issue: "write" }),
    );
    const run = { initiator: proactiveInitiator("r") };
    for (const name of [
      "linear/create_issue",
      "message_bot",
      "host_write_file",
      "remember_personal_fact",
      "unknown/tool",
    ])
      expect(
        (await guardProactiveCallback({ name, run }, classifier))?.text,
      ).toStartWith("Refused.");
    expect(
      await guardProactiveCallback(
        { name: "linear/list_issues", run },
        classifier,
      ),
    ).toBeNull();
    expect(
      await guardProactiveCallback(
        { name: "recall_personal_memory", run },
        classifier,
      ),
    ).toBeNull();
    expect(
      await guardProactiveCallback(
        { name: "linear/create_issue", initiator: { kind: "person" } },
        classifier,
      ),
    ).toBeNull();
    expect(
      (
        await guardProactiveCallback(
          { name: "linear/list_issues", run },
          async () => {
            throw new Error("catalogue down");
          },
        )
      )?.text,
    ).toStartWith("Refused.");
  });
});

function lifecycle(input: RunAgentInput, body: BaseEvent[]): BaseEvent[] {
  return [
    {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    },
    ...body,
    {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    },
  ] as BaseEvent[];
}
function toolCall(name: string, args: unknown, id: string): BaseEvent[] {
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: id,
      toolCallName: name,
      parentMessageId: `m-${id}`,
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: id,
      delta: JSON.stringify(args),
    },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
  ] as BaseEvent[];
}
function reply(text: string): BaseEvent[] {
  return [
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "reply",
      role: "assistant",
    },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "reply", delta: text },
    { type: EventType.TEXT_MESSAGE_END, messageId: "reply" },
  ] as BaseEvent[];
}

describe("proactive run", () => {
  test("a model asking for a write tool is refused, while its suggestion is recorded and delivered", async () => {
    const requests: RunAgentInput[] = [];
    const agent = new HttpAgent({
      agentId: "bot",
      url: "https://agent.example/ag-ui",
      fetch: async (_url, init) => {
        const input = JSON.parse(String(init?.body)) as RunAgentInput;
        requests.push(input);
        const events =
          requests.length === 1
            ? lifecycle(input, [
                ...toolCall(
                  "mcp__linear__create_issue",
                  { title: "x" },
                  "write-call",
                ),
                ...toolCall(
                  "suggest_next_step",
                  { title: "Reply to Sam", detail: "Sam asked for the spec." },
                  "suggest-call",
                ),
              ])
            : lifecycle(input, reply("Summary."));
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const runner: RunnerLike = {
      run: ({ agent: selected, input }) =>
        new Observable((subscriber) => {
          selected
            .runAgent(input, { onEvent: ({ event }) => subscriber.next(event) })
            .then(
              () => subscriber.complete(),
              (error) => subscriber.error(error),
            );
        }),
      stop: async () => true,
    };
    // Stamped with its person's tenant, the way a setting a person created is (G01).
    const setting: StampedProactiveSetting = {
      tenantId: "owner",
      id: "setting",
      ownerUserId: "owner",
      agentId: "bot",
      channelId: "channel",
      threadId: "proactive-thread",
      focus: "",
      enabled: true,
      intervalMinutes: 240,
      nextRunAt: new Date(),
      lastRunAt: null,
      lastStatus: "idle",
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const suggestions: Record<string, unknown>[] = [];
    const statuses: string[] = [];
    const store = {
      claimDue: async () => [setting],
      byId: async () => setting,
      recordRun: async (_id: string, status: string) => {
        statuses.push(status);
      },
      readsFor: async () => [],
      countSuggestions: async () => suggestions.length,
      addSuggestion: async (input: Record<string, unknown>) => {
        const row = {
          ...input,
          id: `s${suggestions.length}`,
          deliveredAt: null,
        };
        suggestions.push(row);
        return row;
      },
      undelivered: async () => suggestions.filter((row) => !row.deliveredAt),
      markDelivered: async (id: string) => {
        const row = suggestions.find((entry) => entry.id === id);
        if (row) row.deliveredAt = new Date();
      },
    } as unknown as ProactiveStore;
    const offered: {
      kind: string;
      key: string;
      tenantId?: string;
      payload?: Record<string, unknown>;
    }[] = [];
    const queue = {
      // Stamped with the frame it was offered from, as the database does.
      offer: async (item: (typeof offered)[number]) => {
        offered.push({ ...item, tenantId: currentTenant() });
        return "queued";
      },
      claim: async ({ kind }: { kind: string }) => {
        const index = offered.findIndex((item) => item.kind === kind);
        if (index < 0) return [];
        const [item] = offered.splice(index, 1);
        return item
          ? [{ ...item, payload: item.payload ?? {}, attempts: 1 }]
          : [];
      },
      renew: async () => true,
      finish: async () => true,
      release: async () => true,
      purge: async () => 0,
    } as unknown as WorkQueue;
    const writes: string[] = [];
    const notified: string[] = [];
    const initiators: unknown[] = [];
    const engine = createProactiveEngine({
      store,
      memory: {
        formMemory: async () => ({
          id: "m",
          duplicate: false,
          forgotten: false,
        }),
      },
      queue,
      owner: "worker",
      runTurn: createTurnRunner({
        intelligence: {
          getOrCreateThread: async () => undefined,
          getThreadMessages: async () => ({ messages: [] }),
          ɵacquireThreadLock: async () => undefined,
          ɵrenewThreadLock: async () => undefined,
          ɵcleanupThreadLock: async () => undefined,
        },
        runner,
        buildAgentFor: async ({ initiator }) => {
          initiators.push(initiator);
          return agent;
        },
        toolsForTurn: (input) => engine.toolsForTurn(input),
      }),
      resolveScope: async (ownerUserId, channelId, agentId) => ({
        ownerUserId,
        channelId,
        agentId,
        threadId: "channel-thread",
      }),
      notify: async (_scope, input) => {
        notified.push(input.text);
      },
      startTask: async () => {
        writes.push("task");
      },
      catalogue: { listServers: async () => [] },
      // The real write tool is never in this turn; a call to it gets the hidden refusal.
      deniedToolNames: async () => ["mcp__linear__create_issue"],
      mintThreadId: () => "thread",
    });

    await engine.sweep();

    expect(initiators).toEqual([
      { kind: "routine", id: expect.stringMatching(/^proactive:/) },
    ]);
    expect(writes).toEqual([]);
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "suggest_next_step",
      "form_memory",
    ]);
    const answer = requests[1]?.messages.find(
      (message) =>
        message.role === "tool" && message.toolCallId === "write-call",
    );
    expect(String(answer?.content)).toStartWith("Refused.");
    expect(suggestions).toHaveLength(1);
    expect(notified[0]).toContain("Reply to Sam");
    expect(statuses).toEqual(["running", "succeeded"]);
  });

  test("a memory is formed only from a read the run actually made", async () => {
    const setting = {
      tenantId: "owner",
      id: "s",
      ownerUserId: "owner",
      agentId: "bot",
    } as StampedProactiveSetting;
    const formed: unknown[] = [];
    const results: string[] = [];
    // Drive one run through the queue path.
    let given = false;
    const queue = {
      offer: async () => "queued",
      claim: async ({ kind }: { kind: string }) => {
        if (given || kind !== "proactive.run") return [];
        given = true;
        return [
          {
            kind,
            key: "k",
            tenantId: "owner",
            payload: { settingId: "s", runId: "run" },
            attempts: 1,
          },
        ];
      },
      renew: async () => true,
      finish: async () => true,
      release: async () => true,
    };
    const engineWithQueue = createProactiveEngine({
      store: {
        claimDue: async () => [],
        byId: async () => ({ ...setting, enabled: true }),
        recordRun: async () => undefined,
        readsFor: async () => [{ ref: "linear/list_issues", at: new Date(0) }],
        undelivered: async () => [],
      } as unknown as ProactiveStore,
      memory: {
        formMemory: async (_owner, input) => {
          formed.push(input);
          return { id: "m", duplicate: false, forgotten: false };
        },
      },
      queue: queue as unknown as WorkQueue,
      owner: "worker",
      runTurn: async () => {
        const tools = await engineWithQueue.toolsForTurn({
          ownerUserId: "owner",
          agentId: "bot",
          initiator: proactiveInitiator("run"),
        });
        const form = tools.find(
          (tool) => tool.definition.name === "form_memory",
        );
        const signal = new AbortController().signal;
        results.push(
          String(
            await form?.execute(
              {
                content: "Owns billing",
                sourceTool: "mcp__linear__create_issue",
              },
              { toolCallId: "a", signal },
            ),
          ),
          String(
            await form?.execute(
              {
                content: "Owns billing",
                sourceTool: "mcp__linear__list_issues",
              },
              { toolCallId: "b", signal },
            ),
          ),
        );
        return { replyText: "done" };
      },
      resolveScope: async () => ({
        ownerUserId: "owner",
        channelId: "c",
        agentId: "bot",
        threadId: "t",
      }),
      notify: async () => undefined,
      startTask: async () => undefined,
      catalogue: {
        listServers: async () => [
          {
            id: "linear",
            title: "Linear",
            tools: [{ ref: "linear/list_issues" }],
          },
        ],
      },
      mintThreadId: () => "t",
    });
    await engineWithQueue.sweep();
    expect(results[0]).toStartWith("Refused.");
    expect(formed).toEqual([
      {
        agentId: "bot",
        content: "Owns billing",
        sourceApp: "Linear",
        sourceRef: "linear/list_issues",
        observedAt: new Date(0),
      },
    ]);
    // Another person's or another Bot's turn gets none of the run's tools.
    expect(
      await engineWithQueue.toolsForTurn({
        ownerUserId: "someone-else",
        agentId: "bot",
        initiator: proactiveInitiator("run"),
      }),
    ).toEqual([]);
  });
});

/**
 * G01: a sweep has no tenant of its own, so it runs each piece of research as the tenant stamped on
 * the setting it is for, and each queued run or task as the tenant stamped on its queue row.
 *
 * The fakes below answer the way the database does: a row is stamped with the frame it was written
 * from, and a read sees its own tenant and `system`, or everything from `platform`.
 */
describe("G01: whose research a sweep is doing", () => {
  const visible = (tenantId: string) => {
    const frame = currentTenant();
    return frame === "platform" || tenantId === frame || tenantId === "system";
  };
  const stamp = (
    tenantId: string,
    ownerUserId: string,
    id: string,
  ): StampedProactiveSetting => ({
    tenantId,
    id,
    ownerUserId,
    agentId: `bot-${id}`,
    channelId: `channel-${id}`,
    threadId: `thread-${id}`,
    focus: "",
    enabled: true,
    intervalMinutes: 240,
    nextRunAt: new Date(0),
    lastRunAt: null,
    lastStatus: "idle",
    lastError: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  type Queued = WorkItem & { released?: string; finished?: boolean };

  function harness(input: {
    settings: StampedProactiveSetting[];
    due?: StampedProactiveSetting[];
    suggestions?: StampedProactiveSuggestion[];
    queued?: Queued[];
  }) {
    const settings = input.settings;
    const suggestions = [...(input.suggestions ?? [])];
    const queued: Queued[] = [...(input.queued ?? [])];
    const seen = {
      claimDueAs: [] as string[],
      runs: [] as { id: string; status: string; as: string }[],
      turns: [] as { owner: string; as: string }[],
      notified: [] as string[],
      tasks: [] as { owner: string; as: string }[],
    };
    const find = (id: string) =>
      settings.find((row) => row.id === id && visible(row.tenantId)) ?? null;
    const store = {
      claimDue: async () => {
        seen.claimDueAs.push(currentTenant());
        return (input.due ?? settings).filter((row) => visible(row.tenantId));
      },
      byId: async (id: string) => find(id),
      get: async (owner: string, id: string) => {
        const row = find(id);
        if (!row || row.ownerUserId !== owner) throw new Error("not found");
        return row;
      },
      recordRun: async (id: string, status: string) => {
        seen.runs.push({ id, status, as: currentTenant() });
      },
      readsFor: async () => [],
      countSuggestions: async (runId: string) =>
        suggestions.filter((row) => row.runId === runId).length,
      addSuggestion: async (
        row: Omit<StampedProactiveSuggestion, "tenantId" | "id">,
      ) => {
        const added = {
          ...row,
          id: `suggestion-${suggestions.length}`,
          tenantId: currentTenant(),
          status: "open",
          deliveredAt: null,
          resolvedAt: null,
          createdAt: new Date(0),
        } as StampedProactiveSuggestion;
        suggestions.push(added);
        return added;
      },
      undelivered: async (runId: string) =>
        suggestions.filter(
          (row) =>
            row.runId === runId && !row.deliveredAt && visible(row.tenantId),
        ),
      markDelivered: async (id: string) => {
        const row = suggestions.find((entry) => entry.id === id);
        if (row) row.deliveredAt = new Date();
      },
      suggestion: async (owner: string, id: string) => {
        const row = suggestions.find(
          (entry) =>
            entry.id === id &&
            entry.ownerUserId === owner &&
            visible(entry.tenantId),
        );
        if (!row) throw new Error("not found");
        return row;
      },
    } as unknown as ProactiveStore;
    const queue = {
      offer: async (item: Omit<Queued, "tenantId" | "attempts">) => {
        queued.push({
          ...item,
          payload: item.payload ?? {},
          tenantId: currentTenant(),
          attempts: 0,
        });
        return "queued";
      },
      claim: async ({ kind }: { kind: string }) => {
        const item = queued.find(
          (entry) => entry.kind === kind && !entry.finished && !entry.released,
        );
        if (!item) return [];
        item.attempts += 1;
        return [item];
      },
      renew: async () => true,
      finish: async ({ key }: { key: string }) => {
        const item = queued.find((entry) => entry.key === key);
        if (item) item.finished = true;
        return true;
      },
      release: async ({ key, reason }: { key: string; reason?: string }) => {
        const item = queued.find((entry) => entry.key === key);
        if (item) item.released = reason ?? "released";
        return true;
      },
      purge: async () => 0,
    } as unknown as WorkQueue;
    const engine = createProactiveEngine({
      store,
      memory: {
        formMemory: async () => ({
          id: "m",
          duplicate: false,
          forgotten: false,
        }),
      },
      queue,
      owner: "worker",
      runTurn: async (turn) => {
        seen.turns.push({ owner: turn.ownerUserId, as: currentTenant() });
        const tools = await engine.toolsForTurn({
          ownerUserId: turn.ownerUserId,
          agentId: turn.agentId,
          initiator: turn.initiator ?? { kind: "person" },
        });
        await tools
          .find((tool) => tool.definition.name === "suggest_next_step")
          ?.execute(
            { title: "Reply to Sam", detail: "Sam asked for the spec." },
            { toolCallId: "call", signal: new AbortController().signal },
          );
        return { replyText: "Summary." };
      },
      resolveScope: async (ownerUserId, channelId, agentId) => ({
        ownerUserId,
        channelId,
        agentId,
        threadId: "channel-thread",
      }),
      notify: async () => {
        seen.notified.push(currentTenant());
      },
      startTask: async (scope) => {
        seen.tasks.push({ owner: scope.ownerUserId, as: currentTenant() });
      },
      catalogue: { listServers: async () => [] },
      mintThreadId: () => "thread",
    });
    return { engine, store, queued, suggestions, seen };
  }

  test("a due setting is offered and researched as its own tenant, and nobody else's is run", async () => {
    const alice = stamp("alice", "alice", "a");
    const { engine, store, queued, suggestions, seen } = harness({
      settings: [
        alice,
        // Stamped as nobody's: there is no person to read apps for.
        stamp("system", "alice", "sys"),
        stamp("platform", "bob", "plat"),
        // Filed under one person but naming another.
        stamp("alice", "bob", "foreign"),
      ],
    });

    // From no frame at all, the way the server's timer calls it.
    await engine.sweep();

    // "What is due" is asked as the platform, never as `system`.
    expect(seen.claimDueAs).toEqual(["platform"]);
    // Only the person's own setting reaches the queue, stamped as theirs.
    expect(
      queued.map((item) => [item.key.split(":")[0], item.tenantId]),
    ).toEqual([["a", "alice"]]);
    // The turn, the suggestion it made and the notification all ran as that person.
    expect(seen.turns).toEqual([{ owner: "alice", as: "alice" }]);
    expect(suggestions.map((row) => row.tenantId)).toEqual(["alice"]);
    expect(seen.notified).toEqual(["alice"]);
    expect(
      seen.runs.filter((row) => row.id === "a").map((row) => row.as),
    ).toEqual(["alice", "alice"]);
    // The others are said to have failed, from the platform's frame, and never run.
    for (const id of ["sys", "plat", "foreign"])
      expect(seen.runs.filter((row) => row.id === id)).toEqual([
        { id, status: "error", as: "platform" },
      ]);
    // And somebody else reads none of it.
    expect(await runAsTenant("bob", () => store.byId("a"))).toBeNull();
    await expect(
      runAsTenant("bob", () =>
        store.suggestion("alice", suggestions[0]?.id ?? ""),
      ),
    ).rejects.toThrow();
  });

  test("a queued run stamped as nobody's, or as somebody else, is ended without running anybody", async () => {
    const alice = stamp("alice", "alice", "a");
    const run = (key: string, tenantId: string, settingId: string) => ({
      kind: PROACTIVE_RUN_KIND,
      key,
      tenantId,
      payload: { settingId, runId: `run-${key}` },
      attempts: 0,
    });
    const { engine, queued, seen } = harness({
      settings: [alice, stamp("system", "alice", "sys")],
      due: [],
      queued: [
        run("as-system", "system", "a"),
        run("as-platform", "platform", "a"),
        // Bob's row asking for Alice's research: her setting is not even visible from his frame.
        run("as-bob", "bob", "a"),
        // Alice's row asking for a setting stamped as nobody's, which her frame can still see.
        run("as-alice-for-system", "alice", "sys"),
      ],
    });

    for (let pass = 0; pass < 4; pass += 1) await engine.sweep();

    expect(seen.turns).toEqual([]);
    expect(seen.runs).toEqual([]);
    const outcome = Object.fromEntries(
      queued.map((item) => [item.key, item.released ?? "finished"]),
    );
    expect(outcome).toEqual({
      "as-system": PROACTIVE_TENANT_UNRESOLVED,
      "as-platform": PROACTIVE_TENANT_UNRESOLVED,
      "as-bob": "finished",
      "as-alice-for-system": PROACTIVE_TENANT_UNRESOLVED,
    });
  });

  test("a started suggestion runs as its person, and a task for somebody else's is refused", async () => {
    const alice = stamp("alice", "alice", "a");
    const suggestion = {
      tenantId: "alice",
      id: "s1",
      ownerUserId: "alice",
      agentId: alice.agentId,
      settingId: alice.id,
      runId: "run",
      title: "Reply to Sam",
      detail: "Sam asked for the spec.",
      sourceApp: null,
      sourceRef: null,
      sourceLink: null,
      status: "started",
      deliveredAt: null,
      resolvedAt: null,
      createdAt: new Date(0),
    } as StampedProactiveSuggestion;
    const task = (key: string, tenantId: string) => ({
      kind: PROACTIVE_TASK_KIND,
      key,
      tenantId,
      payload: { ownerUserId: "alice", suggestionId: "s1" },
      attempts: 0,
    });
    const { engine, queued, seen } = harness({
      settings: [alice],
      due: [],
      suggestions: [suggestion],
      queued: [
        // Bob's row naming Alice in its payload: the payload cannot stand in for the row.
        task("as-bob", "bob"),
        task("as-system", "system"),
        task("as-alice", "alice"),
      ],
    });

    for (let pass = 0; pass < 3; pass += 1) await engine.sweep();

    expect(seen.tasks).toEqual([{ owner: "alice", as: "alice" }]);
    expect(
      Object.fromEntries(
        queued.map((item) => [item.key, item.released ?? "finished"]),
      ),
    ).toEqual({
      "as-bob": PROACTIVE_TENANT_UNRESOLVED,
      "as-system": PROACTIVE_TENANT_UNRESOLVED,
      "as-alice": "finished",
    });
  });
});

describe("private information sharing check", () => {
  const continuation = {
    runId: "run",
    threadId: "thread",
    toolCallId: "call",
    toolName: "post_message",
    args: {},
    messages: [],
    state: {},
    context: [],
    forwardedProps: {},
  };
  const audience = {
    kind: "slack_channel" as const,
    id: "C1",
    label: "#design",
    recipientUserIds: ["owner", "priya"],
  };
  function approvals(status: ApprovalRecord["status"], rules: unknown[] = []) {
    const opened: unknown[] = [];
    return {
      opened,
      store: {
        rules: async () => rules as never,
        list: async () => [],
        open: async (action: never) => {
          opened.push(action);
          return { id: "approval-1", status } as ApprovalRecord;
        },
      },
    };
  }
  const input = {
    ownerUserId: "owner",
    botId: "bot",
    audience,
    content: "Owner's salary is ...",
    origin: { kind: "memory" as const },
    continuation,
  };

  test("sharing with others asks the owner and waits; nothing is allowed by default", async () => {
    const { store, opened } = approvals("pending");
    const verdict = await createPrivateShareCheck({ approvals: store })(input);
    expect(verdict.status).toBe("pending");
    expect(opened).toHaveLength(1);
    if (verdict.status === "pending")
      expect(verdict.suspension.waiting).toMatchObject({
        kind: "approval",
        approvalId: "approval-1",
      });
  });

  test("denied stays denied, and a send outside a run cannot ask so it is refused", async () => {
    expect(
      (
        await createPrivateShareCheck({ approvals: approvals("denied").store })(
          input,
        )
      ).status,
    ).toBe("denied");
    expect(
      (
        await createPrivateShareCheck({
          approvals: approvals("approved").store,
        })({
          ...input,
          continuation: undefined,
        })
      ).status,
    ).toBe("denied");
  });

  test("owner-only, already-shared and always-allowed audiences pass without a new request", async () => {
    const { store, opened } = approvals("pending", [
      {
        botId: "bot",
        toolRef: "openbot/share_private_information",
        effect: "share_private",
        scope: "slack_channel:C1",
        revokedAt: null,
      },
    ]);
    const check = createPrivateShareCheck({ approvals: store });
    expect(
      (
        await check({
          ...input,
          audience: { ...audience, recipientUserIds: ["owner"] },
        })
      ).status,
    ).toBe("allowed");
    expect(
      (
        await createPrivateShareCheck({
          approvals: approvals("pending").store,
        })({
          ...input,
          origin: { kind: "shared_conversation", sharedWithUserIds: ["priya"] },
        })
      ).status,
    ).toBe("allowed");
    expect((await check(input)).status).toBe("allowed");
    expect(opened).toHaveLength(0);
  });
});
