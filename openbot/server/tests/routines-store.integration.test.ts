import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  routineRuns,
  routines,
  users,
} from "../src/db/schema";
import { SYSTEM_TENANT, TEAM_TENANT } from "../src/db/schema/tenant";
import {
  createRoutineStore,
  MAX_ENABLED_ROUTINES,
  MAX_INSTRUCTION_CODE_POINTS,
  MAX_RUN_ERROR,
  RoutineNotFoundError,
  RoutineRefusedError,
} from "../src/routines/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const store = createRoutineStore(database);

const testPrefix = `routines-store-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

/** Every day at 09:00 UTC: comfortably above the floor and stable to describe. */
const DAILY = "0 9 * * *";

/**
 * WHOSE FRAME (G01). A person's own calls run inside that person's frame, the way the routes run
 * them: `asNewPerson` mints the person's id first so their Bots, channels and routines are made in
 * their own tenant. Their account is an identity row, not a tenant's, so it is written as `platform`,
 * the way sign-in writes it. The sweep's questions, and the test's own reads and writes of rows
 * across tenants (stamps, cleanup), go as `platform`, the operator's view.
 *
 * `setUp` and `makeRoutine` take the owner's id, always one from `asNewPerson`, and do their work in
 * that owner's frame. Nothing in this file writes from no frame (G01-E): a row that names nobody is
 * made by `platform` re-stamping one, never by forgetting the frame.
 */
const asPlatform = <T>(fn: () => T): T => runAsTenant("platform", fn);
const newUserId = () => `${testPrefix}-user-${randomUUID()}`;
function asNewPerson<T>(work: (id: string) => Promise<T>): Promise<T> {
  const id = newUserId();
  return runAsTenant(id, () => work(id));
}
/** Somebody else, with their account made in their own frame. */
const otherPerson = () => asNewPerson((id) => createUser(id));

afterEach(async () => {
  // Across every tenant this file wrote in — each person's own, and the `team` and `system` stamps
  // one test puts on a routine — so as `platform`. Routines cascade from both the owner and the
  // agent, but they are cleared first so a failure part-way through cleanup leaves nothing pointing
  // at rows this file is about to delete.
  await asPlatform(async () => {
    for (const userId of createdUserIds) {
      await database.delete(routines).where(eq(routines.ownerUserId, userId));
    }
    for (const channelId of createdChannelIds.splice(0)) {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, channelId));
      await database.delete(channels).where(eq(channels.id, channelId));
    }
    for (const agentId of createdAgentIds.splice(0)) {
      await database
        .delete(agentProfiles)
        .where(eq(agentProfiles.agentId, agentId));
      await database.delete(agents).where(eq(agents.id, agentId));
    }
    for (const userId of createdUserIds.splice(0)) {
      await database.delete(users).where(eq(users.id, userId));
    }
  });
});

afterAll(async () => {
  await database.$client.close();
});

async function createUser(id = newUserId()): Promise<AgentActor> {
  // An identity row, written as `platform` the way sign-in writes it.
  await asPlatform(() =>
    database.insert(users).values({
      id,
      email: `${id}@example.test`,
      name: "Routine Store Test User",
    }),
  );
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createAgent(owner: AgentActor, name = "Expense Manager") {
  const profile = await profileStore.create(owner, {
    name,
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    visibility: "private",
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

async function createChannel(owner: AgentActor, agentIds: string[]) {
  const channel = await channelStore.create(owner, agentIds);
  createdChannelIds.push(channel.id);
  return channel;
}

/** A person, a Bot and the one channel they share: the ordinary starting point. */
async function setUp(ownerId: string) {
  const owner = await createUser(ownerId);
  return runAsTenant(ownerId, async () => {
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);
    return { owner, agentId, channel };
  });
}

/**
 * A routine is one person's standing instruction, so every method takes the owner and every
 * statement is guarded by it. A routine belonging to somebody else has to be indistinguishable from
 * one that was never created — the `setPinned` rule — because anything else tells a stranger which
 * ids exist.
 */
describe("owner-guarding", () => {
  test("another person cannot update, remove or switch off a routine", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      const stranger = await otherPerson();
      const routine = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Summarise yesterday's receipts.",
        cron: DAILY,
      });

      await runAsTenant(stranger.id, async () => {
        await expect(
          store.update(stranger.id, routine.id, {
            instruction: "Do my bidding.",
          }),
        ).rejects.toBeInstanceOf(RoutineNotFoundError);
        await expect(
          store.remove(stranger.id, routine.id),
        ).rejects.toBeInstanceOf(RoutineNotFoundError);
        await expect(
          store.setEnabled(stranger.id, routine.id, false),
        ).rejects.toBeInstanceOf(RoutineNotFoundError);
      });

      const [mine] = await store.listFor(owner.id);
      expect(mine?.instruction).toBe("Summarise yesterday's receipts.");
      expect(mine?.enabled).toBe(true);
    });
  });

  test("a stranger's list does not contain the routine", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      const stranger = await otherPerson();
      await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Summarise yesterday's receipts.",
        cron: DAILY,
      });

      expect(
        await runAsTenant(stranger.id, () => store.listFor(stranger.id)),
      ).toEqual([]);
    });
  });
});

describe("what the schedule has to be", () => {
  test("refuses a cron under the floor, in the schedule's own words", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);

      // Every minute. The sentence is the schedule module's; the store only passes it along, because
      // a model recovers from prose and this is the prose that says what to try instead.
      await expect(
        store.create({
          ownerUserId: owner.id,
          agentId,
          channelId: channel.id,
          instruction: "Check my inbox.",
          cron: "* * * * *",
        }),
      ).rejects.toThrow(/15 minutes/);
      await expect(
        store.create({
          ownerUserId: owner.id,
          agentId,
          channelId: channel.id,
          instruction: "Check my inbox.",
          cron: "* * * * *",
        }),
      ).rejects.toBeInstanceOf(RoutineRefusedError);
    });
  });

  test("refuses an instruction over the cap and accepts one at it", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);

      const atTheCap = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "x".repeat(MAX_INSTRUCTION_CODE_POINTS),
        cron: DAILY,
      });
      expect(Array.from(atTheCap.instruction)).toHaveLength(
        MAX_INSTRUCTION_CODE_POINTS,
      );

      await expect(
        store.create({
          ownerUserId: owner.id,
          agentId,
          channelId: channel.id,
          instruction: "x".repeat(MAX_INSTRUCTION_CODE_POINTS + 1),
          cron: DAILY,
        }),
      ).rejects.toBeInstanceOf(RoutineRefusedError);
    });
  });

  test("refuses a blank instruction with the sentence a model is meant to read", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);

      const failure = await store
        .create({
          ownerUserId: owner.id,
          agentId,
          channelId: channel.id,
          instruction: "   ",
          cron: DAILY,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(RoutineRefusedError);
      expect((failure as Error).message).toBe(
        "A routine needs an instruction to carry out.",
      );
    });
  });
});

/**
 * The cap is a constant with a reason: every enabled routine is a headless turn somebody's Bot will
 * take without being watched, and a model that can be talked into creating them one at a time can be
 * talked into creating a hundred. It counts what is switched ON, so switching one off makes room.
 */
describe("how many a person may have switched on", () => {
  test("refuses the one past the cap, and accepts it once another is off", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      const created: string[] = [];
      for (let index = 0; index < MAX_ENABLED_ROUTINES; index += 1) {
        const routine = await store.create({
          ownerUserId: owner.id,
          agentId,
          channelId: channel.id,
          instruction: `Routine ${index}`,
          cron: DAILY,
        });
        created.push(routine.id);
      }

      await expect(
        store.create({
          ownerUserId: owner.id,
          agentId,
          channelId: channel.id,
          instruction: "One too many.",
          cron: DAILY,
        }),
      ).rejects.toBeInstanceOf(RoutineRefusedError);

      await store.setEnabled(owner.id, created[0] as string, false);

      const room = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Now there is room.",
        cron: DAILY,
      });
      expect(room.enabled).toBe(true);

      // And switching the disabled one back on is refused for the same reason.
      await expect(
        store.setEnabled(owner.id, created[0] as string, true),
      ).rejects.toBeInstanceOf(RoutineRefusedError);
    });
  });

  /**
   * The cap has to hold under concurrency, not just in sequence. A bare count-then-insert lets two
   * creates racing at 19 both count 19 and both insert — the person holds 21 — which is why the
   * store serializes the count and the write per owner under an advisory lock. This drives the race
   * for real: two creates in flight at once on separate pooled connections.
   */
  test("two creates racing at the cap admit exactly one", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      for (let index = 0; index < MAX_ENABLED_ROUTINES - 1; index += 1) {
        await store.create({
          ownerUserId: owner.id,
          agentId,
          channelId: channel.id,
          instruction: `Routine ${index}`,
          cron: DAILY,
        });
      }

      const outcomes = await Promise.allSettled([
        store.create({
          ownerUserId: owner.id,
          agentId,
          channelId: channel.id,
          instruction: "Racer one.",
          cron: DAILY,
        }),
        store.create({
          ownerUserId: owner.id,
          agentId,
          channelId: channel.id,
          instruction: "Racer two.",
          cron: DAILY,
        }),
      ]);

      const refused = outcomes.filter(
        (outcome) => outcome.status === "rejected",
      ) as PromiseRejectedResult[];
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(refused).toHaveLength(1);
      // The loser gets the friendly sentence, not a constraint violation: the same refusal a
      // sequential twenty-first create gets.
      expect(refused[0]?.reason).toBeInstanceOf(RoutineRefusedError);

      const enabled = (await store.listFor(owner.id)).filter(
        (summary) => summary.enabled,
      );
      expect(enabled).toHaveLength(MAX_ENABLED_ROUTINES);
    });
  });
});

/**
 * The conversation's channel is not reachable at the tool layer, so the store resolves it. All four
 * branches matter: the wrong channel is a place a Bot could post something private, and the two
 * ambiguous branches are refusals a model has to be able to recover from in language.
 */
describe("resolving the channel to post into", () => {
  test("accepts a channel the owner and the agent share", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);

      const routine = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Post the summary here.",
        cron: DAILY,
      });

      expect(routine.channelId).toBe(channel.id);
    });
  });

  test("refuses a channel the owner is not in", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId } = await setUp(ownerId);
      const stranger = await otherPerson();
      const theirChannel = await runAsTenant(stranger.id, async () =>
        createChannel(stranger, [await createAgent(stranger, "Their Bot")]),
      );

      await expect(
        store.create({
          ownerUserId: owner.id,
          agentId,
          channelId: theirChannel.id,
          instruction: "Post into somebody else's channel.",
          cron: DAILY,
        }),
      ).rejects.toThrow(/both in/);
    });
  });

  test("refuses a channel this agent is not in", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, channel } = await setUp(ownerId);
      const otherAgentId = await createAgent(owner, "Unrelated Bot");

      await expect(
        store.create({
          ownerUserId: owner.id,
          agentId: otherAgentId,
          channelId: channel.id,
          instruction: "Post where I do not live.",
          cron: DAILY,
        }),
      ).rejects.toBeInstanceOf(RoutineRefusedError);
    });
  });

  test("uses the only shared channel when none was named", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);

      const routine = await store.create({
        ownerUserId: owner.id,
        agentId,
        instruction: "Wherever we talk.",
        cron: DAILY,
      });

      expect(routine.channelId).toBe(channel.id);
    });
  });

  test("refuses with no channel at all, and says to start one", async () => {
    await asNewPerson(async (ownerId) => {
      const owner = await createUser(ownerId);
      const agentId = await createAgent(owner);

      await expect(
        store.create({
          ownerUserId: owner.id,
          agentId,
          instruction: "Nowhere to put this.",
          cron: DAILY,
        }),
      ).rejects.toThrow(/Start one/);
    });
  });

  test("refuses ambiguity by naming the channels, so a model can ask", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      const secondAgentId = await createAgent(owner, "Second Bot");
      const other = await createChannel(owner, [agentId, secondAgentId]);

      const failure = await store
        .create({
          ownerUserId: owner.id,
          agentId,
          instruction: "Which one?",
          cron: DAILY,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(RoutineRefusedError);
      const message = (failure as Error).message;
      expect(message).toContain(channel.name);
      expect(message).toContain(other.name);
      expect(message).toContain("Say which one.");
    });
  });

  test("names at most five channels before it gives up and says 'and others'", async () => {
    await asNewPerson(async (ownerId) => {
      const owner = await createUser(ownerId);
      const agentId = await createAgent(owner);
      const sharedChannels = [];
      for (let index = 0; index < 6; index += 1) {
        sharedChannels.push(await createChannel(owner, [agentId]));
      }

      const failure = await store
        .create({
          ownerUserId: owner.id,
          agentId,
          instruction: "Which one?",
          cron: DAILY,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(RoutineRefusedError);
      const message = (failure as Error).message;
      expect(message).toContain(", and others");
      // All six channels share one agent, so they share one name; the cap names five of them, not
      // six, so that one name appears exactly five times rather than six.
      const name = sharedChannels[0]?.name as string;
      const occurrences = message.split(name).length - 1;
      expect(occurrences).toBe(5);
    });
  });

  test("names a colliding channel by id when its name cannot tell it apart from another", async () => {
    await asNewPerson(async (ownerId) => {
      // The finding this guards: a real account had six channels all named "General Assistant" with
      // the same Bot, and the refusal read "General Assistant, General Assistant, … and others" —
      // circular, because the person cannot answer it and the model cannot map an answer back to a
      // channelId. Two same-named channels plus one distinctly-named one is the smallest case that
      // proves the fix: the colliding pair gets ids, the distinct one stays bare.
      const owner = await createUser(ownerId);
      const agentId = await createAgent(owner);
      const twinOne = await createChannel(owner, [agentId]);
      const twinTwo = await createChannel(owner, [agentId]);
      // channelStore.create names channels itself, so force the collision directly rather than
      // trusting default naming to produce two identical names.
      await database
        .update(channels)
        .set({ name: "General Assistant" })
        .where(eq(channels.id, twinOne.id));
      await database
        .update(channels)
        .set({ name: "General Assistant" })
        .where(eq(channels.id, twinTwo.id));
      const distinct = await createChannel(owner, [agentId]);
      await database
        .update(channels)
        .set({ name: "Marketing Bot" })
        .where(eq(channels.id, distinct.id));

      const failure = await store
        .create({
          ownerUserId: owner.id,
          agentId,
          instruction: "Which one?",
          cron: DAILY,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(RoutineRefusedError);
      const message = (failure as Error).message;
      // Both same-named channels are named by their full id, because that is the one thing the model
      // can pass back as `channelId` when the names alone cannot disambiguate.
      expect(message).toContain(twinOne.id);
      expect(message).toContain(twinTwo.id);
      // The distinctly-named channel is not: its name alone already disambiguates it, and appending
      // an id it does not need would make the common, non-colliding case's sentence longer for
      // nothing.
      expect(message).toContain("Marketing Bot");
      expect(message).not.toContain(`Marketing Bot (${distinct.id})`);
    });
  });
});

describe("reading a person's routines", () => {
  test("says the schedule in words and never in cron", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Summarise the day.",
        cron: DAILY,
        timezone: "Europe/Madrid",
      });

      const [summary] = await store.listFor(owner.id);

      expect(summary?.schedule).toBe("Every day at 09:00");
      expect(summary?.schedule).not.toContain("*");
      expect(summary?.timezone).toBe("Europe/Madrid");
      expect(summary?.channelName).toBe(channel.name);
      expect(summary?.channelDeleted).toBe(false);
      expect(summary?.nextRunAt).toBeInstanceOf(Date);
      // A routine that has never fired has no run row, so the join has nothing to report.
      expect(summary?.lastRun).toBeNull();
    });
  });

  test("says a step schedule in words too, never in cron", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Check in often.",
        cron: "*/20 * * * *",
      });

      const [summary] = await store.listFor(owner.id);

      expect(summary?.schedule).not.toContain("*");
    });
  });

  test("puts the newest first", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      const first = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "First.",
        cron: DAILY,
      });
      const second = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Second.",
        cron: DAILY,
      });

      expect((await store.listFor(owner.id)).map((row) => row.id)).toEqual([
        second.id,
        first.id,
      ]);
    });
  });

  test("keeps a routine whose channel was deleted and reports it as gone", async () => {
    await asNewPerson(async (ownerId) => {
      // The whole reason `routines.channel_id` is not a foreign key: a cascade here would delete the
      // person's standing instruction silently, and they would find out by it never running again.
      const { owner, agentId, channel } = await setUp(ownerId);
      await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Post into a channel that is about to go.",
        cron: DAILY,
      });

      await channelStore.softDelete(owner, channel.id);

      const [summary] = await store.listFor(owner.id);
      expect(summary?.channelId).toBe(channel.id);
      expect(summary?.channelDeleted).toBe(true);
    });
  });
});

describe("changing a routine", () => {
  test("recomputes the next run when the cron changes", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      const routine = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Summarise the day.",
        cron: DAILY,
      });

      const updated = await store.update(owner.id, routine.id, {
        cron: "30 21 * * *",
      });

      expect(updated.cron).toBe("30 21 * * *");
      expect(updated.nextRunAt.getTime()).not.toBe(routine.nextRunAt.getTime());
    });
  });

  test("recomputes the next run when only the timezone changes, and refuses an unknown zone", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      const routine = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Summarise the day.",
        cron: DAILY,
      });

      const updated = await store.update(owner.id, routine.id, {
        timezone: "Asia/Tokyo",
      });

      expect(updated.timezone).toBe("Asia/Tokyo");
      expect(updated.nextRunAt.getTime()).not.toBe(routine.nextRunAt.getTime());

      await expect(
        store.update(owner.id, routine.id, { timezone: "Mars/Olympus" }),
      ).rejects.toBeInstanceOf(RoutineRefusedError);

      // The refusal must not have partially applied: the row still carries the timezone from the
      // update that succeeded, not the rejected "Mars/Olympus".
      const [summary] = await store.listFor(owner.id);
      expect(summary?.timezone).toBe("Asia/Tokyo");
    });
  });

  test("leaves the next run alone when only the instruction changes", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      const routine = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Summarise the day.",
        cron: DAILY,
      });

      const updated = await store.update(owner.id, routine.id, {
        instruction: "Summarise the week.",
      });

      expect(updated.instruction).toBe("Summarise the week.");
      expect(updated.nextRunAt.getTime()).toBe(routine.nextRunAt.getTime());
    });
  });

  test("re-validates only what was supplied", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      const routine = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Summarise the day.",
        cron: DAILY,
      });

      await expect(
        store.update(owner.id, routine.id, { cron: "* * * * *" }),
      ).rejects.toBeInstanceOf(RoutineRefusedError);
      await expect(
        store.update(owner.id, routine.id, {
          instruction: "x".repeat(MAX_INSTRUCTION_CODE_POINTS + 1),
        }),
      ).rejects.toBeInstanceOf(RoutineRefusedError);
      // Refused writes changed nothing.
      const [summary] = await store.listFor(owner.id);
      expect(summary?.instruction).toBe("Summarise the day.");
      expect(summary?.schedule).toBe("Every day at 09:00");
    });
  });

  test("re-resolves the channel when a new one is named", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      const secondAgentId = await createAgent(owner, "Second Bot");
      const other = await createChannel(owner, [agentId, secondAgentId]);
      const routine = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Summarise the day.",
        cron: DAILY,
      });

      const moved = await store.update(owner.id, routine.id, {
        channelId: other.id,
      });
      expect(moved.channelId).toBe(other.id);

      const stranger = await otherPerson();
      const theirChannel = await runAsTenant(stranger.id, async () =>
        createChannel(stranger, [await createAgent(stranger, "Their Bot")]),
      );
      await expect(
        store.update(owner.id, routine.id, { channelId: theirChannel.id }),
      ).rejects.toBeInstanceOf(RoutineRefusedError);
    });
  });

  test("switching off and on again recomputes the next run", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      const routine = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Summarise the day.",
        cron: DAILY,
      });
      // A routine switched off for a month has a next run a month in the past. Enabling it must not
      // hand the sweep a firing that was due in June. Forcing the stamp into the past makes that
      // stale state real rather than assumed: without this, `nextRunAt > now` would already have
      // been true before the disable, and deleting the recompute branch would leave this green.
      await store.setEnabled(owner.id, routine.id, false);
      const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await database
        .update(routines)
        .set({ nextRunAt: stale })
        .where(eq(routines.id, routine.id));

      const enabled = await store.update(owner.id, routine.id, {
        enabled: true,
      });

      expect(enabled.enabled).toBe(true);
      expect(enabled.nextRunAt.getTime()).toBeGreaterThan(Date.now());

      // The mirror image: an instruction-only change on an already-enabled routine must not recompute,
      // even when the stored stamp is one that recomputing would obviously move.
      await database
        .update(routines)
        .set({ nextRunAt: stale })
        .where(eq(routines.id, routine.id));

      const untouched = await store.update(owner.id, routine.id, {
        instruction: "Summarise the week instead.",
      });

      expect(untouched.nextRunAt.getTime()).toBe(stale.getTime());
    });
  });

  test("removing one is a hard delete, and only once", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      const routine = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Summarise the day.",
        cron: DAILY,
      });

      await store.remove(owner.id, routine.id);

      expect(await store.listFor(owner.id)).toEqual([]);
      await expect(store.remove(owner.id, routine.id)).rejects.toBeInstanceOf(
        RoutineNotFoundError,
      );
    });
  });
});

/*
 * ---------------------------------------------------------------------------------------------
 * The sweep's half. Nothing below is asked a question by a person, and everything below is about
 * two things happening at once: several replicas reading the same due row in the same second.
 *
 * NO CLAIM OR LEASE SEMANTICS ARE TESTED HERE. Firing mechanics live in the shared `work_items`
 * queue, and `server/tests/work-queue.integration.test.ts` owns `for update skip locked`, leases
 * on the database's clock, and the attempt count. What this file tests is the routines table's own
 * compare-and-set on `next_run_at`, which is a different guarantee: the clock moves once.
 */

/**
 * The create path always computes a future stamp, so a due-in-the-past row has to be written
 * directly — the same direct write the staleness test above uses. The stamps are deliberately
 * ancient: `dueRoutines` is not owner-scoped, so a test that asserts on ordering has to be sure
 * its own rows sort ahead of anything else in the database.
 */
async function makeDueAt(routineId: string, nextRunAt: Date): Promise<Date> {
  await asPlatform(() =>
    database
      .update(routines)
      .set({ nextRunAt })
      .where(eq(routines.id, routineId)),
  );
  const [row] = await asPlatform(() =>
    database
      .select({ nextRunAt: routines.nextRunAt })
      .from(routines)
      .where(eq(routines.id, routineId))
      .limit(1),
  );
  // Read back rather than trusting the Date we wrote: the comparison the CAS makes is Postgres's.
  return row?.nextRunAt as Date;
}

async function readRoutine(routineId: string) {
  const [row] = await asPlatform(() =>
    database.select().from(routines).where(eq(routines.id, routineId)).limit(1),
  );
  return row;
}

async function makeRoutine(
  instruction = "Summarise the day.",
  ownerId: string,
) {
  const { owner, agentId, channel } = await setUp(ownerId);
  const routine = await runAsTenant(ownerId, () =>
    store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction,
      cron: DAILY,
    }),
  );
  return { owner, agentId, channel, routine };
}

describe("moving a routine's clock", () => {
  test("two sweeps racing on the same stamp advance it exactly once", async () => {
    await asNewPerson(async (ownerId) => {
      const { routine } = await makeRoutine(undefined, ownerId);
      const from = await makeDueAt(
        routine.id,
        new Date("2001-03-04T09:00:00Z"),
      );

      const outcomes = await Promise.all([
        asPlatform(() => store.advanceNextRun(routine.id, from)),
        asPlatform(() => store.advanceNextRun(routine.id, from)),
      ]);

      expect(outcomes.filter((won) => won)).toHaveLength(1);
      expect(outcomes.filter((won) => !won)).toHaveLength(1);

      // The loser's re-read sees the advanced value: whichever call lost, the clock has moved on and
      // nothing is left holding the stamp it was asked to move from.
      const after = await readRoutine(routine.id);
      expect(after?.nextRunAt.getTime()).toBeGreaterThan(from.getTime());
    });
  });

  test("a stale `from` returns false and moves nothing", async () => {
    await asNewPerson(async (ownerId) => {
      const { routine } = await makeRoutine(undefined, ownerId);
      const from = await makeDueAt(
        routine.id,
        new Date("2001-03-04T09:00:00Z"),
      );

      const moved = await asPlatform(() =>
        store.advanceNextRun(routine.id, new Date("2001-03-03T09:00:00Z")),
      );

      expect(moved).toBe(false);
      const after = await readRoutine(routine.id);
      expect(after?.nextRunAt.getTime()).toBe(from.getTime());
      expect(after?.lastRunAt).toBeNull();
    });
  });

  test("an explicit computeFrom drains a stale clock current in one move, CAS intact", async () => {
    await asNewPerson(async (ownerId) => {
      const { routine } = await makeRoutine(undefined, ownerId);
      const from = await makeDueAt(
        routine.id,
        new Date("2001-01-01T09:00:00Z"),
      );

      // The sweep's stale-backlog call: compare against the month-old stamp it read, but land on the
      // occurrence after the moment the sweep is standing in — not one day along a 31-day drain.
      const moved = await asPlatform(() =>
        store.advanceNextRun(
          routine.id,
          from,
          new Date("2001-02-01T10:00:00Z"),
        ),
      );

      expect(moved).toBe(true);
      const after = await readRoutine(routine.id);
      expect(after?.nextRunAt.toISOString()).toBe("2001-02-02T09:00:00.000Z");
      // The bookmark still records the stamp the CAS compared against.
      expect(after?.lastRunAt?.getTime()).toBe(from.getTime());

      // And the CAS still guards: a second call holding the drained stamp moves nothing.
      expect(
        await asPlatform(() =>
          store.advanceNextRun(
            routine.id,
            from,
            new Date("2001-03-01T10:00:00Z"),
          ),
        ),
      ).toBe(false);
    });
  });

  test("advancing stamps last_run_at with the `from` it was given", async () => {
    await asNewPerson(async (ownerId) => {
      const { routine } = await makeRoutine(undefined, ownerId);
      const from = await makeDueAt(
        routine.id,
        new Date("2001-03-04T09:00:00Z"),
      );

      expect(
        await asPlatform(() => store.advanceNextRun(routine.id, from)),
      ).toBe(true);

      const after = await readRoutine(routine.id);
      // The moment the routine was due, not the moment the sweep happened to look at it.
      expect(after?.lastRunAt?.getTime()).toBe(from.getTime());
      expect(after?.nextRunAt.getTime()).toBeGreaterThan(from.getTime());
    });
  });
});

describe("reading which routines are due", () => {
  test("returns the due ones oldest first and respects the limit", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel } = await setUp(ownerId);
      const oldest = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Oldest.",
        cron: DAILY,
      });
      const middle = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Middle.",
        cron: DAILY,
      });
      const newest = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Newest.",
        cron: DAILY,
      });
      await makeDueAt(oldest.id, new Date("2001-01-01T09:00:00Z"));
      await makeDueAt(middle.id, new Date("2001-01-02T09:00:00Z"));
      await makeDueAt(newest.id, new Date("2001-01-03T09:00:00Z"));

      // The sweep's question, asked as the sweep asks it.
      const all = await asPlatform(() => store.dueRoutines(10));
      expect(all.map((row) => row.id).slice(0, 3)).toEqual([
        oldest.id,
        middle.id,
        newest.id,
      ]);
      expect(all[0]?.nextRunAt).toBeInstanceOf(Date);

      const limited = await asPlatform(() => store.dueRoutines(2));
      expect(limited.map((row) => row.id)).toEqual([oldest.id, middle.id]);
    });
  });

  test("excludes a routine that is switched off", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, routine } = await makeRoutine(undefined, ownerId);
      await store.setEnabled(owner.id, routine.id, false);
      await makeDueAt(routine.id, new Date("2001-01-01T09:00:00Z"));

      const due = await asPlatform(() => store.dueRoutines(50));
      expect(due.map((row) => row.id)).not.toContain(routine.id);
    });
  });

  test("excludes a routine whose next run is still ahead", async () => {
    await asNewPerson(async (ownerId) => {
      const { routine } = await makeRoutine(undefined, ownerId);
      // The create path already put this in the future; the point is that nothing rounds it down.
      const due = await asPlatform(() => store.dueRoutines(50));
      expect(due.map((row) => row.id)).not.toContain(routine.id);

      await makeDueAt(routine.id, new Date(Date.now() + 60 * 60 * 1000));
      const stillAhead = await asPlatform(() => store.dueRoutines(50));
      expect(stillAhead.map((row) => row.id)).not.toContain(routine.id);
    });
  });
});

describe("opening and closing a run", () => {
  test("a finished run stamps finished_at and leaves the error null", async () => {
    await asNewPerson(async (ownerId) => {
      const { routine } = await makeRoutine(undefined, ownerId);

      const { runId } = await store.insertRun(routine.id);
      const [inFlight] = await asPlatform(() =>
        database.select().from(routineRuns).where(eq(routineRuns.id, runId)),
      );
      // Null status is the in-flight state, which is why the column is nullable.
      expect(inFlight?.status).toBeNull();
      expect(inFlight?.finishedAt).toBeNull();
      expect(inFlight?.startedAt).toBeInstanceOf(Date);

      await store.finishRun(runId, "succeeded");

      const [finished] = await asPlatform(() =>
        database.select().from(routineRuns).where(eq(routineRuns.id, runId)),
      );
      expect(finished?.status).toBe("succeeded");
      expect(finished?.finishedAt).toBeInstanceOf(Date);
      expect(finished?.error).toBeNull();
    });
  });

  test("caps a long error rather than storing whatever a failure produced", async () => {
    await asNewPerson(async (ownerId) => {
      const { routine } = await makeRoutine(undefined, ownerId);
      const { runId } = await store.insertRun(routine.id);

      await store.finishRun(runId, "failed", "x".repeat(600));

      const [finished] = await asPlatform(() =>
        database.select().from(routineRuns).where(eq(routineRuns.id, runId)),
      );
      expect(finished?.status).toBe("failed");
      expect(finished?.error).toHaveLength(MAX_RUN_ERROR);
      expect(MAX_RUN_ERROR).toBe(400);
    });
  });

  test("finishing a run twice cannot relabel what the first finish recorded", async () => {
    await asNewPerson(async (ownerId) => {
      const { routine } = await makeRoutine(undefined, ownerId);
      const { runId } = await store.insertRun(routine.id);

      await store.finishRun(runId, "succeeded");
      const [firstFinish] = await asPlatform(() =>
        database.select().from(routineRuns).where(eq(routineRuns.id, runId)),
      );

      // The natural next-task implementation: finish "succeeded", then something downstream throws,
      // and the catch calls finishRun("failed", ...). Without a finish-once guard this would
      // relabel a run that had already succeeded.
      await store.finishRun(runId, "failed", "late");

      const [secondFinish] = await asPlatform(() =>
        database.select().from(routineRuns).where(eq(routineRuns.id, runId)),
      );
      expect(secondFinish?.status).toBe("succeeded");
      expect(secondFinish?.error).toBeNull();
      expect(secondFinish?.finishedAt?.getTime()).toBe(
        firstFinish?.finishedAt?.getTime(),
      );
    });
  });

  test("the page's last run reads the newest of several", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, routine } = await makeRoutine(undefined, ownerId);
      const first = await store.insertRun(routine.id);
      await store.finishRun(first.runId, "failed", "the first one");
      const second = await store.insertRun(routine.id);
      await store.finishRun(second.runId, "succeeded");

      const [summary] = await store.listFor(owner.id);
      expect(summary?.lastRun?.status).toBe("succeeded");
      expect(summary?.lastRun?.finishedAt).toBeInstanceOf(Date);
    });
  });
});

/**
 * A server that dies mid-turn strands its run row open forever: the work item was finished on the
 * 202, so no retry ever comes back for that row, and nothing else writes it — the routines page
 * reads "running now" for a run no process is running. `reapAbandonedRuns` is the sweep's mop for
 * exactly that, and its age bound is what keeps it off live work: a young open row may be a turn
 * some server is still running, and closing it would turn the real `finishRun` into a silent no-op.
 */
describe("reaping the runs the server never finished", () => {
  /** Age one run row past the reaper's cutoff by hand; the reaper compares on the database's clock. */
  async function ageRun(runId: string, byMs: number) {
    await asPlatform(() =>
      database
        .update(routineRuns)
        .set({ startedAt: new Date(Date.now() - byMs) })
        .where(eq(routineRuns.id, runId)),
    );
  }

  test("closes only the rows past the cutoff, as skipped, and leaves live work alone", async () => {
    await asNewPerson(async (ownerId) => {
      const { routine } = await makeRoutine(undefined, ownerId);
      const abandoned = await store.insertRun(routine.id);
      const inFlight = await store.insertRun(routine.id);
      const finished = await store.insertRun(routine.id);
      await store.finishRun(finished.runId, "succeeded");
      await ageRun(abandoned.runId, 11 * 60_000);

      const reaped = await asPlatform(() =>
        store.reapAbandonedRuns(
          10 * 60_000,
          "the server did not finish this run; it may have restarted mid-turn",
        ),
      );

      // At least the row this test aged: the reaper is deliberately not routine-scoped, so a stray
      // abandoned row from elsewhere in the database may be swept up in the same call.
      expect(reaped).toBeGreaterThanOrEqual(1);

      const rows = await asPlatform(() =>
        database
          .select()
          .from(routineRuns)
          .where(eq(routineRuns.routineId, routine.id)),
      );
      const byId = new Map(rows.map((row) => [row.id, row]));

      const abandonedRow = byId.get(abandoned.runId);
      expect(abandonedRow?.status).toBe("skipped");
      expect(abandonedRow?.finishedAt).toBeInstanceOf(Date);
      expect(abandonedRow?.error).toContain("did not finish this run");

      // The fresh open row is a turn some server may still be running: closing it would make the real
      // finishRun a silent no-op, which is the exact overreach the age bound exists to prevent.
      expect(byId.get(inFlight.runId)?.status).toBeNull();

      // And a run with an outcome already has its truth; the reaper closes abandonment, not history.
      expect(byId.get(finished.runId)?.status).toBe("succeeded");
    });
  });

  test("caps the reason the same way finishRun does", async () => {
    await asNewPerson(async (ownerId) => {
      const { routine } = await makeRoutine(undefined, ownerId);
      const { runId } = await store.insertRun(routine.id);
      await ageRun(runId, 11 * 60_000);

      await asPlatform(() =>
        store.reapAbandonedRuns(10 * 60_000, "x".repeat(600)),
      );

      const [row] = await asPlatform(() =>
        database.select().from(routineRuns).where(eq(routineRuns.id, runId)),
      );
      expect(row?.error).toHaveLength(MAX_RUN_ERROR);
    });
  });
});

/**
 * The sweep's off switch for a routine whose own schedule refuses to advance — a cron written before
 * a validation existed, or hand-edited under it. Left enabled, such a routine throws out of
 * `advanceNextRun` on every pass forever: its clock never moves and it burns a due slot each time.
 */
describe("switching off a routine the sweep cannot schedule", () => {
  test("disables it and leaves a skipped run carrying the reason where the page reads it", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, routine } = await makeRoutine(undefined, ownerId);

      await store.markUnschedulable(
        routine.id,
        "Routines may run at most every 15 minutes.",
      );

      const [summary] = await store.listFor(owner.id);
      expect(summary?.enabled).toBe(false);
      // The run row is the announcement: the sweep has no channel to say this in, so the page's
      // last-run column is where the owner learns why their routine stopped.
      expect(summary?.lastRun?.status).toBe("skipped");
      const [row] = await asPlatform(() =>
        database
          .select()
          .from(routineRuns)
          .where(eq(routineRuns.routineId, routine.id)),
      );
      expect(row?.error).toBe("Routines may run at most every 15 minutes.");
      expect(row?.finishedAt).toBeInstanceOf(Date);
    });
  });

  test("a skipped announcement neither counts as a failure nor breaks a streak", async () => {
    await asNewPerson(async (ownerId) => {
      const { routine } = await makeRoutine(undefined, ownerId);
      const { runId } = await store.insertRun(routine.id);
      await store.finishRun(runId, "failed", "it threw");

      await store.markUnschedulable(routine.id, "unschedulable");

      // The fatigue rule reads through the announcement to the real failure tail.
      expect(await store.consecutiveFailures(routine.id)).toBe(1);
    });
  });

  test("switching a routine back on starts its failure count again", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, routine } = await makeRoutine(undefined, ownerId);
      for (let failure = 0; failure < 10; failure += 1) {
        const { runId } = await store.insertRun(routine.id);
        await store.finishRun(runId, "failed", "the integration is down");
      }
      expect(await store.consecutiveFailures(routine.id)).toBe(10);

      // What the fatigue rule does at ten, and what the owner does once they have fixed the cause.
      await store.setEnabled(owner.id, routine.id, false);
      await store.setEnabled(owner.id, routine.id, true);
      expect(await store.consecutiveFailures(routine.id)).toBe(0);

      // The next failure is the first of a new streak, so it is announced as one rather than
      // switching the routine straight back off as the eleventh in a row.
      const { runId } = await store.insertRun(routine.id);
      await store.finishRun(runId, "failed", "still down");
      expect(await store.consecutiveFailures(routine.id)).toBe(1);
    });
  });

  test("a routine deleted in the meantime is left alone", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, routine } = await makeRoutine(undefined, ownerId);
      await store.remove(owner.id, routine.id);

      // Gone is gone: no throw, and no orphaned run row for a routine nobody can see.
      await store.markUnschedulable(routine.id, "unschedulable");
      expect(
        await asPlatform(() =>
          database
            .select()
            .from(routineRuns)
            .where(eq(routineRuns.routineId, routine.id)),
        ),
      ).toEqual([]);
    });
  });
});

describe("the runner's read of one firing", () => {
  test("joins the run to its routine, owner included", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, agentId, channel, routine } = await makeRoutine(
        "Post the standup summary.",
        ownerId,
      );
      const { runId } = await store.insertRun(routine.id);

      // The owner comes back because the runner acts AS the owner: the channel it posts into and the
      // thread it continues are that person's, and nothing else in the run row says who that is.
      //
      // `tenantId` comes back with it, and it is the runner's answer to "whose frame do I take for
      // the turn". Written in the owner's frame, the row says the owner.
      const expected = {
        routineId: routine.id,
        ownerUserId: owner.id,
        tenantId: ownerId,
        agentId,
        channelId: channel.id,
        // Read at dispatch so a routine paused after it was queued still does not run.
        enabled: true,
        instruction: "Post the standup summary.",
      };
      expect(await store.runContext(runId)).toEqual(expected);

      // And the stamp is reported as the row has it, not inferred from the owner id: that is the
      // point of reading it off the routine. Re-stamped by `platform` to each tenant that names
      // nobody (`routines` is not a team table, so no guard trigger refuses the move), the answer
      // follows the stamp while the owner stays who it was — the runner then refuses the stamp,
      // rather than running the turn as the owner the payload names.
      for (const stamp of [TEAM_TENANT, SYSTEM_TENANT]) {
        await asPlatform(() =>
          database
            .update(routines)
            .set({ tenantId: stamp })
            .where(eq(routines.id, routine.id)),
        );
        expect(await store.runContext(runId)).toEqual({
          ...expected,
          tenantId: stamp,
        });
      }
    });
  });

  test("a run id nothing wrote reads as no firing", async () => {
    expect(
      await asPlatform(() => store.runContext("routine_run_missing")),
    ).toBeNull();
  });

  test("a deleted routine takes its queued firing with it", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, routine } = await makeRoutine(undefined, ownerId);
      const { runId } = await store.insertRun(routine.id);

      await store.remove(owner.id, routine.id);

      // Nobody's problem: the delete cascades, so there is no row left to finish and the runner has
      // nothing to say to anybody.
      expect(await asPlatform(() => store.runContext(runId))).toBeNull();
    });
  });
});

/** The tenant stamped on a routine row, read back from the row itself. */
async function stampOf(routineId: string): Promise<string | undefined> {
  const [row] = await asPlatform(() =>
    database
      .select({ tenantId: routines.tenantId })
      .from(routines)
      .where(eq(routines.id, routineId))
      .limit(1),
  );
  return row?.tenantId;
}

/**
 * The consumer's re-read: "gone or disabled since the offer -> finish without dispatching" needs a
 * by-id read that is not owner-scoped, because the id it is given comes from a work item's own
 * payload, not from a person calling in with their own identity. `runContext` cannot answer this —
 * it needs a run row to exist and does not report `enabled` — so this is a second, narrower read.
 */
describe("the sweep's by-id read of a routine before firing", () => {
  test("an existing enabled routine reads back enabled", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, routine } = await makeRoutine(undefined, ownerId);

      // The routine's own tenant and owner travel with it, so the consumer can check a claimed
      // firing's stamp against them (G01). The tenant is whatever the row was stamped with.
      const tenantId = await stampOf(routine.id);
      expect(
        await asPlatform(() => store.routineForFiring(routine.id)),
      ).toEqual({
        id: routine.id,
        enabled: true,
        tenantId,
        ownerUserId: owner.id,
      });
    });
  });

  test("a disabled routine reads back disabled, not missing", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, routine } = await makeRoutine(undefined, ownerId);
      await store.setEnabled(owner.id, routine.id, false);
      const tenantId = await stampOf(routine.id);

      expect(
        await asPlatform(() => store.routineForFiring(routine.id)),
      ).toEqual({
        id: routine.id,
        enabled: false,
        tenantId,
        ownerUserId: owner.id,
      });
    });
  });

  test("a deleted routine reads as no routine at all", async () => {
    await asNewPerson(async (ownerId) => {
      const { owner, routine } = await makeRoutine(undefined, ownerId);
      await store.remove(owner.id, routine.id);

      expect(
        await asPlatform(() => store.routineForFiring(routine.id)),
      ).toBeNull();
    });
  });
});

/**
 * The fatigue rule counts the failures at the tail, and this file pins what a `skipped` run does to
 * that tail: A SKIP IS NOT A FAILURE AND DOES NOT BREAK THE STREAK. A skip means the channel was
 * gone, not that the turn failed, so it is not counted; and it does not reset the count either,
 * because a routine whose channel flaps must not be able to escape the fatigue rule by skipping
 * between its failures.
 */
describe("counting the failures at the tail", () => {
  async function finish(
    routineId: string,
    status: "succeeded" | "failed" | "skipped",
  ) {
    const { runId } = await store.insertRun(routineId);
    await store.finishRun(
      runId,
      status,
      status === "failed" ? "it threw" : undefined,
    );
  }

  test("counts up, resets on a success, and is not broken by a skip", async () => {
    await asNewPerson(async (ownerId) => {
      const { routine } = await makeRoutine(undefined, ownerId);

      expect(await store.consecutiveFailures(routine.id)).toBe(0);

      await finish(routine.id, "succeeded");
      expect(await store.consecutiveFailures(routine.id)).toBe(0);

      await finish(routine.id, "failed");
      expect(await store.consecutiveFailures(routine.id)).toBe(1);

      await finish(routine.id, "failed");
      await finish(routine.id, "failed");
      expect(await store.consecutiveFailures(routine.id)).toBe(3);

      await finish(routine.id, "succeeded");
      expect(await store.consecutiveFailures(routine.id)).toBe(0);
    });
  });

  test("a skip between failures neither counts nor resets", async () => {
    await asNewPerson(async (ownerId) => {
      const { routine } = await makeRoutine(undefined, ownerId);

      await finish(routine.id, "failed");
      await finish(routine.id, "skipped");
      await finish(routine.id, "failed");

      expect(await store.consecutiveFailures(routine.id)).toBe(2);
    });
  });

  test("an in-flight run is not an outcome", async () => {
    await asNewPerson(async (ownerId) => {
      const { routine } = await makeRoutine(undefined, ownerId);
      await finish(routine.id, "failed");
      await store.insertRun(routine.id);

      expect(await store.consecutiveFailures(routine.id)).toBe(1);
    });
  });

  /**
   * A routine with a flapping channel skips far more often than it fails. If the bounded window
   * is filled with every finished run — skips included — the skips eat slots a failure needed,
   * and a routine that has genuinely failed a dozen times in a row can look like it has failed
   * only six or seven. That falsifies the fatigue rule for exactly the scenario the skip rule was
   * written for: it would never reach the disable threshold. The window has to be filled with the
   * rows the fatigue rule can act on, not with every finished row.
   */
  test("skips do not dilute the bounded window the fatigue rule reads", async () => {
    await asNewPerson(async (ownerId) => {
      const { routine } = await makeRoutine(undefined, ownerId);

      // Twelve failures, each trailed by two skips, and nothing after them: a flapping channel's
      // shape. Post-fix, all twelve failures are read (well under the 20-row limit) because skips
      // never occupy a slot. Pre-fix, the 20-row window is filled with the interleaved skips too,
      // so it only reaches back a handful of failures — short of the >=10 disable threshold.
      for (let i = 0; i < 12; i++) {
        await finish(routine.id, "failed");
        await finish(routine.id, "skipped");
        await finish(routine.id, "skipped");
      }

      expect(
        await store.consecutiveFailures(routine.id),
      ).toBeGreaterThanOrEqual(10);
    });
  });
});
