import { describe, expect, test as bunTest } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { HANDOFF_KIND, createHandoffDesk } from "../src/agents/handoff";
import { HANDED_OVER, handoffTool } from "../src/agents/handoff-tool";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  pluginGrants,
  workItems,
} from "../src/db/schema";
import { setEdition } from "../src/edition";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { afterAll, afterEach, beforeEach } from "./support/platform-frame";

/**
 * The fan-out cap, run where it actually holds.
 *
 * `maxPerRun` had cover on its two edges and nothing in between: the tool is not offered with a cap
 * of zero, and not offered to a run already at the depth cap. The number itself — three Bots per
 * turn, counted from the queue's own rows, refused on the fourth — was never exercised against a
 * database. Every other suite either sets the cap to something it does not reach, or stubs the desk.
 *
 * THE MIDDLE IS THE PART THAT CAN BREAK QUIETLY. The count and the write are one transaction behind
 * an advisory lock on the run's prefix, and the comment there says why: a model that emits four tool
 * calls in one turn runs all four at once, each reads a count taken before any of the others wrote,
 * and all four pass a cap of three. Nothing about that shows up in a sequential test, and nothing
 * about it throws — the fourth Bot just runs. So the case here asks four at once.
 *
 * Wired as `index.ts` wires it: the real queue, the real profile store, the real grant read behind
 * the desk, the real audit store. The grants and the Bots are seeded; nothing else is faked.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const suite = randomUUID().slice(0, 8);
const PERSON = `fanout-person-${suite}`;
const ASKER = `fanout-asker-${suite}`;
/** Four Bots, because the cap is three: three arrive and the fourth is the case. */
const ASKED = ["One", "Two", "Three", "Four"].map(
  (word) => `fanout-${word.toLowerCase()}-${suite}`,
);
const ALL = [ASKER, ...ASKED];
const caps = { maxDepth: 1, maxPerRun: 3 };
const THREAD = `thread-${suite}`;

/** As a person says it, which is the name the model is given in the tool's schema. */
const said = new Map(
  ASKED.map((id, index) => [
    id,
    `Fanout ${["One", "Two", "Three", "Four"][index]} ${suite}`,
  ]),
);

const auditStore = createAuditStore(database);
const pluginStore = createPluginStore({
  database,
  auditStore,
  credentials: createCredentialStore(database),
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});
const profiles = createAgentProfileStore(database, undefined);

// An administrator, so the roster is the whole one: who may be seen is not what this is about.
const actorFor = async (id: string) => ({ id, role: "admin" as const });

const desk = createHandoffDesk({
  queue: createWorkQueue(database),
  profiles,
  mayAddress: async (fromBotId, toBotId) =>
    (
      await pluginStore.botsReachableFrom(fromBotId).catch(() => [] as string[])
    ).includes(toBotId),
  addressable: (fromBotId) => pluginStore.botsReachableFrom(fromBotId),
  actorFor,
  auditStore,
  caps,
});

/** The tool one turn is offered. A turn is a run id: the budget is per turn, not per Bot. */
function toolFor(runId: string) {
  const tool = handoffTool({
    from: { botId: ASKER, actorId: PERSON, runId, threadId: THREAD, depth: 0 },
    desk,
    hasSomebodyToAsk: true,
    maxDepth: caps.maxDepth,
    maxPerRun: caps.maxPerRun,
  });
  if (!tool)
    throw new Error("the tool should be offered to a Bot with somebody to ask");
  return tool;
}

/** The hops this turn left on the queue, by the rows themselves rather than by what was said. */
async function hopsOf(runId: string) {
  return database
    .select({ key: workItems.key })
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, HANDOFF_KIND),
        sql`${workItems.payload}->>'runId' = ${runId}`,
      ),
    );
}

const handedOver = (answer: unknown) => String(answer).startsWith(HANDED_OVER);
const capRefusal = (answer: unknown) =>
  String(answer).includes("as many as this deployment allows");

/** Every case is the person's own turn, in that person's tenant frame (G01). */
const test = (name: string, body: () => Promise<void>) =>
  bunTest(name, () => runAsTenant(PERSON, body));

