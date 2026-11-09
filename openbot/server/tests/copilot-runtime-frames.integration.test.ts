import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { buildAGUITextResponse } from "@copilotkit/aimock";
import { AGUIMock } from "@copilotkit/aimock/agui";
import { ɵGLOBAL_STORE } from "@copilotkit/runtime/v2";
import { eq, inArray } from "drizzle-orm";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { createStallGuard } from "../src/channels/stall-guard";
import { loadConfig } from "../src/config";
import { type IdentifyActor, mountCopilotRuntime } from "../src/copilot";
import { createCredentialStore, resolveModelApiKey } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  threadRunEvents,
  threadRuns,
  threads,
  users,
} from "../src/db/schema";
import { SYSTEM_TENANT, TEAM_TENANT } from "../src/db/schema/tenant";
import { createPluginStore } from "../src/plugins/store";
import { grantedTools } from "../src/plugins/tools";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/*
 * G01-E P16f: the CopilotKit runtime through the wiring `index.ts` gives it — `mountCopilotRuntime`
 * over the real roster loader, the real thread runner, the vault's deployment-key read and the plugin
 * store's grants, mounted into `createApp` — answers every route in the frame of the person asking.
 *
 * The runtime is not behind `requireUser`: it resolves its own actor, so nothing else opens a frame
 * for `/info`, `/agent/:id/connect` or the thread endpoints. With the `system` fallback gone each of
 * those reads threw ("no tenant frame") and answered 500, which took the chat surface down for every
 * person, and the deployment check that reads `/info` signed out with it. Before the fallback went
 * they answered as `system`: the wrong roster, and nobody's threads.
 *
 * A request nobody signed in to is `{ id: "" }` — the actor `index.ts`'s `identifyActor` answers
 * then. It may read `/info`, which lists the deployment's own catalogue and nothing else.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const alice = `rtf-alice-${suite}`;
const bob = `rtf-bob-${suite}`;
const bots = {
  // Alice's own: a remote Bot she runs a turn on, and a built-in one, which needs the model key.
  aliceRemote: `rtf-alice-remote-${suite}`,
  aliceBuiltIn: `rtf-alice-builtin-${suite}`,
  // Public, but stamped with Alice's tenant: nobody else's frame shows it.
  alicePublic: `rtf-alice-public-${suite}`,
  // Shared with the whole team: every person sees it, nobody signed out does.
  team: `rtf-team-${suite}`,
  // The deployment's catalogue: everybody, signed in or not.
  catalogue: `rtf-catalogue-${suite}`,
};
const ANONYMOUS = { id: "", role: "user" } as const;
const PERSON_HEADER = "x-rtf-person";

const remote = new AGUIMock();
let remoteUrl = "";
let app: ReturnType<typeof createApp>;
/** The runner the boot-time app is mounted over; the restart below replaces it with a fresh one. */
const bootRunner = new PostgresAgentRunner(database);
const threadIds: string[] = [];

/** Who is asking: the header names a signed-in person, and no header is nobody (see index.ts). */
const identifyActor: IdentifyActor = async (request) => {
  const person = request.headers.get(PERSON_HEADER);
  return person === alice || person === bob
    ? { id: person, role: "user" }
    : ANONYMOUS;
};

async function seedBot(input: {
  id: string;
  tenant: string;
  owner: string | null;
  visibility: "public" | "private";
  type: "built_in" | "remote_ag_ui";
}) {
  const write = async () => {
    await database.insert(agents).values({
      id: input.id,
      tenantId: input.tenant,
      name: `Frames ${input.id}`,
      type: input.type,
      configuration:
        input.type === "built_in"
          ? { systemPrompt: "You help." }
          : { endpoint: remoteUrl },
    });
    await database.insert(agentProfiles).values({
      agentId: input.id,
      tenantId: input.tenant,
      ownerUserId: input.owner,
      title: "Frames",
      roleDescription: "Answers in the frames test",
      avatarSeed: input.id,
      visibility: input.visibility,
    });
  };
  // Each row written the way its stamp is written in production: a person's in their own frame, the
  // catalogue in the deployment's, and a team Bot by the operator path.
  if (input.tenant === TEAM_TENANT) return runAsTenant("platform", write);
  return runAsTenant(input.tenant, write);
}

