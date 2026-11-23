import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { TURN_ARTIFACTS_EVENT } from "../../shared/turn-artifacts";
import { runsIsolated } from "../src/agents/isolation";
import type { AgentActor } from "../src/agents/profile-types";
import {
  type ArtifactAccessDeps,
  type ArtifactScope,
  resolveArtifactAccess,
  resolveArtifactAppAccess,
} from "../src/computer/artifact-access";
import { createArtifactAccessDeps } from "../src/computer/artifact-access-store";
import {
  botOwnership,
  createComputerSeatResolver,
} from "../src/computer/computer-key";
import { createDatabase } from "../src/db/client";
import { asPlatform } from "../src/tenant/context";
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
const dead = id("dead");
const botGone = id("bot-gone");
const botPrivate = id("bot-private");
const botIsolated = id("bot-isolated");

const ownerThread = id("thread-owner");
const elsewhereThread = id("thread-elsewhere");
const aloneThread = id("thread-alone");
const memberThread = id("thread-member");
const deadThread = id("thread-dead");

const run = id("run");
const deliveredRun = id("run-delivered");
const elsewhereRun = id("run-elsewhere");
const aloneRun = id("run-alone");
const cardRun = id("run-card");
const forgedRun = id("run-forged");
const privateRun = id("run-private");
const goneRun = id("run-gone");
const deadRun = id("run-dead");
const isolatedRun = id("run-isolated");
const cardForgedRun = id("run-card-forged");
const cardGoneRun = id("run-card-gone");
const appsRun = id("run-apps");
const appsOnlyRun = id("run-apps-only");
const APPS = [{ port: 8000, path: "/", title: "Dash" }];

const SPECIAL = "报告 #1?.pptx";
const as = (actor: string): AgentActor => ({ id: actor, role: "user" });

