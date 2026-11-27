import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { TURN_ARTIFACTS_EVENT } from "../../shared/turn-artifacts";
import type { AgentActor } from "../src/agents/profile-types";
import {
  type ArtifactAccessDeps,
  type ArtifactScope,
  normalizedArtifactPath,
  resolveArtifactAccess,
} from "../src/computer/artifact-access";
import { personSeat } from "../src/computer/computer-key";

const member: AgentActor = { id: "member-2", role: "user" };
const channel = "channel-1";
const run = "run-1";
const thread = "thread-1";

const custom = (name: string, value: unknown) =>
  ({ type: "CUSTOM", name, value }) as unknown as BaseEvent;

const artifacts = (paths: string[], seat = "person:owner-1", botId = "bot-1") =>
  custom(TURN_ARTIFACTS_EVENT, {
    botId,
    seat,
    files: paths.map((path) => ({
      path,
      bytes: 1,
      modifiedMs: 1,
      change: "new",
    })),
    scanned: paths.length,
    scanTruncated: false,
    omitted: 0,
  });

const delivered = (workspaceFiles: string[]) =>
  custom("delivery.delivered", {
    taskId: "t",
    eventId: "e",
    agentId: "bot-1",
    deliverable: { kind: "deliverable", workspaceFiles },
  });

type Setup = {
  events?: BaseEvent[];
  runThread?: string;
  /** The employee that made the run; `bot-1` unless said. */
  runAgent?: string;
  channelAnswer?: { agentIds: string[]; threadIds: string[] } | null;
  /** No `seat`: nothing recorded one (a card whose files an approved action wrote, from before cards kept it). */
  card?: { botId: string; seat?: string; workspaceFiles: string[] } | null;
  /** The person the run and the card belong to; the seat every turn of theirs used is theirs. */
  owner?: string;
  live?: boolean;
  /** The employee runs on a computer of its own (isolated) rather than on each person's. */
  isolated?: boolean;
};

function depsFor(setup: Setup = {}) {
  const asked: string[] = [];
  const deps: ArtifactAccessDeps = {
    channelFor: async (_actor, id) => {
      asked.push(`channel:${id}`);
      if (id !== channel) return null;
      return setup.channelAnswer === undefined
        ? { agentIds: ["bot-1"], threadIds: [thread] }
        : setup.channelAnswer;
    },
    runOf: async (_actor, _channel, id) => {
      asked.push(`run:${id}`);
      if (id !== run) return null;
      return {
        threadId: setup.runThread ?? thread,
        ownerId: setup.owner ?? "owner-1",
        agentId: setup.runAgent ?? "bot-1",
        events: setup.events ?? [artifacts(["a.pptx"])],
      };
    },
    cardFor: async (_actor, id) => {
      asked.push(`card:${id}`);
      return id === "task-1" && setup.card
        ? { ...setup.card, ownerId: setup.owner ?? "member-2" }
        : null;
    },
    seatFor: async (botId, personId) =>
      setup.isolated
        ? { botId, key: { kind: "bot", botId } }
        : personSeat(personId, botId),
    botIsLive: async () => setup.live ?? true,
  };
  return { deps, asked };
}

const scope: ArtifactScope = { channel, run };

async function resolve(
  deps: ArtifactAccessDeps,
  path: string,
  over: { scope?: ArtifactScope; botId?: string } = {},
) {
  return resolveArtifactAccess(
    {
      actor: member,
      botId: over.botId ?? "bot-1",
      path,
      scope: over.scope ?? scope,
    },
    deps,
  );
}