beforeAll(async () => {
  remote.onPredicate(
    () => true,
    buildAGUITextResponse("frames answer") as never,
  );
  remoteUrl = await remote.start();

  await runAsTenant("platform", () =>
    database.insert(users).values([
      { id: alice, email: `${alice}@example.test`, name: "Alice" },
      { id: bob, email: `${bob}@example.test`, name: "Bob" },
    ]),
  );
  await seedBot({
    id: bots.aliceRemote,
    tenant: alice,
    owner: alice,
    visibility: "private",
    type: "remote_ag_ui",
  });
  await seedBot({
    id: bots.aliceBuiltIn,
    tenant: alice,
    owner: alice,
    visibility: "private",
    type: "built_in",
  });
  await seedBot({
    id: bots.alicePublic,
    tenant: alice,
    owner: alice,
    visibility: "public",
    type: "remote_ag_ui",
  });
  await seedBot({
    id: bots.team,
    tenant: TEAM_TENANT,
    owner: alice,
    visibility: "public",
    type: "remote_ag_ui",
  });
  await seedBot({
    id: bots.catalogue,
    tenant: SYSTEM_TENANT,
    owner: null,
    visibility: "public",
    type: "remote_ag_ui",
  });

  app = mountApp(bootRunner);
});

/**
 * `createApp` with the runtime mounted over `runner`, as `index.ts` mounts it. Called once per process
 * lifetime the file models: at boot, and again over a fresh runner to model a restart (G01-E P18).
 */
function mountApp(runner: PostgresAgentRunner): ReturnType<typeof createApp> {
  const config = loadConfig(testEnvironment());
  const auditStore = createAuditStore(database);
  const credentialStore = createCredentialStore(database);
  const pluginStore = createPluginStore({
    database,
    auditStore,
    credentials: credentialStore,
    encryptionKey: ENCRYPTION_KEY,
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  });
  const mounted = mountCopilotRuntime(
    config,
    createActorAgentResolver({
      model: { provider: "openai", defaultModel: "gpt-frames-test" },
      // The loader exactly as index.ts builds it, scoped by nothing but the runtime itself.
      loadAgents: createRuntimeAgentLoader(database),
      resolveModelApiKey: () =>
        resolveModelApiKey({
          encryptionKey: ENCRYPTION_KEY,
          reader: credentialStore,
          provider: "openai",
          keyId: `rtf-deployment-key-${suite}`,
          environment: {},
        }),
      stallGuard: createStallGuard({ stallMs: 0 }),
      // What each Bot holds, read through the plugin store as index.ts reads it.
      loadToolsForActor: (actorId) => async (botId) =>
        grantedTools({ store: pluginStore, botId, actorId }),
      loadVendors: async () => [],
    }),
    async (request) => {
      const actor = await identifyActor(request);
      if (!actor.id)
        throw new Error("A CopilotKit run requires a signed-in user.");
      return { id: actor.id, name: actor.id };
    },
    identifyActor,
    { localRunner: runner },
  );
  const args: Parameters<typeof createApp> = [
    config,
    undefined, // auth
    undefined, // roleRepository
    undefined, // auditReader
    undefined, // credentialService
    undefined, // packageStatusReader
    mounted.handler,
  ];
  return createApp(...args);
}

afterAll(async () => {
  await runAsTenant("platform", async () => {
    if (threadIds.length > 0)
      await database.delete(threads).where(inArray(threads.id, threadIds));
    await database
      .delete(agents)
      .where(inArray(agents.id, Object.values(bots)));
    await database.delete(users).where(inArray(users.id, [alice, bob]));
  });
  await remote.stop();
  await database.$client.close();
});

const as = (person: string | null) =>
  person ? { [PERSON_HEADER]: person } : ({} as Record<string, string>);

