import { afterAll, describe, expect, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createRunnerExecutor } from "../../runner/src/execute";
import { heartbeatFrame } from "../../runner/src/index";
import { createActionJournal } from "../../runner/src/journal";
import { createRootRegistry } from "../../runner/src/roots";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalContinuation,
  parseApprovalContinuation,
  withApprovalContext,
} from "../src/approvals/types";
import type { AppVariables } from "../src/auth/guards";
import {
  avatarSourcesForActor,
  createAvatarSourceRoutes,
  createAvatarSourceStore,
} from "../src/avatar-sources";
import { ComputerUnavailableError } from "../src/computer/client";
import { createComputerGateway } from "../src/computer/gateway";
import {
  createHeadlessComputerTools,
  HeadlessToolSuspension,
} from "../src/computer/headless-tools";
import { createRunnerTransport } from "../src/computer/runner-transport";
import {
  avatarSourcesGuidance,
  buildAgents,
  type RegisteredAgent,
} from "../src/copilot";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  approvalRequests,
  avatarSources,
  devicePairCodes,
  registeredDevices,
  subscriptions,
  users,
} from "../src/db/schema";
import { createDeviceChannel } from "../src/devices/channel";
import { createDeviceRoutes, createRunnerRoutes } from "../src/devices/routes";
import { runnerMessage } from "../src/devices/socket";
import { createDeviceStore } from "../src/devices/store";
import { runAsTenant } from "../src/tenant/context";
import { avatarAgentId, provisionTenant } from "../src/tenant/provisioning";
import { untrustedNotice } from "../src/untrusted-content";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Story F1, stage 2 (S2), end to end: register a folder on the machine, add it as the 分身's
 * information source, and let a turn of the 分身 read a file in it through the gate.
 *
 * Every piece is the real one: the runner's root registry, executor and action journal on a
 * temporary directory; its heartbeat frame through the server's socket handler; the avatar-source
 * routes and store against the real database with row security; the prompt the 分身 is built with,
 * sent to a local model mock; and the 分身's own file tools, executed through the computer gateway,
 * the runner transport and device channel, and the real SEC1 approval gate. Nothing leaves the
 * machine.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const personA = `avt-${suite}-a`;
const personB = `avt-${suite}-b`;
const everyone = [personA, personB];
const scratch = mkdtempSync(join(tmpdir(), "avatar-folder-turn-"));
const devices = createDeviceStore(database);
const channel = createDeviceChannel();
const approvals = createApprovalStore(database);
const gate = createApprovalService(approvals);
const auditRows: Array<Record<string, unknown>> = [];
const sources = createAvatarSourceStore(database, {
  // As index.ts wires it: a connected machine is asked to forget a removed folder.
  onFolderRevoked: ({ tenantId, deviceId, rootRef }) => {
    void channel
      .dispatch({ tenantId, deviceId }, "roots.forget", { ref: rootRef }, 5000)
      .catch(() => undefined);
  },
});

/*
 * The gateway as a deployment whose coworkers otherwise use a container builds it: the provider
 * refuses to locate anything, so a folder read that reached it would fail. Folder reads must go to
 * the person's machine through the runner transport, and nowhere else.
 */
const gateway = createComputerGateway({
  provider: {
    name: "container",
    isolation: "per-bot",
    locate: async () => {
      throw new Error("A local folder is never read through the container.");
    },
    status: async (id) => ({ botId: id, state: "ready" }),
    list: async () => [],
    stop: async () => ({ wasRunning: false }),
    reset: async () => ({ cleared: false }),
  },
  folders: {
    resolve: (botId, actorId, root) => sources.folderFor(botId, actorId, root),
    transport: createRunnerTransport(channel),
  },
  auditStore: {
    insert: async (row: Record<string, unknown>) => {
      auditRows.push(row);
    },
  },
  policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
  approvalGate: gate.gate,
});

const actor =
  (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", { id, email: `${id}@f1.test`, role: "user" });
    await runAsTenant(id, () => next());
  };

