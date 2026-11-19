import { afterEach, expect, test } from "bun:test";
import type { ComposerDraft } from "../src/components/channels/composer/draft";
import { toAgentOptions } from "../src/components/channels/composer/triggers";
import {
  dispatchToWaker,
  mentionRoster,
  routeChannelDraft,
  sendChannelDraft,
} from "../src/lib/channels/dispatch";
import { RequestError } from "../src/lib/client";

/**
 * Spec B1–B3 from the 1:1 conversation's side: who `@` can name there, and where a sent mention goes.
 *
 * The pinned coworker is the conversation; anybody else named with `@` is handed the work through
 * `/dispatch`. These drive the same functions `channel-chat.tsx` calls, with the network captured.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function capturingFetch(status: number, body: unknown) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return seen;
}

function draft(overrides: Partial<ComposerDraft> = {}): ComposerDraft {
  return {
    text: "@阿审 帮我审一下这份合同",
    agentId: null,
    crewTemplateId: null,
    commandIds: [],
    isEmpty: false,
    attachments: [],
    ...overrides,
  };
}

const profiles = [
  { id: "pinned", name: "小熊", title: "助理" },
  { id: "reviewer", name: "阿审", title: "审核" },
  { id: "writer", name: "阿写", title: "写作" },
];

test("a 1:1 conversation's @ menu lists every coworker the person can see", () => {
  expect(
    mentionRoster(profiles, ["pinned"]).map((option) => option.id),
  ).toEqual(["pinned", "reviewer", "writer"]);
  // Several coworkers: the conversation's own members, as before.
  expect(
    mentionRoster(profiles, ["pinned", "writer"]).map((option) => option.id),
  ).toEqual(["pinned", "writer"]);
  expect(mentionRoster(undefined, ["pinned"])).toEqual([]);
});

test("only a mention of somebody other than the pinned coworker is a dispatch", () => {
  const oneToOne = { agentIds: ["pinned"] };
  expect(routeChannelDraft(draft(), oneToOne, "pinned")).toEqual({
    kind: "say",
  });
  expect(
    routeChannelDraft(draft({ agentId: "pinned" }), oneToOne, "pinned"),
  ).toEqual({ kind: "say" });
  expect(
    routeChannelDraft(draft({ agentId: "reviewer" }), oneToOne, "pinned"),
  ).toEqual({ kind: "dispatch", agentId: "reviewer" });
  // A conversation with several coworkers is the group screen's to route.
  expect(
    routeChannelDraft(
      draft({ agentId: "reviewer" }),
      { agentIds: ["pinned", "reviewer"] },
      "pinned",
    ),
  ).toEqual({ kind: "say" });
});

test("a non-pinned mention posts to /dispatch with the typed words and never runs the pinned turn", async () => {
  const seen = capturingFetch(202, {
    taskId: "task-1",
    runId: "run-1",
    queued: true,
  });
  let said = 0;

  const sent = await sendChannelDraft(draft({ agentId: "reviewer" }), {
    channel: { id: "channel/1", agentIds: ["pinned"] },
    pinnedAgentId: "pinned",
    newId: () => "message-1",
    say: async () => {
      said += 1;
    },
  });

  expect(said).toBe(0);
  expect(sent).toEqual({
    kind: "dispatched",
    agentId: "reviewer",
    accepted: { taskId: "task-1", runId: "run-1", queued: true },
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/channels/channel%2F1/dispatch");
  expect(seen[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
    id: "message-1",
    agentId: "reviewer",
    text: "@阿审 帮我审一下这份合同",
  });
});

test("a mention of the pinned coworker, or none, is an ordinary turn", async () => {
  const seen = capturingFetch(500, {});
  let said = 0;
  for (const agentId of [null, "pinned"]) {
    const sent = await sendChannelDraft(draft({ agentId }), {
      channel: { id: "channel-1", agentIds: ["pinned"] },
      pinnedAgentId: "pinned",
      newId: () => "unused",
      say: async () => {
        said += 1;
      },
    });
    expect(sent).toEqual({ kind: "said" });
  }
  expect(said).toBe(2);
  expect(seen).toHaveLength(0);
});

test("a dispatch carrying files is refused before anything is sent", async () => {
  const seen = capturingFetch(202, {});
  await expect(
    sendChannelDraft(
      draft({
        agentId: "reviewer",
        attachments: [
          { id: "a" } as unknown as ComposerDraft["attachments"][number],
        ],
      }),
      {
        channel: { id: "channel-1", agentIds: ["pinned"] },
        pinnedAgentId: "pinned",
        newId: () => "message-1",
        say: async () => undefined,
      },
    ),
  ).rejects.toThrow("派活暂时只能发送文字");
  expect(seen).toHaveLength(0);
});

test("a refused dispatch throws the server's own sentence with its status", async () => {
  capturingFetch(404, { error: "找不到这段对话或这位员工。" });
  const failure = await dispatchToWaker({
    channelId: "channel-1",
    id: "message-1",
    agentId: "someone-elses",
    text: "@别人 做点事",
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RequestError);
  expect((failure as RequestError).status).toBe(404);
  expect((failure as RequestError).message).toBe("找不到这段对话或这位员工。");
});

test("the @ menu leaves out preset originals: the person's own summoned copy is the one to name", () => {
  const withPresets = [
    ...profiles,
    { id: "preset-doctor", name: "暖心医生", summonKind: "preset" as const },
    { id: "preset-lawyer", name: "专业律师", summonKind: "preset" as const },
    { id: "copy-lawyer", name: "专业律师", summonKind: null },
  ];
  expect(
    mentionRoster(withPresets, ["pinned"]).map((option) => option.id),
  ).toEqual(["pinned", "reviewer", "writer", "copy-lawyer"]);
  expect(toAgentOptions(withPresets).map((option) => option.id)).toEqual([
    "pinned",
    "reviewer",
    "writer",
    "copy-lawyer",
  ]);
  // A conversation that already has a preset original among its members still names it.
  expect(
    mentionRoster(withPresets, ["pinned", "preset-doctor"]).map(
      (option) => option.id,
    ),
  ).toEqual(["pinned", "preset-doctor"]);
});