describe("who may download which workspace file", () => {
  test("a group member gets the seat of the run that announced the path", async () => {
    const { deps } = depsFor();
    const access = await resolve(deps, "a.pptx");
    expect(access).not.toBeNull();
    expect(access?.seat.key).toEqual({ kind: "person", personId: "owner-1" });
    expect(access?.seat.botId).toBe("bot-1");
  });

  test("a path the run never announced is refused", async () => {
    const { deps } = depsFor();
    expect(await resolve(deps, "other.pptx")).toBeNull();
  });

  test("a person who cannot see the conversation is refused", async () => {
    const { deps } = depsFor({ channelAnswer: null });
    expect(await resolve(deps, "a.pptx")).toBeNull();
  });

  test("a bot that is not in the conversation is refused", async () => {
    const { deps } = depsFor({
      channelAnswer: { agentIds: ["bot-2"], threadIds: [thread] },
    });
    expect(await resolve(deps, "a.pptx")).toBeNull();
  });

  test("a run of another conversation is refused", async () => {
    const { deps } = depsFor({ runThread: "thread-elsewhere" });
    expect(await resolve(deps, "a.pptx")).toBeNull();
  });

  test("a run that does not exist is refused", async () => {
    const { deps } = depsFor();
    expect(
      await resolve(deps, "a.pptx", { scope: { channel, run: "run-x" } }),
    ).toBeNull();
  });

  test("an announcement by another bot does not open the path to this one", async () => {
    const { deps } = depsFor({
      events: [artifacts(["a.pptx"], "person:owner-1", "bot-2")],
    });
    expect(await resolve(deps, "a.pptx")).toBeNull();
  });

  test("any of several announcements in one turn may list the path", async () => {
    const { deps } = depsFor({
      owner: "owner-9",
      events: [
        artifacts(["first.md"], "person:owner-9"),
        artifacts(["a.pptx"], "person:owner-9"),
      ],
    });
    const access = await resolve(deps, "a.pptx");
    expect(access?.seat.key).toEqual({ kind: "person", personId: "owner-9" });
  });

  test("a path matches character for character, special characters included", async () => {
    const { deps } = depsFor({
      events: [artifacts(["报告 #1?.pptx", "Report.PPTX", "a/b c%20d.md"])],
    });
    expect(await resolve(deps, "报告 #1?.pptx")).not.toBeNull();
    expect(await resolve(deps, "a/b c%20d.md")).not.toBeNull();
    // no case folding, no decoding, no stripping of the query-looking tail
    expect(await resolve(deps, "report.pptx")).toBeNull();
    expect(await resolve(deps, "报告 #1.pptx")).toBeNull();
    expect(await resolve(deps, "a/b c d.md")).toBeNull();
  });

  test("a path that leaves the workspace is refused even when it is announced", async () => {
    const { deps } = depsFor({
      events: [artifacts(["../secret.txt", "/etc/passwd", "~/x"])],
    });
    expect(await resolve(deps, "../secret.txt")).toBeNull();
    expect(await resolve(deps, "/etc/passwd")).toBeNull();
    expect(await resolve(deps, "~/x")).toBeNull();
    expect(await resolve(deps, "")).toBeNull();
  });

  test("a delivered file is reachable through the seat the same turn announced", async () => {
    const { deps } = depsFor({
      owner: "owner-3",
      events: [
        artifacts(["something.md"], "person:owner-3"),
        delivered(["out/deck.pptx"]),
      ],
    });
    const access = await resolve(deps, "out/deck.pptx");
    expect(access?.seat.key).toEqual({ kind: "person", personId: "owner-3" });
  });

  test("a delivered file with no announced seat in the run is refused, never guessed", async () => {
    const { deps } = depsFor({ events: [delivered(["out/deck.pptx"])] });
    expect(await resolve(deps, "out/deck.pptx")).toBeNull();
  });

  test("a delivered file does not borrow the seat of another bot's announcement", async () => {
    const { deps } = depsFor({
      events: [
        artifacts(["x"], "person:owner-3", "bot-2"),
        delivered(["out/deck.pptx"]),
      ],
    });
    expect(await resolve(deps, "out/deck.pptx")).toBeNull();
  });

  test("a file delivered by another employee in the run does not open for this one", async () => {
    const { deps } = depsFor({
      events: [
        artifacts(["x"], "person:owner-1"),
        custom("delivery.delivered", {
          taskId: "t",
          eventId: "e",
          agentId: "bot-2",
          deliverable: {
            kind: "deliverable",
            workspaceFiles: ["out/deck.pptx"],
          },
        }),
      ],
    });
    expect(await resolve(deps, "out/deck.pptx")).toBeNull();
  });

  test("an old hand-in with no agentId, in this employee's own run, still opens its file", async () => {
    const { deps } = depsFor({
      events: [
        artifacts(["x"], "person:owner-1"),
        custom("delivery.delivered", {
          taskId: "t",
          eventId: "e",
          deliverable: {
            kind: "deliverable",
            workspaceFiles: ["out/deck.pptx"],
          },
        }),
      ],
    });
    expect(await resolve(deps, "out/deck.pptx")).not.toBeNull();
  });

  test("a hand-in that names this employee does not open anything when the run was made by another one", async () => {
    const { deps } = depsFor({
      runAgent: "bot-2",
      channelAnswer: { agentIds: ["bot-1", "bot-2"], threadIds: [thread] },
      events: [
        artifacts(["x"], "person:owner-1"),
        delivered(["out/deck.pptx"]),
      ],
    });
    expect(await resolve(deps, "out/deck.pptx")).toBeNull();
  });

  test("a run made by another employee is not read as this one's", async () => {
    const { deps } = depsFor({
      channelAnswer: { agentIds: ["bot-1", "bot-2"], threadIds: [thread] },
    });
    // The run's own employee is bot-1; asking as bot-2 finds its announcement under another name.
    expect(await resolve(deps, "a.pptx", { botId: "bot-2" })).toBeNull();
    expect(await resolve(deps, "a.pptx")).not.toBeNull();
  });

  test("an announced seat that is not a computer key is refused", async () => {
    const { deps } = depsFor({ events: [artifacts(["a.pptx"], "nonsense")] });
    expect(await resolve(deps, "a.pptx")).toBeNull();
  });

  test("a seat naming somebody other than the run's person is refused, announced or delivered", async () => {
    const forged = depsFor({
      events: [artifacts(["a.pptx"], "person:victim")],
    });
    expect(await resolve(forged.deps, "a.pptx")).toBeNull();
    const delivery = depsFor({
      events: [artifacts(["x"], "person:victim"), delivered(["out/deck.pptx"])],
    });
    expect(await resolve(delivery.deps, "out/deck.pptx")).toBeNull();
    // an isolated bot's seat is not a person's either
    const bot = depsFor({ events: [artifacts(["a.pptx"], "bot:bot-1")] });
    expect(await resolve(bot.deps, "a.pptx")).toBeNull();
  });

  test("an employee who no longer exists opens nothing", async () => {
    const { deps } = depsFor({ live: false });
    expect(await resolve(deps, "a.pptx")).toBeNull();
  });

  test("a scope with only one half of channel and run is refused, not read as no scope", async () => {
    const { deps, asked } = depsFor();
    expect(await resolve(deps, "a.pptx", { scope: { channel } })).toBeNull();
    expect(await resolve(deps, "a.pptx", { scope: { run } })).toBeNull();
    expect(
      await resolve(deps, "a.pptx", { scope: { channel: "", run } }),
    ).toBeNull();
    expect(
      await resolve(deps, "a.pptx", { scope: { channel, run: "" } }),
    ).toBeNull();
    expect(await resolve(deps, "a.pptx", { scope: {} })).toBeNull();
    expect(asked).toEqual([]);
  });

  describe("by task card", () => {
    const card = {
      botId: "bot-1",
      seat: "person:member-2",
      workspaceFiles: ["out/deck.pptx", "报告 #1?.pptx"],
    };

    test("a visible card's file is reachable through the card's seat", async () => {
      const { deps } = depsFor({ card });
      const access = await resolve(deps, "out/deck.pptx", {
        scope: { task: "task-1" },
      });
      expect(access?.seat.key).toEqual({
        kind: "person",
        personId: "member-2",
      });
      expect(
        await resolve(deps, "报告 #1?.pptx", { scope: { task: "task-1" } }),
      ).not.toBeNull();
    });

    test("a card the person cannot see is refused", async () => {
      const { deps } = depsFor({ card });
      expect(
        await resolve(deps, "out/deck.pptx", { scope: { task: "task-9" } }),
      ).toBeNull();
    });

    test("a path the card does not list is refused", async () => {
      const { deps } = depsFor({ card });
      expect(
        await resolve(deps, "out/other.pptx", { scope: { task: "task-1" } }),
      ).toBeNull();
    });

    test("a card of another employee is refused", async () => {
      const { deps } = depsFor({ card });
      expect(
        await resolve(deps, "out/deck.pptx", {
          scope: { task: "task-1" },
          botId: "bot-2",
        }),
      ).toBeNull();
    });

    test("a card whose seat is not a computer key is refused", async () => {
      const { deps } = depsFor({ card: { ...card, seat: "" } });
      expect(
        await resolve(deps, "out/deck.pptx", { scope: { task: "task-1" } }),
      ).toBeNull();
    });

    test("a card whose seat names a third person is refused", async () => {
      const { deps } = depsFor({ card: { ...card, seat: "person:victim" } });
      expect(
        await resolve(deps, "out/deck.pptx", { scope: { task: "task-1" } }),
      ).toBeNull();
    });

    test("a card of an employee who no longer exists is refused", async () => {
      const { deps } = depsFor({ card, live: false });
      expect(
        await resolve(deps, "out/deck.pptx", { scope: { task: "task-1" } }),
      ).toBeNull();
    });

    describe("with no seat recorded anywhere (an approved action wrote the files)", () => {
      const bare = { botId: "bot-1", workspaceFiles: ["测试-test.txt"] };

      test("is read from the employee's seat on the card owner's own computer", async () => {
        const { deps } = depsFor({ card: bare });
        const access = await resolve(deps, "测试-test.txt", {
          scope: { task: "task-1" },
        });
        expect(access?.seat).toEqual(personSeat("member-2", "bot-1"));
      });

      test("still opens only what the card lists, as its employee, to whom may see the card", async () => {
        const { deps } = depsFor({ card: bare });
        for (const [path, over] of [
          ["other.txt", {}],
          ["测试-test.txt", { botId: "bot-2" }],
          ["测试-test.txt", { scope: { task: "task-9" } }],
        ] as const)
          expect(
            await resolve(deps, path, { scope: { task: "task-1" }, ...over }),
          ).toBeNull();
      });

      test("an employee that no longer exists opens nothing", async () => {
        const { deps } = depsFor({ card: bare, live: false });
        expect(
          await resolve(deps, "测试-test.txt", { scope: { task: "task-1" } }),
        ).toBeNull();
      });

      test("an isolated employee's own computer, shared by all its users, is not guessed at", async () => {
        const { deps } = depsFor({ card: bare, isolated: true });
        expect(
          await resolve(deps, "测试-test.txt", { scope: { task: "task-1" } }),
        ).toBeNull();
        // With the seat kept on the card, the same card opens.
        const kept = depsFor({
          card: { ...bare, seat: "bot:bot-1" },
          isolated: true,
        }).deps;
        expect(
          (await resolve(kept, "测试-test.txt", { scope: { task: "task-1" } }))
            ?.seat.key,
        ).toEqual({ kind: "bot", botId: "bot-1" });
      });
    });

    test("a task given together with channel or run is refused", async () => {
      const { deps } = depsFor({ card });
      expect(
        await resolve(deps, "out/deck.pptx", {
          scope: { task: "task-1", channel, run },
        }),
      ).toBeNull();
      expect(
        await resolve(deps, "out/deck.pptx", {
          scope: { task: "task-1", channel },
        }),
      ).toBeNull();
    });

    test("an empty task is refused without asking", async () => {
      const { deps, asked } = depsFor({ card });
      expect(
        await resolve(deps, "out/deck.pptx", { scope: { task: "" } }),
      ).toBeNull();
      expect(asked).toEqual([]);
    });
  });
});

describe("normalizedArtifactPath", () => {
  test("keeps an ordinary name exactly and refuses what leaves the workspace", () => {
    expect(normalizedArtifactPath("报告 #1?.pptx")).toBe("报告 #1?.pptx");
    expect(normalizedArtifactPath("a//b/./c.txt")).toBe("a/b/c.txt");
    expect(normalizedArtifactPath("..notes.md")).toBe("..notes.md");
    expect(normalizedArtifactPath("a/../b")).toBeNull();
    expect(normalizedArtifactPath("/abs")).toBeNull();
    expect(normalizedArtifactPath("C:\\x")).toBeNull();
  });
});
