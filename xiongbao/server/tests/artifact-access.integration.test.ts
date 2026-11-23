import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { TURN_ARTIFACTS_EVENT } from "../../shared/turn-artifacts";
import type { AgentActor } from "../src/agents/profile-types";
import {
  type ArtifactAccessDeps,
  type ArtifactScope,
  resolveArtifactAccess,
} from "../src/computer/artifact-access";
import { createArtifactAccessDeps } from "../src/computer/artifact-access-store";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Who may download which workspace file, against a real database and its row security.
 *
 * The rows are the shapes the product writes: a group chat is stamped `team` with a membership per
 * person, its Bots' threads are filed under the person who asked, and a thread's runs and events are
 * that person's own. The code under test connects as the application role, so what it can see is what
 * row security lets that member see; fixtures are written through a role that bypasses it
 * (`TEST_DATABASE_BYPASS_URL`, the way the approval suites write what no app policy admits), so
 * without it this is skipped.
 */
const bypass = process.env.TEST_DATABASE_BYPASS_URL?.trim();

const suite = randomUUID().slice(0, 8);
const id = (name: string) => `${name}-${suite}`;

const owner = id("owner");
const member = id("member");
const outsider = id("outsider");
const bot = id("bot");
const group = id("group");
const elsewhere = id("elsewhere");
const alone = id("alone");

const ownerThread = id("thread-owner");
const elsewhereThread = id("thread-elsewhere");
const aloneThread = id("thread-alone");
const memberThread = id("thread-member");

const run = id("run");
const deliveredRun = id("run-delivered");
const elsewhereRun = id("run-elsewhere");
const aloneRun = id("run-alone");
const cardRun = id("run-card");

const SPECIAL = "报告 #1?.pptx";
const as = (actor: string): AgentActor => ({ id: actor, role: "user" });

const custom = (name: string, value: unknown) => ({
  type: "CUSTOM",
  name,
  value,
});
const artifacts = (seat: string, paths: string[]) =>
  custom(TURN_ARTIFACTS_EVENT, {
    botId: bot,
    seat,
    files: paths.map((path) => ({
      path,
      bytes: 3,
      modifiedMs: 1,
      change: "new",
    })),
    scanned: paths.length,
    scanTruncated: false,
    omitted: 0,
  });

let deps: ArtifactAccessDeps;
let appPool: ReturnType<typeof createDatabase>;
let fixtures: postgres.Sql;
let taskId = "";
let strangerTask = "";

async function seedRun(
  thread: string,
  tenant: string,
  runId: string,
  events: unknown[],
) {
  await fixtures`insert into thread_runs (id, tenant_id, thread_id, agent_id) values (${runId}, ${tenant}, ${thread}, ${bot})`;
  let seq = 0;
  for (const event of events) {
    seq += 1;
    await fixtures`insert into thread_run_events (tenant_id, thread_id, run_id, seq, event) values (${tenant}, ${thread}, ${runId}, ${seq}, ${fixtures.json(event as never)})`;
  }
}