const custom = (name: string, value: unknown) => ({
  type: "CUSTOM",
  name,
  value,
});
const artifacts = (seat: string, paths: string[], botId = bot) =>
  custom(TURN_ARTIFACTS_EVENT, {
    botId,
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
let appsTask = "";
let forgedTask = "";
let goneTask = "";

async function seedRun(
  thread: string,
  tenant: string,
  runId: string,
  events: unknown[],
  /** The employee that ran it: a run is only read as that employee. */
  agent: string = bot,
) {
  await fixtures`insert into thread_runs (id, tenant_id, thread_id, agent_id) values (${runId}, ${tenant}, ${thread}, ${agent})`;
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
  // The deployment's own resolver, asked about Bots as `platform` like `index.ts` does.
  const seats = createComputerSeatResolver({
    runsIsolated: (botId) => asPlatform(() => runsIsolated(appPool, botId)),
    bot: (botId) => asPlatform(() => botOwnership(appPool)(botId)),
    canIsolate: true,
  });
  deps = createArtifactAccessDeps(appPool, (botId, personId) =>
    seats.seatFor(botId, personId),
  );

  for (const user of [owner, member, outsider])
    await fixtures`insert into users (id, email) values (${user}, ${`${user}@example.test`})`;
  for (const agent of [bot, botGone, botPrivate, botIsolated])
    await fixtures`insert into agents (id, name, type, configuration, tenant_id) values (${agent}, ${agent}, 'built_in', '{}'::jsonb, 'system')`;
  // A catalogue employee everybody sees, one that was deleted, and the owner's own private one.
  await fixtures`insert into agent_profiles (agent_id, tenant_id, title, role_description, avatar_seed, visibility) values (${bot}, 'system', 't', 'r', 'a', 'public')`;
  await fixtures`insert into agent_profiles (agent_id, tenant_id, title, role_description, avatar_seed, visibility, deleted_at) values (${botGone}, 'system', 't', 'r', 'a', 'public', now())`;
  await fixtures`insert into agent_profiles (agent_id, tenant_id, owner_user_id, title, role_description, avatar_seed, visibility, isolated) values (${botIsolated}, ${owner}, ${owner}, 't', 'r', 'a', 'private', true)`;
  await fixtures`insert into agent_profiles (agent_id, tenant_id, owner_user_id, title, role_description, avatar_seed, visibility) values (${botPrivate}, ${owner}, ${owner}, 't', 'r', 'a', 'private')`;

  // A group chat of two people, stamped `team`, with one Bot. The owner asked; the member did not.
  await fixtures`insert into channels (id, tenant_id, name, description) values (${group}, 'team', 'g', '')`;
  for (const person of [owner, member])
    await fixtures`insert into channel_memberships (channel_id, user_id, tenant_id) values (${group}, ${person}, 'team')`;
  for (const agent of [bot, botGone, botPrivate, botIsolated])
    await fixtures`insert into channel_agents (channel_id, agent_id, tenant_id) values (${group}, ${agent}, 'team')`;
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
      agentId: bot,
      deliverable: {
        kind: "deliverable",
        workspaceFiles: ["final/summary.md"],
      },
    }),
  ]);

  await seedRun(ownerThread, owner, appsRun, [
    artifacts(`person:${owner}`, []),
    custom("delivery.delivered", {
      taskId: randomUUID(),
      eventId: randomUUID(),
      agentId: bot,
      deliverable: { kind: "deliverable", apps: APPS },
    }),
  ]);
  // Only a program was delivered and no file changed, so no turn announced a seat.
  await seedRun(ownerThread, owner, appsOnlyRun, [
    custom("delivery.delivered", {
      taskId: randomUUID(),
      eventId: randomUUID(),
      agentId: bot,
      deliverable: { kind: "deliverable", apps: APPS },
    }),
  ]);
  await seedRun(ownerThread, owner, forgedRun, [
    artifacts(`person:${outsider}`, ["secret.md"]),
  ]);
  await seedRun(
    ownerThread,
    owner,
    privateRun,
    [artifacts(`person:${owner}`, ["private.md"], botPrivate)],
    botPrivate,
  );
  await seedRun(
    ownerThread,
    owner,
    isolatedRun,
    [artifacts(`bot:${botIsolated}`, ["iso.md"], botIsolated)],
    botIsolated,
  );
  await seedRun(
    ownerThread,
    owner,
    goneRun,
    [artifacts(`person:${owner}`, ["gone.md"], botGone)],
    botGone,
  );

  // A group chat that was deleted after the run.
  await fixtures`insert into channels (id, tenant_id, name, description, deleted_at) values (${dead}, 'team', 'd', '', now())`;
  for (const person of [owner, member])
    await fixtures`insert into channel_memberships (channel_id, user_id, tenant_id) values (${dead}, ${person}, 'team')`;
  await fixtures`insert into channel_agents (channel_id, agent_id, tenant_id) values (${dead}, ${bot}, 'team')`;
  await fixtures`insert into threads (id, tenant_id, agent_id) values (${deadThread}, ${owner}, ${bot})`;
  await fixtures`insert into group_bot_threads (owner_user_id, channel_id, agent_id, thread_id, tenant_id) values (${owner}, ${dead}, ${bot}, ${deadThread}, 'team')`;
  await seedRun(deadThread, owner, deadRun, [
    artifacts(`person:${owner}`, ["out/deck.pptx"]),
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
  await seedRun(memberThread, member, cardForgedRun, [
    artifacts(`person:${outsider}`, ["card/out.pptx"]),
  ]);
  await seedRun(memberThread, member, cardGoneRun, [
    artifacts(`person:${member}`, ["card/out.pptx"], botGone),
  ]);
  const [forged] = await fixtures<{ id: string }[]>`
    insert into tasks (tenant_id, title, source, executor_agent_id, run_ref, deliverable_ref)
    values (${member}, 'forged', 'chat', ${bot}, ${cardForgedRun},
            ${fixtures.json({ kind: "deliverable", workspaceFiles: ["card/out.pptx"] })})
    returning id`;
  forgedTask = forged?.id ?? "";
  const [gone] = await fixtures<{ id: string }[]>`
    insert into tasks (tenant_id, title, source, executor_agent_id, run_ref, deliverable_ref)
    values (${member}, 'gone', 'chat', ${botGone}, ${cardGoneRun},
            ${fixtures.json({ kind: "deliverable", workspaceFiles: ["card/out.pptx"] })})
    returning id`;
  goneTask = gone?.id ?? "";
  // A card that lists a running program and no files at all.
  const [withApp] = await fixtures<{ id: string }[]>`
    insert into tasks (tenant_id, title, source, executor_agent_id, run_ref, deliverable_ref)
    values (${member}, 'app', 'chat', ${bot}, ${cardRun},
            ${fixtures.json({ kind: "deliverable", apps: APPS })})
    returning id`;
  appsTask = withApp?.id ?? "";
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
  await fixtures`delete from threads where id in ${fixtures([ownerThread, elsewhereThread, aloneThread, memberThread, deadThread])}`;
  await fixtures`delete from channels where id in ${fixtures([group, elsewhere, alone, dead])}`;
  await fixtures`delete from agent_profiles where agent_id in ${fixtures([bot, botGone, botPrivate, botIsolated])}`;
  await fixtures`delete from agents where id in ${fixtures([bot, botGone, botPrivate, botIsolated])}`;
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

  test("a run that names somebody else's computer opens nothing, in a chat or on a card", async () => {
    expect(
      await ask(member, "secret.md", { channel: group, run: forgedRun }),
    ).toBeNull();
    expect(await ask(member, "card/out.pptx", { task: forgedTask })).toBeNull();
  });

  test("an employee who is the owner's own private one can still be fetched from by the group", async () => {
    const access = await ask(
      member,
      "private.md",
      { channel: group, run: privateRun },
      botPrivate,
    );
    expect(access).not.toBeNull();
    expect(access?.seat.key).toEqual({ kind: "person", personId: owner });
  });

  test("a deleted employee opens nothing, in a chat or on a card", async () => {
    expect(
      await ask(member, "gone.md", { channel: group, run: goneRun }, botGone),
    ).toBeNull();
    expect(
      await ask(member, "card/out.pptx", { task: goneTask }, botGone),
    ).toBeNull();
  });

  test("a deleted conversation opens nothing", async () => {
    expect(
      await ask(member, "out/deck.pptx", { channel: dead, run: deadRun }),
    ).toBeNull();
    expect(
      await ask(owner, "out/deck.pptx", { channel: dead, run: deadRun }),
    ).toBeNull();
  });

  test("the owner's isolated employee, whose seat is its own computer, can be fetched from by the group", async () => {
    const access = await ask(
      member,
      "iso.md",
      { channel: group, run: isolatedRun },
      botIsolated,
    );
    expect(access).not.toBeNull();
    expect(access?.seat.key).toEqual({ kind: "bot", botId: botIsolated });
  });

  test("an isolated employee's run that names a person's computer opens nothing", async () => {
    // the run says `person:owner`; the resolver says `bot:<id>`
    await seedRun(ownerThread, owner, id("run-isolated-forged"), [
      artifacts(`person:${owner}`, ["iso.md"], botIsolated),
    ]);
    expect(
      await ask(
        member,
        "iso.md",
        { channel: group, run: id("run-isolated-forged") },
        botIsolated,
      ),
    ).toBeNull();
  });

  const askApp = (actor: string, port: number, scope: ArtifactScope) =>
    resolveArtifactAppAccess(
      { actor: as(actor), botId: bot, port, scope },
      deps,
    );

  test("a card that lists a program opens that port and no other", async () => {
    expect(await askApp(member, 8000, { task: appsTask })).not.toBeNull();
    expect(await askApp(member, 8001, { task: appsTask })).toBeNull();
    expect(await askApp(outsider, 8000, { task: appsTask })).toBeNull();
    // The card lists no files, so it opens no folder either.
    expect(await ask(member, "card/out.pptx", { task: appsTask })).toBeNull();
  });

  test("a group's run that delivered a program opens that port to a member and no other", async () => {
    const scope = { channel: group, run: appsRun };
    expect(await askApp(member, 8000, scope)).not.toBeNull();
    expect(await askApp(member, 8001, scope)).toBeNull();
    expect(await askApp(outsider, 8000, scope)).toBeNull();
    expect(
      await askApp(member, 8000, { channel: group, run: deliveredRun }),
    ).toBeNull();
  });

  test("a run that delivered only a program, with no file changed, still opens that port", async () => {
    const scope = { channel: group, run: appsOnlyRun };
    const seat = await askApp(member, 8000, scope);
    expect(seat?.seat.key).toEqual((await deps.seatFor(bot, owner)).key);
    expect(await askApp(member, 8001, scope)).toBeNull();
    expect(await askApp(outsider, 8000, scope)).toBeNull();
    // A folder still needs a turn that listed it.
    expect(await ask(member, "final/summary.md", scope)).toBeNull();
  });
});