async function call<T>(
  app: { request: (input: Request) => Promise<Response> },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await app.request(
    new Request(`http://openbot.test${path}`, {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as T,
  };
}

const closers: Array<() => void> = [];

/**
 * One person's machine, set up the way the person sets it up: paired from their Devices screen, a
 * folder registered locally with the runner, the runner connected and beating. Its executor answers
 * frames through its own journal, as the runner process does.
 */
async function pairedMachine(person: string) {
  const deviceId = `${person}-laptop`;
  const minted = await call<{ code: string }>(
    createDeviceRoutes(devices, actor(person)),
    "POST",
    "/pair",
  );
  const claimed = await call<{ token: string }>(
    createRunnerRoutes(devices),
    "POST",
    "/register",
    { code: minted.body.code, deviceId, name: "笔记本", platform: "darwin" },
  );
  const owner = await devices.deviceForToken(claimed.body.token);
  if (!owner) throw new Error("The machine did not pair.");

  const base = mkdtempSync(join(scratch, `${person}-`));
  const dataDir = join(base, "runner-data");
  const workspace = join(dataDir, "runner-workspace");
  const folder = join(base, "Documents", "工作资料");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(folder, "周报"), { recursive: true });
  writeFileSync(
    join(folder, "周报", "第一周.md"),
    "# 第一周\n上线了客户门户。\n",
  );
  writeFileSync(join(folder, ".env"), "DATABASE_PASSWORD=not-a-real-one\n");

  // The person registers the folder on the machine (`runner --add-root 工作资料=…`).
  const registry = createRootRegistry({
    dataDir,
    privatePaths: [dataDir],
  });
  const root = registry.add("工作资料", folder);

  const execute = createRunnerExecutor(workspace, undefined, registry);
  const journalPath = join(dataDir, "runner-actions.sqlite");
  const journal = createActionJournal(journalPath);
  const target = { tenantId: person, deviceId };
  const frames: Array<{ action: string; payload: unknown }> = [];
  const connection = channel.attach(target, {
    send(raw) {
      const frame = JSON.parse(raw);
      if (frame.type !== "action") return;
      frames.push({ action: frame.action, payload: frame.payload });
      void journal
        .execute("f1-s2/device", frame.key ?? frame.id, frame, execute)
        .then((outcome) =>
          channel.settle(target, { id: frame.id, ...outcome }),
        );
    },
  });
  closers.push(() => {
    journal.close();
    channel.detach(connection);
  });
  const socket = { data: { runner: owner }, send: () => undefined };
  const beat = () =>
    runnerMessage(socket, devices, channel, heartbeatFrame(registry));
  await beat();
  const journalRows = () => {
    const db = new Sqlite(journalPath, { readonly: true });
    try {
      return (
        db.query("SELECT count(*) AS n FROM actions").get() as { n: number }
      ).n;
    } finally {
      db.close();
    }
  };
  return { deviceId, folder, root, registry, frames, beat, journalRows };
}

/** One tool call of a 分身's turn, as the headless runtime makes it: in the run's approval context. */
function toolCall(
  botId: string,
  person: string,
  toolName: string,
  args: Record<string, unknown>,
) {
  const toolCallId = `${botId}-${randomUUID()}`;
  const continuation: ApprovalContinuation = {
    runId: `${botId}-run`,
    threadId: `${botId}-thread`,
    toolCallId,
    toolName,
    args,
    messages: [
      { id: "u1", role: "user", content: "看看我第一周的周报写了什么" },
    ],
    state: {},
    context: [],
    forwardedProps: {},
    initiator: { kind: "person", id: person },
  };
  const tool = createHeadlessComputerTools({
    gateway,
    botId,
    actor: { id: person, userId: person, initiator: { kind: "person" } },
  }).find((candidate) => candidate.definition.name === toolName);
  if (!tool) throw new Error(`The 分身 has no ${toolName}.`);
  return runAsTenant(person, () =>
    withApprovalContext(continuation, () =>
      tool.execute(args, {
        toolCallId,
        signal: new AbortController().signal,
      }),
    ),
  );
}

for (const person of everyone) {
  await runAsTenant(person, () =>
    database
      .insert(users)
      .values({ id: person, email: `${person}@f1.test`, name: person })
      .onConflictDoNothing(),
  );
  await provisionTenant(database, { id: person, email: `${person}@f1.test` });
}

const a = await pairedMachine(personA);
const b = await pairedMachine(personB);
const avatarA = avatarAgentId(personA);
const avatarB = avatarAgentId(personB);

const saved = await call<{ source: { id: string; rootRef: string } }>(
  createAvatarSourceRoutes(sources, actor(personA)),
  "POST",
  "/",
  {
    kind: "local_folder",
    deviceId: a.deviceId,
    rootRef: a.root.ref,
    note: "周报和合同",
  },
);

afterAll(async () => {
  for (const close of closers) close();
  for (const person of everyone) {
    await runAsTenant(person, async () => {
      await database
        .delete(approvalRequests)
        .where(eq(approvalRequests.tenantId, person));
      await database
        .delete(avatarSources)
        .where(eq(avatarSources.tenantId, person));
      await database
        .delete(registeredDevices)
        .where(eq(registeredDevices.tenantId, person));
      await database
        .delete(devicePairCodes)
        .where(eq(devicePairCodes.tenantId, person));
      await database
        .delete(agentProfiles)
        .where(eq(agentProfiles.tenantId, person));
      await database.delete(agents).where(eq(agents.tenantId, person));
      await database
        .delete(subscriptions)
        .where(eq(subscriptions.tenantId, person));
      await database.delete(users).where(eq(users.id, person));
    });
  }
  rmSync(scratch, { recursive: true, force: true });
  await database.$client.end({ timeout: 5 });
});

describe("register a folder, add it as a source, and the 分身 reads it", () => {
  test("the source is saved against the machine's reference", () => {
    expect(saved.status).toBe(201);
    expect(saved.body.source.rootRef).toBe(a.root.ref);
  });

  test("the 分身 is told the folder as a pointer inside the untrusted envelope: name, note and root, never a path or a file", async () => {
    const told = await avatarSourcesForActor(sources)(personA)(avatarA);
    expect(told).toEqual([
      { label: "工作资料", note: "周报和合同", root: a.root.ref },
    ]);
    const block = avatarSourcesGuidance(told) as string;
    expect(block).toContain(
      untrustedNotice("information source local folder content"),
    );
    expect(block).toContain(
      `"folders":[{"label":"工作资料","note":"周报和合同","root":"${a.root.ref}"}]`,
    );
    expect(block).toContain("computer_read_file");
    expect(block).not.toContain(a.folder);
    expect(block).not.toContain("上线了客户门户");

    // What a run actually sends the model: the 分身's request carries it, a colleague's does not.
    const recorder = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      recorder.onMessage(/.*/, { type: "text", content: "好的。" });
      const roster: RegisteredAgent[] = [
        {
          id: avatarA,
          name: "我的分身",
          type: "built_in",
          systemPrompt: "你是用户的个人分身。",
        },
        {
          id: `avt-${suite}-colleague`,
          name: "研究分析师",
          type: "built_in",
          systemPrompt: "Research things.",
        },
      ];
      const built = await buildAgents(
        roster,
        { provider: "openai", defaultModel: "gpt-5.6-terra" },
        "synthetic-model-key",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        avatarSourcesForActor(sources)(personA),
      );
      for (const agent of roster) {
        const run = built[agent.id]?.clone();
        if (!run) throw new Error(`Expected ${agent.id} to be built.`);
        run.addMessage({
          id: `ask-${agent.id}`,
          role: "user",
          content: "你好",
        });
        await run.runAgent();
      }
      const [toAvatar, toColleague] = recorder
        .getRequests()
        .map((request) => JSON.stringify(request.body));
      expect(toAvatar).toContain(a.root.ref);
      expect(toAvatar).not.toContain(a.folder);
      expect(toColleague).toBeDefined();
      expect(toColleague).not.toContain(a.root.ref);
    } finally {
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await recorder.stop();
    }
  });

  test("the 分身's read goes through the gate to the person's machine and comes back marked as outside content", async () => {
    const before = a.frames.length;
    const result = (await toolCall(avatarA, personA, "computer_read_file", {
      root: a.root.ref,
      path: "周报/第一周.md",
    })) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: true,
      path: "周报/第一周.md",
      text: "# 第一周\n上线了客户门户。\n",
      truncated: false,
    });
    expect(result.untrusted).toContain(
      untrustedNotice("local folder file content"),
    );
    expect(a.frames.slice(before)).toEqual([
      {
        action: "files.read",
        payload: { root: a.root.ref, path: "周报/第一周.md" },
      },
    ]);
    // The decision row names the folder and the machine, and no path of the machine's.
    const row = JSON.stringify(auditRows.at(-1));
    expect(row).toContain(`${a.root.ref}/周报/第一周.md`);
    expect(row).toContain(a.deviceId);
    expect(row).not.toContain(a.folder);

    const listed = (await toolCall(avatarA, personA, "computer_list_files", {
      root: a.root.ref,
    })) as { entries: Array<{ path: string }> };
    expect(listed.entries.map((entry) => entry.path).sort()).toEqual(
      [".env", "周报", "周报/第一周.md"].sort(),
    );
  });

  test("SEC1: a .env inside the folder still asks first; nothing reaches the machine until it is allowed", async () => {
    const frames = a.frames.length;
    const journal = a.journalRows();
    const held = await toolCall(avatarA, personA, "computer_read_file", {
      root: a.root.ref,
      path: ".env",
    }).catch((error: unknown) => error);
    expect(held).toBeInstanceOf(HeadlessToolSuspension);
    expect(a.frames.length).toBe(frames);
    expect(a.journalRows()).toBe(journal);

    const [request] = await runAsTenant(personA, () => approvals.list(personA));
    expect(request?.action.policy).toMatchObject({
      behaviour: "ask",
      source: "sensitive_path",
    });
    expect(request?.action.toolRef).toBe("computer_read_file");

    await runAsTenant(personA, () =>
      gate.decide(personA, request?.id as string, "allow_once"),
    );
    // Asked again with the same call, as the resumed turn does: now it reads, once.
    const continuation = parseApprovalContinuation(
      request?.action.continuation,
    );
    const tool = createHeadlessComputerTools({
      gateway,
      botId: avatarA,
      actor: { id: personA, userId: personA, initiator: { kind: "person" } },
    }).find((candidate) => candidate.definition.name === "computer_read_file");
    const read = (await runAsTenant(personA, () =>
      withApprovalContext(continuation, () =>
        (tool as NonNullable<typeof tool>).execute(continuation.args, {
          toolCallId: continuation.toolCallId,
          signal: new AbortController().signal,
        }),
      ),
    )) as { text: string };
    expect(read.text).toBe("DATABASE_PASSWORD=not-a-real-one\n");
    expect(a.frames.length).toBe(frames + 1);
  });

  test("a write into the folder is refused and the disk does not change", async () => {
    const original = readFileSync(join(a.folder, "周报", "第一周.md"), "utf8");
    const frames = a.frames.length;
    // The write tool has no root at all: the call is refused before anything is decided or sent.
    await expect(
      toolCall(avatarA, personA, "computer_write_file", {
        root: a.root.ref,
        path: "周报/第一周.md",
        contents: "改掉了",
      }),
    ).rejects.toThrow();
    expect(a.frames.length).toBe(frames);
    // And a write frame naming the folder, sent to the machine anyway, is refused by the runner.
    await expect(
      channel.dispatch(
        { tenantId: personA, deviceId: a.deviceId },
        "files.write",
        { root: a.root.ref, path: "周报/第一周.md", contents: "改掉了" },
        5000,
      ),
    ).rejects.toThrow("read-only");
    expect(readFileSync(join(a.folder, "周报", "第一周.md"), "utf8")).toBe(
      original,
    );
  });

  test("another person's 分身, another person's run and a coworker that is not the 分身 cannot read the folder", async () => {
    const framesA = a.frames.length;
    const framesB = b.frames.length;
    const read = { root: a.root.ref, path: "周报/第一周.md" };
    for (const [botId, person] of [
      [avatarB, personB], // B's own 分身, naming A's folder
      [avatarA, personB], // A's 分身 in a run that is B's
      [`avt-${suite}-colleague`, personA], // A's run, a Bot that is not the 分身
    ] as const) {
      await expect(
        toolCall(botId, person, "computer_read_file", read),
      ).rejects.toBeInstanceOf(ComputerUnavailableError);
    }
    // B's own folder, never added as B's source, is not readable by B's 分身 either.
    await expect(
      toolCall(avatarB, personB, "computer_read_file", {
        root: b.root.ref,
        path: "周报/第一周.md",
      }),
    ).rejects.toBeInstanceOf(ComputerUnavailableError);
    await expect(
      toolCall(avatarA, personA, "computer_read_file", {
        root: "fld_ZZZZZZZZZZZZZZZZZZZZZZ",
        path: "周报/第一周.md",
      }),
    ).rejects.toBeInstanceOf(ComputerUnavailableError);
    expect(a.frames.length).toBe(framesA);
    expect(b.frames.length).toBe(framesB);
  });

  test("a folder the machine stops offering is not read, and removing the source makes the machine forget it", async () => {
    // Removed on the machine: the next beat says so, and the server stops reading through it.
    a.registry.remove(a.root.ref);
    await a.beat();
    const frames = a.frames.length;
    await expect(
      toolCall(avatarA, personA, "computer_read_file", {
        root: a.root.ref,
        path: "周报/第一周.md",
      }),
    ).rejects.toBeInstanceOf(ComputerUnavailableError);
    expect(a.frames.length).toBe(frames);

    // Offered again under a new reference and saved as a new source, then removed by the person.
    const again = a.registry.add("工作资料", a.folder);
    await a.beat();
    const added = await call<{ source: { id: string } }>(
      createAvatarSourceRoutes(sources, actor(personA)),
      "POST",
      "/",
      { kind: "local_folder", deviceId: a.deviceId, rootRef: again.ref },
    );
    expect(added.status).toBe(201);
    expect(
      (
        await call(
          createAvatarSourceRoutes(sources, actor(personA)),
          "DELETE",
          `/${added.body.source.id}`,
        )
      ).status,
    ).toBe(200);
    // The machine was asked to forget it (spec §6.5), and did.
    for (let wait = 0; wait < 50 && a.registry.list().length > 0; wait += 1) {
      await Bun.sleep(20);
    }
    expect(a.frames.at(-1)).toEqual({
      action: "roots.forget",
      payload: { ref: again.ref },
    });
    expect(a.registry.list()).toEqual([]);
    expect(await sources.folderFor(avatarA, personA, again.ref)).toBeNull();
    // And the next run is no longer told about the removed one.
    const told = await avatarSourcesForActor(sources)(personA)(avatarA);
    expect(told.map((source) => source.root)).not.toContain(again.ref);
  });
});