async function info(person: string | null) {
  const response = await app.request(
    "http://openbot.local/api/copilotkit/info",
    {
      headers: as(person),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    agents?: Record<string, unknown>;
  } | null;
  return {
    status: response.status,
    roster: Object.keys(body?.agents ?? {}),
  };
}

function runInput(threadId: string) {
  return {
    threadId,
    runId: randomUUID(),
    state: {},
    messages: [{ id: randomUUID(), role: "user", content: "hello" }],
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

async function post(
  path: string,
  person: string | null,
  body: unknown,
  on: ReturnType<typeof createApp> = app,
) {
  const response = await on.request(`http://openbot.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...as(person) },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function get(
  path: string,
  person: string | null,
  on: ReturnType<typeof createApp> = app,
) {
  const response = await on.request(`http://openbot.local${path}`, {
    headers: as(person),
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null,
  };
}

async function eventually<T>(read: () => Promise<T[]>): Promise<T[]> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const rows = await read();
    if (rows.length > 0 || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The thread ids a `/threads` answer lists. */
function threadIdsIn(body: Record<string, unknown> | null): string[] {
  return ((body?.threads ?? []) as { id: string }[]).map((thread) => thread.id);
}

describe("the runtime answers in the frame of the person asking (G01-E P16f)", () => {
  test("a signed-in person's /info is their own roster", async () => {
    const forAlice = await info(alice);
    expect(forAlice.status).toBe(200);
    expect(forAlice.roster).toEqual(
      expect.arrayContaining([
        bots.aliceRemote,
        bots.aliceBuiltIn,
        bots.alicePublic,
        bots.team,
        bots.catalogue,
      ]),
    );

    const forBob = await info(bob);
    expect(forBob.status).toBe(200);
    expect(forBob.roster).toEqual(
      expect.arrayContaining([bots.team, bots.catalogue]),
    );
    for (const own of [bots.aliceRemote, bots.aliceBuiltIn, bots.alicePublic])
      expect(forBob.roster).not.toContain(own);
  });

  test("signed out, /info is the deployment's catalogue and nothing that belongs to anybody", async () => {
    const signedOut = await info(null);
    expect(signedOut.status).toBe(200);
    expect(signedOut.roster).toContain(bots.catalogue);
    for (const somebodys of [
      bots.aliceRemote,
      bots.aliceBuiltIn,
      bots.alicePublic,
      bots.team,
    ])
      expect(signedOut.roster).not.toContain(somebodys);
    // Every Bot named there is a `system` row: no person's, and no team's.
    const stamps = await runAsTenant("platform", () =>
      database
        .select({ id: agents.id, tenantId: agents.tenantId })
        .from(agents)
        .where(inArray(agents.id, signedOut.roster)),
    );
    expect(stamps.length).toBe(signedOut.roster.length);
    expect(new Set(stamps.map((row) => row.tenantId))).toEqual(
      new Set([SYSTEM_TENANT]),
    );
  });

  test("signed out, everything but /info is refused rather than answered as somebody", async () => {
    const threadId = `rtf-thread-anon-${suite}`;
    expect(
      (
        await post(
          `/api/copilotkit/agent/${bots.catalogue}/connect`,
          null,
          runInput(threadId),
        )
      ).status,
    ).toBe(401);
    expect(
      (await get(`/api/copilotkit/threads?agentId=${bots.catalogue}`, null))
        .status,
    ).toBe(401);
    expect(
      (await get(`/api/copilotkit/threads/${threadId}/messages`, null)).status,
    ).toBe(401);
  });

  test("a person's turn, then their threads, their messages and their connect — and nobody else's", async () => {
    const threadId = `rtf-thread-${suite}`;
    threadIds.push(threadId);
    const ran = await post(
      `/api/copilotkit/agent/${bots.aliceRemote}/run`,
      alice,
      runInput(threadId),
    );
    expect(ran.status).toBe(200);
    expect(ran.text).toContain("RUN_FINISHED");

    // The write-through lands under Alice's tenant, not `system`'s. It is written after the stream
    // ends, on a macrotask of its own, so it is waited for rather than read once.
    const stamps = await eventually(() =>
      runAsTenant("platform", () =>
        database
          .select({ tenantId: threads.tenantId })
          .from(threads)
          .where(inArray(threads.id, [threadId])),
      ),
    );
    expect(stamps.map((row) => row.tenantId)).toEqual([alice]);

    const mine = await get(
      `/api/copilotkit/threads?agentId=${bots.aliceRemote}`,
      alice,
    );
    expect(mine.status).toBe(200);
    expect(threadIdsIn(mine.body)).toContain(threadId);

    const messages = await get(
      `/api/copilotkit/threads/${threadId}/messages`,
      alice,
    );
    expect(messages.status).toBe(200);
    expect(
      ((messages.body?.messages ?? []) as { content?: string }[]).some(
        (message) => message.content === "hello",
      ),
    ).toBe(true);

    const events = await get(
      `/api/copilotkit/threads/${threadId}/events`,
      alice,
    );
    expect(events.status).toBe(200);
    expect(((events.body?.events ?? []) as unknown[]).length).toBeGreaterThan(
      0,
    );

    const connected = await post(
      `/api/copilotkit/agent/${bots.aliceRemote}/connect`,
      alice,
      runInput(threadId),
    );
    expect(connected.status).toBe(200);
    expect(connected.text).toContain("RUN_STARTED");

    // Bob, signed in, asking about the same conversation: none of it is his.
    const his = await get(`/api/copilotkit/threads`, bob);
    expect(his.status).toBe(200);
    expect(threadIdsIn(his.body)).not.toContain(threadId);
    const hisMessages = await get(
      `/api/copilotkit/threads/${threadId}/messages`,
      bob,
    );
    expect(hisMessages.status).toBe(200);
    expect(hisMessages.body?.messages).toEqual([]);
    const hisEvents = await get(
      `/api/copilotkit/threads/${threadId}/events`,
      bob,
    );
    expect(hisEvents.status).toBe(200);
    expect(hisEvents.body?.events).toEqual([]);
    // And Alice's private Bot is not one he can connect to.
    expect(
      (
        await post(
          `/api/copilotkit/agent/${bots.aliceRemote}/connect`,
          bob,
          runInput(threadId),
        )
      ).status,
    ).toBe(404);
  });
});

/*
 * G01-E P17: a thread is its owner's on every runtime door, not only on the three thread endpoints.
 *
 * `/agent/:id/connect` replays a thread out of the process-wide in-memory store, and `/agent/:id/run`
 * continues one there, both by thread id alone. The Bot in the path is only the Bot: a person who can
 * see a Bot Alice also uses (the catalogue's, here) and has her thread id must get what an unknown
 * thread id gets, which is nothing.
 */
describe("a thread id that is not the caller's replays and continues nothing (G01-E P17)", () => {
  /** Alice's finished turn on her own Bot, written through to her tenant. */
  async function alicesThread(): Promise<string> {
    const threadId = `rtf-p17-${randomUUID()}`;
    threadIds.push(threadId);
    const ran = await post(
      `/api/copilotkit/agent/${bots.aliceRemote}/run`,
      alice,
      runInput(threadId),
    );
    expect(ran.status).toBe(200);
    expect(ran.text).toContain("RUN_FINISHED");
    await eventually(() =>
      runAsTenant(alice, () =>
        database
          .select({ id: threadRuns.id })
          .from(threadRuns)
          .where(eq(threadRuns.threadId, threadId)),
      ),
    );
    return threadId;
  }

  test("Bob connecting to a Bot he can see with Alice's thread id gets an empty stream; Alice's own connect still replays", async () => {
    const threadId = await alicesThread();

    const his = await post(
      `/api/copilotkit/agent/${bots.catalogue}/connect`,
      bob,
      runInput(threadId),
    );
    expect(his.status).toBe(200);
    // Exactly what an id nobody ever ran answers.
    const unknown = await post(
      `/api/copilotkit/agent/${bots.catalogue}/connect`,
      bob,
      runInput(`rtf-p17-never-${randomUUID()}`),
    );
    expect(unknown.status).toBe(200);
    expect(his.text).toBe(unknown.text);
    for (const leaked of ["RUN_STARTED", "frames answer", "hello", threadId])
      expect(his.text).not.toContain(leaked);

    const hers = await post(
      `/api/copilotkit/agent/${bots.aliceRemote}/connect`,
      alice,
      runInput(threadId),
    );
    expect(hers.status).toBe(200);
    expect(hers.text).toContain("RUN_STARTED");
    expect(hers.text).toContain("frames answer");
  });

  test("Bob running with Alice's thread id is refused: nothing is appended to her thread and none of it becomes his", async () => {
    const threadId = await alicesThread();
    const before = await get(
      `/api/copilotkit/threads/${threadId}/events`,
      alice,
    );
    const hersBefore = (before.body?.events ?? []) as unknown[];
    expect(hersBefore.length).toBeGreaterThan(0);

    const ran = await post(
      `/api/copilotkit/agent/${bots.catalogue}/run`,
      bob,
      runInput(threadId),
    );
    // Refused the way a run that could not start is: the stream ends before it began.
    for (const event of ["RUN_STARTED", "RUN_FINISHED", "frames answer"])
      expect(ran.text).not.toContain(event);
    // A write-through, had there been one, lands a macrotask after the stream ends.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Nothing of hers became readable to him by way of the run...
    const hisEvents = await get(
      `/api/copilotkit/threads/${threadId}/events`,
      bob,
    );
    expect(hisEvents.body?.events).toEqual([]);
    const hisMessages = await get(
      `/api/copilotkit/threads/${threadId}/messages`,
      bob,
    );
    expect(hisMessages.body?.messages).toEqual([]);
    expect(
      threadIdsIn((await get(`/api/copilotkit/threads`, bob)).body),
    ).not.toContain(threadId);
    const hisConnect = await post(
      `/api/copilotkit/agent/${bots.catalogue}/connect`,
      bob,
      runInput(threadId),
    );
    expect(hisConnect.text).not.toContain("RUN_STARTED");

    // ...nothing of his was stored against her thread...
    const runs = await runAsTenant("platform", () =>
      database
        .select({ tenantId: threadRuns.tenantId })
        .from(threadRuns)
        .where(eq(threadRuns.threadId, threadId)),
    );
    expect(runs.map((row) => row.tenantId)).toEqual([alice]);

    // ...and the thread is still hers, as it was.
    const after = await get(
      `/api/copilotkit/threads/${threadId}/events`,
      alice,
    );
    expect(after.body?.events).toEqual(hersBefore);
    expect(
      threadIdsIn(
        (
          await get(
            `/api/copilotkit/threads?agentId=${bots.aliceRemote}`,
            alice,
          )
        ).body,
      ),
    ).toContain(threadId);

    // Her own next turn on it still runs.
    const again = await post(
      `/api/copilotkit/agent/${bots.aliceRemote}/run`,
      alice,
      runInput(threadId),
    );
    expect(again.text).toContain("RUN_FINISHED");
    // And is written through to her thread, beside the first.
    const deadline = Date.now() + 3000;
    let hers: string[] = [];
    while (hers.length < 2 && Date.now() < deadline) {
      hers = (
        await runAsTenant(alice, () =>
          database
            .select({ id: threadRuns.id })
            .from(threadRuns)
            .where(eq(threadRuns.threadId, threadId)),
        )
      ).map((row) => row.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(hers.length).toBe(2);
  });
});

/*
 * G01-E P18: a restart loses nobody's conversations, and hands nobody anyone else's.
 *
 * The runner mirrors threads in the runtime's process-wide in-memory store, and the runtime's thread
 * endpoints and connect replay answer from that mirror alone, filtered by the ownership index. Both
 * are empty after a restart while the rows are still in PostgreSQL, so a person's earlier threads
 * were missing from their list and their history and replay read as empty.
 *
 * The restart is modelled with nothing but what a restart does: the memory goes (each person's own
 * clear, which takes exactly their threads out of the store and leaves the rows), and a FRESH copy of
 * the runner module is loaded — a new ownership index and nothing hydrated — and mounted the way the
 * wiring mounts it. The rows stay as the first process wrote them.
 */
describe("after a restart a person's stored threads are theirs again, and nobody else's (G01-E P18)", () => {
  let restarted: ReturnType<typeof createApp>;
  let hers = "";
  let his = "";
  let hersBefore: { events: unknown[]; messages: unknown[] } = {
    events: [],
    messages: [],
  };
  /** A `system`-stamped thread from before tenancy: visible to everybody's frame, nobody's to write. */
  const legacy = `rtf-p18-legacy-${suite}`;

  async function finishedTurn(person: string, bot: string): Promise<string> {
    const threadId = `rtf-p18-${randomUUID()}`;
    threadIds.push(threadId);
    const ran = await post(
      `/api/copilotkit/agent/${bot}/run`,
      person,
      runInput(threadId),
    );
    expect(ran.text).toContain("RUN_FINISHED");
    await eventually(() =>
      runAsTenant(person, () =>
        database
          .select({ id: threadRuns.id })
          .from(threadRuns)
          .where(eq(threadRuns.threadId, threadId)),
      ),
    );
    // The snapshot is the write-through's second statement; wait for it too.
    await eventually(async () =>
      (
        await runAsTenant(person, () =>
          database
            .select({ messages: threads.messagesSnapshot })
            .from(threads)
            .where(eq(threads.id, threadId)),
        )
      ).filter((row) => row.messages.length > 0),
    );
    return threadId;
  }

  /** How many runs the process-wide store holds for a thread; undefined when it holds no entry. */
  const runsInMemory = (threadId: string) =>
    ɵGLOBAL_STORE.peek(threadId)?.historicRuns.length;

  beforeAll(async () => {
    hers = await finishedTurn(alice, bots.aliceRemote);
    his = await finishedTurn(bob, bots.catalogue);
    hersBefore = {
      events: ((await get(`/api/copilotkit/threads/${hers}/events`, alice)).body
        ?.events ?? []) as unknown[],
      messages: ((await get(`/api/copilotkit/threads/${hers}/messages`, alice))
        .body?.messages ?? []) as unknown[],
    };
    expect(hersBefore.events.length).toBeGreaterThan(0);
    expect(hersBefore.messages.length).toBeGreaterThan(0);

    threadIds.push(legacy);
    await runAsTenant(SYSTEM_TENANT, async () => {
      await database.insert(threads).values({
        id: legacy,
        tenantId: SYSTEM_TENANT,
        agentId: bots.catalogue,
        messagesSnapshot: [
          { id: `${legacy}-u1`, role: "user", content: "legacy question" },
        ],
      });
      await database.insert(threadRuns).values({
        id: `${legacy}-run`,
        threadId: legacy,
        agentId: bots.catalogue,
      });
      await database.insert(threadRunEvents).values([
        {
          threadId: legacy,
          runId: `${legacy}-run`,
          seq: 0,
          event: {
            type: "RUN_STARTED",
            threadId: legacy,
            runId: `${legacy}-run`,
          },
        },
        {
          threadId: legacy,
          runId: `${legacy}-run`,
          seq: 1,
          event: {
            type: "RUN_FINISHED",
            threadId: legacy,
            runId: `${legacy}-run`,
          },
        },
      ]);
    });

    // The restart. Memory first: each person's threads leave the store, their rows stay.
    for (const person of [alice, bob])
      expect(
        (await post(`/api/copilotkit/threads/clear`, person, {})).status,
      ).toBe(204);
    expect(runsInMemory(hers)).toBeUndefined();
    expect(runsInMemory(his)).toBeUndefined();
    expect(runsInMemory(legacy)).toBeUndefined();
    // Then a new process's runner: a fresh evaluation of the module, so its ownership index is empty
    // and it has hydrated nobody, mounted exactly as the boot one was.
    // Through a variable: the query is Bun's, and TypeScript resolves only a literal path.
    const restartRunner = "../src/threads/postgres-runner.ts?p18-restart";
    const fresh = (await import(
      restartRunner
    )) as typeof import("../src/threads/postgres-runner");
    restarted = mountApp(new fresh.PostgresAgentRunner(database));
  });

  test("Bob's first access lists, reads, replays and continues none of Alice's, and loads none of it", async () => {
    // His own thread is back for him, history and all.
    const list = await get(`/api/copilotkit/threads`, bob, restarted);
    expect(list.status).toBe(200);
    expect(threadIdsIn(list.body)).toContain(his);
    expect(threadIdsIn(list.body)).not.toContain(hers);
    const ownMessages = await get(
      `/api/copilotkit/threads/${his}/messages`,
      bob,
      restarted,
    );
    expect(
      ((ownMessages.body?.messages ?? []) as { content?: string }[]).some(
        (message) => message.content === "hello",
      ),
    ).toBe(true);

    // Hers is not his, by any door.
    expect(
      (await get(`/api/copilotkit/threads/${hers}/messages`, bob, restarted))
        .body?.messages,
    ).toEqual([]);
    expect(
      (await get(`/api/copilotkit/threads/${hers}/events`, bob, restarted)).body
        ?.events,
    ).toEqual([]);
    const connected = await post(
      `/api/copilotkit/agent/${bots.catalogue}/connect`,
      bob,
      runInput(hers),
      restarted,
    );
    expect(connected.status).toBe(200);
    for (const leaked of ["RUN_STARTED", "frames answer", "hello"])
      expect(connected.text).not.toContain(leaked);

    // P17's refusal still holds with an empty index: claim() asks the row, which is not his.
    const ran = await post(
      `/api/copilotkit/agent/${bots.catalogue}/run`,
      bob,
      runInput(hers),
      restarted,
    );
    for (const event of ["RUN_STARTED", "RUN_FINISHED", "frames answer"])
      expect(ran.text).not.toContain(event);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const runs = await runAsTenant("platform", () =>
      database
        .select({ tenantId: threadRuns.tenantId })
        .from(threadRuns)
        .where(eq(threadRuns.threadId, hers)),
    );
    expect(runs.map((row) => row.tenantId)).toEqual([alice]);

    // And none of what Bob did put her conversation into memory.
    expect(runsInMemory(hers)).toBeUndefined();
  });

  test("Alice's first access, however many requests it is at once, brings back her list, history, events and replay", async () => {
    const [list, messages, events, connected] = await Promise.all([
      get(
        `/api/copilotkit/threads?agentId=${bots.aliceRemote}`,
        alice,
        restarted,
      ),
      get(`/api/copilotkit/threads/${hers}/messages`, alice, restarted),
      get(`/api/copilotkit/threads/${hers}/events`, alice, restarted),
      post(
        `/api/copilotkit/agent/${bots.aliceRemote}/connect`,
        alice,
        runInput(hers),
        restarted,
      ),
    ]);
    expect(list.status).toBe(200);
    expect(threadIdsIn(list.body)).toContain(hers);
    expect(threadIdsIn(list.body)).not.toContain(his);
    expect(messages.body?.messages).toEqual(hersBefore.messages);
    expect(events.body?.events).toEqual(hersBefore.events);
    expect(connected.status).toBe(200);
    expect(connected.text).toContain("RUN_STARTED");
    expect(connected.text).toContain("frames answer");
    // Four first requests, one load: the thread holds the one run it had.
    expect(runsInMemory(hers)).toBe(1);
  });

  test("a second access loads nothing twice, for her or for him", async () => {
    for (const person of [alice, bob]) {
      await get(`/api/copilotkit/threads`, person, restarted);
      await get(`/api/copilotkit/threads/${hers}/events`, person, restarted);
    }
    expect(runsInMemory(hers)).toBe(1);
    expect(runsInMemory(his)).toBe(1);
    expect(
      (await get(`/api/copilotkit/threads/${hers}/events`, alice, restarted))
        .body?.events,
    ).toEqual(hersBefore.events);
    expect(
      threadIdsIn((await get(`/api/copilotkit/threads`, bob, restarted)).body),
    ).not.toContain(hers);
  });

  test("Alice's next turn continues her restored thread, after its history", async () => {
    const again = await post(
      `/api/copilotkit/agent/${bots.aliceRemote}/run`,
      alice,
      runInput(hers),
      restarted,
    );
    expect(again.text).toContain("RUN_FINISHED");
    const deadline = Date.now() + 3000;
    while ((runsInMemory(hers) ?? 0) < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runsInMemory(hers)).toBe(2);
  });

  test("a system-stamped legacy thread loads read-only: listed and readable, never continued", async () => {
    expect(
      threadIdsIn(
        (await get(`/api/copilotkit/threads`, alice, restarted)).body,
      ),
    ).toContain(legacy);
    const legacyMessages = (
      await get(`/api/copilotkit/threads/${legacy}/messages`, alice, restarted)
    ).body?.messages as { content?: string }[] | undefined;
    expect(legacyMessages?.map((message) => message.content)).toEqual([
      "legacy question",
    ]);
    const ran = await post(
      `/api/copilotkit/agent/${bots.catalogue}/run`,
      alice,
      runInput(legacy),
      restarted,
    );
    for (const event of ["RUN_STARTED", "RUN_FINISHED", "frames answer"])
      expect(ran.text).not.toContain(event);
    expect(runsInMemory(legacy)).toBe(1);
  });
});

/*
 * G01-E P17: `/threads/clear` empties the caller's own conversations out of the in-memory store and
 * nobody else's. The inherited method wipes the whole process-wide store, so one signed-in person's
 * Clear button emptied every person's live history (and their connect replays) until a restart.
 *
 * Last in the file on purpose: it clears every thread Alice and Bob hold here.
 */
describe("clearing threads clears only the caller's own (G01-E P17)", () => {
  async function turn(person: string, bot: string): Promise<string> {
    const threadId = `rtf-p17-clear-${randomUUID()}`;
    threadIds.push(threadId);
    const ran = await post(
      `/api/copilotkit/agent/${bot}/run`,
      person,
      runInput(threadId),
    );
    expect(ran.text).toContain("RUN_FINISHED");
    await eventually(() =>
      runAsTenant(person, () =>
        database
          .select({ id: threadRuns.id })
          .from(threadRuns)
          .where(eq(threadRuns.threadId, threadId)),
      ),
    );
    return threadId;
  }

  /** What `person` can still read of `threadId` out of the runtime. */
  async function readable(person: string, threadId: string, bot: string) {
    const listed = threadIdsIn(
      (await get(`/api/copilotkit/threads`, person)).body,
    );
    const events = (
      await get(`/api/copilotkit/threads/${threadId}/events`, person)
    ).body?.events as unknown[] | undefined;
    const connected = await post(
      `/api/copilotkit/agent/${bot}/connect`,
      person,
      runInput(threadId),
    );
    return {
      listed: listed.includes(threadId),
      events: events?.length ?? 0,
      replays: connected.text.includes("frames answer"),
    };
  }

  test("Bob's clear leaves Alice's threads intact; Alice's own clear empties hers and leaves Bob's", async () => {
    const hers = await turn(alice, bots.aliceRemote);
    const his = await turn(bob, bots.catalogue);
    const intact = { listed: true, replays: true };

    const cleared = await post(`/api/copilotkit/threads/clear`, bob, {});
    expect(cleared.status).toBe(204);
    expect(await readable(alice, hers, bots.aliceRemote)).toMatchObject(intact);
    expect(
      (await readable(alice, hers, bots.aliceRemote)).events,
    ).toBeGreaterThan(0);
    // His own clear did clear his own.
    expect(await readable(bob, his, bots.catalogue)).toEqual({
      listed: false,
      events: 0,
      replays: false,
    });

    const his2 = await turn(bob, bots.catalogue);
    expect(
      (await post(`/api/copilotkit/threads/clear`, alice, {})).status,
    ).toBe(204);
    expect(await readable(alice, hers, bots.aliceRemote)).toEqual({
      listed: false,
      events: 0,
      replays: false,
    });
    expect(await readable(bob, his2, bots.catalogue)).toMatchObject(intact);

    // Memory only, as the inherited clear is: the stored record of her thread is untouched.
    const rows = await runAsTenant(alice, () =>
      database
        .select({ id: threadRuns.id })
        .from(threadRuns)
        .where(eq(threadRuns.threadId, hers)),
    );
    expect(rows.length).toBe(1);
  });
});