beforeAll(async () => {
  if (!bypass) return;
  const url = new URL(bypass);
  url.pathname = new URL(testDatabaseUrl()).pathname;
  fixtures = postgres(url.href, { max: 1, onnotice: () => {} });
  appPool = createDatabase(testDatabaseUrl(), TEST_POOL);
  deps = createArtifactAccessDeps(appPool);

  for (const user of [owner, member, outsider])
    await fixtures`insert into users (id, email) values (${user}, ${`${user}@example.test`})`;
  await fixtures`insert into agents (id, name, type, configuration, tenant_id) values (${bot}, ${bot}, 'built_in', '{}'::jsonb, 'system')`;

  // A group chat of two people, stamped `team`, with one Bot. The owner asked; the member did not.
  await fixtures`insert into channels (id, tenant_id, name, description) values (${group}, 'team', 'g', '')`;
  for (const person of [owner, member])
    await fixtures`insert into channel_memberships (channel_id, user_id, tenant_id) values (${group}, ${person}, 'team')`;
  await fixtures`insert into channel_agents (channel_id, agent_id, tenant_id) values (${group}, ${bot}, 'team')`;
  await fixtures`insert into threads (id, tenant_id, agent_id) values (${ownerThread}, ${owner}, ${bot})`;
  await fixtures`insert into group_bot_threads (owner_user_id, channel_id, agent_id, thread_id, tenant_id) values (${owner}, ${group}, ${bot}, ${ownerThread}, 'team')`;
  await seedRun(ownerThread, owner, run, [
    { type: "RUN_STARTED", threadId: ownerThread, runId: run },
    artifacts(`person:${owner}`, [SPECIAL, "out/deck.pptx", "Report.PPTX"]),
    { type: "RUN_FINISHED", threadId: ownerThread, runId: run },
  ]);
  await seedRun(ownerThread, owner, deliveredRun, [
    artifacts(`person:${owner}`, ["scratch.txt"]),
    custom("delivery.delivered", {
      taskId: randomUUID(),
      eventId: randomUUID(),
      deliverable: {
        kind: "deliverable",
        workspaceFiles: ["final/summary.md"],
      },
    }),
  ]);

  // Another group the member is not in, with a run of its own.
  await fixtures`insert into channels (id, tenant_id, name, description) values (${elsewhere}, 'team', 'e', '')`;
  await fixtures`insert into channel_memberships (channel_id, user_id, tenant_id) values (${elsewhere}, ${owner}, 'team')`;
  await fixtures`insert into channel_agents (channel_id, agent_id, tenant_id) values (${elsewhere}, ${bot}, 'team')`;
  await fixtures`insert into threads (id, tenant_id, agent_id) values (${elsewhereThread}, ${owner}, ${bot})`;
  await fixtures`insert into group_bot_threads (owner_user_id, channel_id, agent_id, thread_id, tenant_id) values (${owner}, ${elsewhere}, ${bot}, ${elsewhereThread}, 'team')`;
  await seedRun(elsewhereThread, owner, elsewhereRun, [
    artifacts(`person:${owner}`, ["secret.md", SPECIAL]),
  ]);

  // A person's own one-to-one conversation.
  await fixtures`insert into channels (id, tenant_id, name, description) values (${alone}, ${owner}, 'a', '')`;
  await fixtures`insert into channel_memberships (channel_id, user_id, tenant_id) values (${alone}, ${owner}, ${owner})`;
  await fixtures`insert into channel_agents (channel_id, agent_id, tenant_id) values (${alone}, ${bot}, ${owner})`;
  await fixtures`insert into threads (id, tenant_id, agent_id) values (${aloneThread}, ${owner}, ${bot})`;
  await fixtures`insert into intelligence_channel_mappings (user_id, channel_id, thread_id, tenant_id) values (${owner}, ${alone}, ${aloneThread}, ${owner})`;
  await seedRun(aloneThread, owner, aloneRun, [
    artifacts(`person:${owner}`, ["mine.md"]),
  ]);

  // A delivery card of the member's own, and one of the owner's.
  await fixtures`insert into threads (id, tenant_id, agent_id) values (${memberThread}, ${member}, ${bot})`;
  await seedRun(memberThread, member, cardRun, [
    artifacts(`person:${member}`, ["card/out.pptx"]),
  ]);
  const [mine] = await fixtures<{ id: string }[]>`
    insert into tasks (tenant_id, title, source, executor_agent_id, run_ref, deliverable_ref)
    values (${member}, 'mine', 'chat', ${bot}, ${cardRun},
            ${fixtures.json({ kind: "deliverable", workspaceFiles: ["card/out.pptx", SPECIAL] })})
    returning id`;
  taskId = mine?.id ?? "";
  const [theirs] = await fixtures<{ id: string }[]>`
    insert into tasks (tenant_id, title, source, executor_agent_id, run_ref, deliverable_ref)
    values (${owner}, 'theirs', 'chat', ${bot}, ${run},
            ${fixtures.json({ kind: "deliverable", workspaceFiles: ["out/deck.pptx"] })})
    returning id`;
  strangerTask = theirs?.id ?? "";
});

afterAll(async () => {
  if (!bypass) return;
  const people = [owner, member, outsider];
  await fixtures`delete from tasks where tenant_id in ${fixtures(people)}`;
  await fixtures`delete from threads where id in ${fixtures([ownerThread, elsewhereThread, aloneThread, memberThread])}`;
  await fixtures`delete from channels where id in ${fixtures([group, elsewhere, alone])}`;
  await fixtures`delete from agents where id = ${bot}`;
  await fixtures`delete from users where id in ${fixtures(people)}`;
  await fixtures.end({ timeout: 5 });
  await appPool.$client.close();
});

