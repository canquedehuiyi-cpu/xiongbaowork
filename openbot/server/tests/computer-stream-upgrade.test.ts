import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { computerAccessCheck } from "../src/agents/computer-access";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { OpenBotRole } from "../src/auth/roles";
import {
  type ComputerStreamSocketData,
  captureInFrame,
  handleComputerStreamUpgrade,
} from "../src/computer/stream-upgrade";
import { createDatabase } from "../src/db/client";
import { runnerAddress } from "../src/devices/channel";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { createDemonstrationRecorder } from "../src/demonstrations/recording";
import { createDemonstrationStore } from "../src/demonstrations/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The live screen's upgrade runs ahead of every middleware, so it opens its own frame: the signed-in
 * person's (G01-E P4). Every access needs a frame, so an unframed read anywhere on the path fails
 * the test instead of reading as `system` — which is what used to tell an owner that their own
 * private Bot did not exist.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `stream-upgrade-${randomUUID()}`;
const owner = `${prefix}-owner`;
const stranger = `${prefix}-stranger`;
const bot = `${prefix}-bot`;
const profiles = createAgentProfileStore(database, undefined);
const demonstrations = createDemonstrationStore(database);

const roles: Record<string, OpenBotRole> = {
  [owner]: "user",
  [stranger]: "user",
};

function deps() {
  return {
    computerConfigured: true,
    // The session, as the request guard would resolve it: who is asking travels in a test header.
    resolveRequestActor: async (request: Request) => {
      const id = request.headers.get("x-test-user") ?? "";
      const role = roles[id];
      if (!role) throw new Error("not signed in");
      return { id, role };
    },
    accessCheck: computerAccessCheck(profiles),
    locate: async (botId: string) => `http://computer.example.test/${botId}`,
    toStreamUrl: (base: string, botId: string) =>
      `${base.replace(/^http/, "ws")}/stream?bot=${encodeURIComponent(botId)}&token=t`,
    activeRecording: (ownerUserId: string, botId: string) =>
      demonstrations.active(ownerUserId, botId),
  };
}

function fakeServer() {
  const upgraded: ComputerStreamSocketData[] = [];
  return {
    upgraded,
    upgrade(_request: Request, options: { data: ComputerStreamSocketData }) {
      upgraded.push(options.data);
      return true;
    },
  };
}

function streamRequest(user: string): Request {
  return new Request(
    `http://openbot.example.test/api/computers/${encodeURIComponent(bot)}/stream`,
    { headers: { upgrade: "websocket", "x-test-user": user } },
  );
}

beforeAll(async () => {
  await runAsTenant(stranger, () =>
    database
      .insert(users)
      .values({ id: stranger, email: `${stranger}@example.test` }),
  );
  await runAsTenant(owner, async () => {
    await database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test` });
    await database.insert(agents).values({
      id: bot,
      name: "Stream Bot",
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: bot,
      ownerUserId: owner,
      title: "Stream Bot",
      roleDescription: "Assist",
      avatarSeed: bot,
      visibility: "private",
    });
  });
});

afterAll(async () => {
  await runAsTenant(owner, async () => {
    await database.delete(agents).where(eq(agents.id, bot));
    await database.delete(users).where(inArray(users.id, [owner]));
  });
  await runAsTenant(stranger, () =>
    database.delete(users).where(inArray(users.id, [stranger])),
  );
  await database.$client.close();
});

test("the owner of a private Bot gets its live screen", async () => {
  const server = fakeServer();
  const answer = await handleComputerStreamUpgrade(
    deps(),
    streamRequest(owner),
    server,
  );
  // `undefined` is Bun's 101: the socket was handed over.
  expect(answer).toBeUndefined();
  expect(server.upgraded).toEqual([
    {
      upstream: `ws://computer.example.test/${bot}/stream?bot=${encodeURIComponent(bot)}&token=t`,
      ownerUserId: owner,
      botId: bot,
    },
  ]);
});