async function clean() {
  await database
    .delete(workItems)
    .where(sql`${workItems.payload}->>'actorId' = ${PERSON}`);
  await database.delete(pluginGrants).where(inArray(pluginGrants.agentId, ALL));
  await database
    .delete(agentProfiles)
    .where(inArray(agentProfiles.agentId, ALL));
  await database.delete(agents).where(inArray(agents.id, ALL));
}

async function seed() {
  for (const id of ALL) {
    const name = id === ASKER ? `Fanout Asker ${suite}` : said.get(id);
    await database.insert(agents).values({
      id,
      name: name ?? id,
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      title: name ?? id,
      roleDescription: "Help",
      avatarSeed: id,
      visibility: "public",
    });
  }
  // The asking Bot has been given all four. A grant is what the cap is applied on top of, not what
  // this is about.
  for (const target of ASKED) {
    await database.insert(pluginGrants).values({
      kind: "bot",
      ref: target,
      agentId: ASKER,
      grantedBy: "test",
    });
  }
}

beforeEach(async () => {
  setEdition("team");
  await clean();
  await runAsTenant(PERSON, seed);
});

afterEach(() => setEdition("team"));

afterAll(async () => {
  await clean();
  await database.$client.end({ timeout: 5 });
});

describe("how many Bots one turn may address", () => {
  test("three arrive and the fourth is refused, in the cap's own words", async () => {
    const run = `run-${suite}-in-a-row`;
    const tool = toolFor(run);

    const answers: string[] = [];
    for (const [index, id] of ASKED.entries()) {
      answers.push(
        String(
          await tool.execute({
            bot: said.get(id),
            task: `look at item ${index}`,
          }),
        ),
      );
    }

    expect(answers.slice(0, 3).every(handedOver)).toBe(true);
    expect(answers[3]).not.toStartWith(HANDED_OVER);
    expect(capRefusal(answers[3])).toBe(true);

    // Three rows, and the fourth Bot is not among them: the refusal said nothing was sent, and
    // nothing was.
    const hops = await hopsOf(run);
    expect(hops).toHaveLength(3);
  });

  /*
   * The claim the advisory lock in `queue.offer` exists for, asked the way a model asks it.
   *
   * Four tool calls emitted in one turn run at once. Counting outside the write lets every one of
   * them pass; this is the test that fails if that separation ever comes back.
   */
  test("four asked at once are three hops, not four", async () => {
    const run = `run-${suite}-at-once`;
    const tool = toolFor(run);

    const answers = await Promise.all(
      ASKED.map((id, index) =>
        tool.execute({ bot: said.get(id), task: `look at item ${index}` }),
      ),
    );

    expect(answers.filter(handedOver)).toHaveLength(3);
    expect(answers.filter(capRefusal)).toHaveLength(1);
    expect(await hopsOf(run)).toHaveLength(3);
  });

  /*
   * The budget is the turn's, not the Bot's and not the person's.
   *
   * Read the other way, one busy turn would leave the person's assistant unable to ask anybody
   * anything again until a restart — a cap that reads as the deployment being broken.
   */
  test("the next turn gets its own three", async () => {
    const spent = toolFor(`run-${suite}-spent`);
    for (const [index, id] of ASKED.entries()) {
      await spent.execute({ bot: said.get(id), task: `look at item ${index}` });
    }

    const next = toolFor(`run-${suite}-next`);
    const answer = String(
      await next.execute({
        bot: said.get(ASKED[3]),
        task: "the fourth one, next turn",
      }),
    );

    expect(handedOver(answer)).toBe(true);
    expect(await hopsOf(`run-${suite}-next`)).toHaveLength(1);
  });

  /*
   * A hop that did not happen is invisible in the transcript, so the trail is the only place the
   * person can find it later. It has to name the Bot and say the cap was the reason.
   */
  test("the refusal is on the trail, with the cap as its reason", async () => {
    const run = `run-${suite}-trail`;
    const tool = toolFor(run);
    for (const [index, id] of ASKED.entries()) {
      await tool.execute({ bot: said.get(id), task: `look at item ${index}` });
    }

    const rows = await database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "agent.handoff_refused"),
          eq(auditEvents.targetId, ASKER),
          sql`${auditEvents.payload}->>'run' = ${run}`,
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      bot: ASKER,
      reason: "fanout_cap",
      target: said.get(ASKED[3]),
    });
  });
});