const ask = (actor: string, path: string, scope: ArtifactScope, botId = bot) =>
  resolveArtifactAccess({ actor: as(actor), botId, path, scope }, deps);

describe.skipIf(!bypass)("workspace file access, against the database", () => {
  const inGroup: ArtifactScope = { channel: group, run };

  test("the member of a group chat gets the seat of the person who asked", async () => {
    const access = await ask(member, "out/deck.pptx", inGroup);
    expect(access).not.toBeNull();
    expect(access?.seat.key).toEqual({ kind: "person", personId: owner });
    expect(access?.seat.botId).toBe(bot);
  });

  test("the person who asked gets it too", async () => {
    expect(await ask(owner, "out/deck.pptx", inGroup)).not.toBeNull();
  });

  test("a person outside the group is refused", async () => {
    expect(await ask(outsider, "out/deck.pptx", inGroup)).toBeNull();
  });

  test("a run of another conversation is refused, whoever asks", async () => {
    // the member is in `group`, and `elsewhereRun` announced the very same special name
    expect(
      await ask(member, "secret.md", { channel: group, run: elsewhereRun }),
    ).toBeNull();
    expect(
      await ask(member, SPECIAL, { channel: group, run: elsewhereRun }),
    ).toBeNull();
    expect(
      await ask(member, "secret.md", { channel: elsewhere, run: elsewhereRun }),
    ).toBeNull();
    expect(
      await ask(owner, "out/deck.pptx", { channel: elsewhere, run }),
    ).toBeNull();
  });

  test("a file the run never announced is refused", async () => {
    expect(await ask(member, "not-announced.pptx", inGroup)).toBeNull();
    expect(await ask(member, "secret.md", inGroup)).toBeNull();
  });

  test("a run that does not exist is refused", async () => {
    expect(
      await ask(member, "out/deck.pptx", { channel: group, run: id("nope") }),
    ).toBeNull();
  });

  test("a Bot that is not in the conversation is refused", async () => {
    expect(
      await ask(member, "out/deck.pptx", inGroup, id("other-bot")),
    ).toBeNull();
  });

  test("a name with ?, #, spaces and Chinese characters matches as written", async () => {
    const access = await ask(member, SPECIAL, inGroup);
    expect(access).not.toBeNull();
    expect(access?.seat.key).toEqual({ kind: "person", personId: owner });
    // no case folding, and nothing cut off at the `?` or `#`
    expect(await ask(member, "report.pptx", inGroup)).toBeNull();
    expect(await ask(member, "Report.PPTX", inGroup)).not.toBeNull();
    expect(await ask(member, "报告 ", inGroup)).toBeNull();
    expect(await ask(member, "报告 #1", inGroup)).toBeNull();
  });

  test("a delivered file is reached through the seat the same run announced", async () => {
    const access = await ask(member, "final/summary.md", {
      channel: group,
      run: deliveredRun,
    });
    expect(access).not.toBeNull();
    expect(access?.seat.key).toEqual({ kind: "person", personId: owner });
  });

  test("a person's own conversation answers to them alone", async () => {
    const own: ArtifactScope = { channel: alone, run: aloneRun };
    expect(await ask(owner, "mine.md", own)).not.toBeNull();
    expect(await ask(member, "mine.md", own)).toBeNull();
    expect(await ask(outsider, "mine.md", own)).toBeNull();
  });

  test("a card of the person's own is reachable by task", async () => {
    const access = await ask(member, SPECIAL, { task: taskId });
    expect(access).not.toBeNull();
    expect(access?.seat.key).toEqual({ kind: "person", personId: member });
    expect(await ask(member, "card/out.pptx", { task: taskId })).not.toBeNull();
    expect(await ask(member, "card/other.pptx", { task: taskId })).toBeNull();
    expect(
      await ask(member, "card/out.pptx", { task: taskId }, id("x")),
    ).toBeNull();
  });

  test("somebody else's card, and a task that is not an id, are refused", async () => {
    expect(
      await ask(member, "out/deck.pptx", { task: strangerTask }),
    ).toBeNull();
    expect(await ask(outsider, "card/out.pptx", { task: taskId })).toBeNull();
    expect(
      await ask(member, "card/out.pptx", { task: "not-a-uuid" }),
    ).toBeNull();
  });
});