test("a stranger is told there is no such Bot", async () => {
  const server = fakeServer();
  const answer = await handleComputerStreamUpgrade(
    deps(),
    streamRequest(stranger),
    server,
  );
  expect(answer?.status).toBe(404);
  expect(server.upgraded).toEqual([]);
});

test("nobody signed in is asked to sign in", async () => {
  const server = fakeServer();
  const answer = await handleComputerStreamUpgrade(
    deps(),
    streamRequest(""),
    server,
  );
  expect(answer?.status).toBe(401);
  expect(server.upgraded).toEqual([]);
});

test("the owner's active recording rides along on the socket", async () => {
  const recording = await runAsTenant(owner, () =>
    demonstrations.start(owner, bot, "Watched workflow"),
  );
  try {
    const server = fakeServer();
    const answer = await handleComputerStreamUpgrade(
      deps(),
      streamRequest(owner),
      server,
    );
    expect(answer).toBeUndefined();
    expect(server.upgraded).toHaveLength(1);
    expect(server.upgraded[0]?.recordingId).toBe(recording.id);
    expect(server.upgraded[0]?.upstream).toEndWith(
      `&recording=${encodeURIComponent(recording.id)}`,
    );
  } finally {
    await runAsTenant(owner, () => demonstrations.stop(owner, recording.id));
  }
});

test("a step of the owner's recording that arrives on the socket is saved in the owner's frame", async () => {
  const recorder = createDemonstrationRecorder({
    store: demonstrations,
    ownsBot: async (person, target) => person === owner && target === bot,
    ownsSkill: async () => false,
  });
  const recording = await runAsTenant(owner, () =>
    demonstrations.start(owner, bot, "Recorded workflow"),
  );
  try {
    const server = fakeServer();
    await handleComputerStreamUpgrade(deps(), streamRequest(owner), server);
    const socket = server.upgraded[0];
    expect(socket?.recordingId).toBe(recording.id);
    if (!socket) throw new Error("the socket was not upgraded");
    // Outside any frame, as Bun runs the socket's handlers: an unframed read would throw.
    await captureInFrame(
      socket,
      {
        kind: "click",
        url: "https://example.test/invoices",
        target: { role: "button", name: "Search", sensitive: false },
      },
      (...args) => recorder.capture(...args),
    );
    const saved = await runAsTenant(owner, () =>
      demonstrations.get(owner, recording.id),
    );
    expect(saved.actions.map((action) => action.kind)).toEqual(["click"]);
  } finally {
    await runAsTenant(owner, () => demonstrations.stop(owner, recording.id));
  }
});

/*
 * F2 stage 2: a coworker whose computer is a tenant's own machine. Its screen is relayed from the
 * runner's socket, so the upgrade dials nothing and carries only who is watching which device.
 */
function deviceDeps(deviceTenant: string) {
  return {
    ...deps(),
    locate: async () =>
      runnerAddress({ tenantId: deviceTenant, deviceId: "laptop-1" }),
  };
}

test("the owner of a device-backed Bot is admitted to that device's screen, and nothing is dialled", async () => {
  const server = fakeServer();
  const answer = await handleComputerStreamUpgrade(
    deviceDeps(owner),
    streamRequest(owner),
    server,
  );
  expect(answer).toBeUndefined();
  expect(server.upgraded as unknown[]).toEqual([
    {
      screen: {
        viewerTenant: owner,
        userId: owner,
        target: { tenantId: owner, deviceId: "laptop-1" },
        botId: bot,
      },
    },
  ]);
});

test("another tenant asking for the same device's screen is refused", async () => {
  const server = fakeServer();
  const answer = await handleComputerStreamUpgrade(
    deviceDeps(owner),
    streamRequest(stranger),
    server,
  );
  expect(answer?.status).toBe(404);
  expect(server.upgraded).toEqual([]);
});

test("a visible Bot located on another tenant's device is refused, not relayed", async () => {
  const server = fakeServer();
  const answer = await handleComputerStreamUpgrade(
    deviceDeps(stranger),
    streamRequest(owner),
    server,
  );
  expect(answer?.status).toBe(404);
  expect(await answer?.text()).toBe("There is no such Bot.");
  expect(server.upgraded).toEqual([]);
});
