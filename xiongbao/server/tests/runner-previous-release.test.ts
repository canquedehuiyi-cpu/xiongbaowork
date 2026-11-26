import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { devicePairCodes, registeredDevices, users } from "../src/db/schema";
import { createDeviceChannel } from "../src/devices/channel";
import { createDeviceRoutes, createRunnerRoutes } from "../src/devices/routes";
import {
  type RunnerSocketLike,
  runnerMessage,
  runnerOpen,
} from "../src/devices/socket";
import { createDeviceStore } from "../src/devices/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * A person may upgrade the server first and the device app on their computers later. Until they do,
 * the device app's runner from the previous release (v0.2.15) keeps talking to this server, so the
 * runner side of every exchange here is written out from that release's source
 * (`git show v0.2.15:xiongbao/runner/src/index.ts`, `…/dispatch.ts`) rather than taken from this
 * tree's runner: a change on either side of the socket that an installed device would not survive
 * fails here.
 *
 * The rename to XiongBao renamed no name on this socket in either direction (the runner never carried
 * the upstream name; its own settings were renamed, and they stay on the computer), so the server
 * needs no second spelling and no check of which runner version it talks to. The second test keeps it
 * that way: a frame the server starts sending that a v0.2.15 runner does not read, or under a name it
 * does not know, fails it.
 */

/** v0.2.15 `pair()`: the body it posts to `/api/runner/register`. */
const registerBody = (code: string, deviceId: string) => ({
  code,
  deviceId,
  name: "Front desk PC",
  platform: "win32",
});

/** v0.2.15 `heartbeatFrame()`, with a folder, an app and a desktop stop to report. */
const heartbeat = JSON.stringify({
  type: "heartbeat",
  roots: [
    { ref: "fld_AAAAAAAAAAAAAAAAAAAAAA", name: "Invoices", mode: "read" },
  ],
  apps: [{ ref: "app_BBBBBBBBBBBBBBBBBBBBBB", name: "Excel" }],
  desktopStopped: {
    botId: "bot-1",
    actorId: "person-1",
    reason: "hotkey",
    at: 1_764_000_000_000,
  },
});

/** v0.2.15 `dispatch.ts`: `{ type: "result", id, ...outcome }`, an outcome being ok/output or ok/error. */
const result = (id: string) =>
  JSON.stringify({ type: "result", id, ok: true, output: { entries: [] } });

/**
 * What a v0.2.15 runner reads from the server, by frame type, and the fields it reads from each
 * (its `handleFrame` and `dispatch.ts`). `welcome` it receives and passes over, as it always has.
 */
const READ_BY_V0215: Record<string, readonly string[]> = {
  welcome: [],
  ack: [],
  error: ["error"],
  action: ["id", "key", "action", "payload"],
  cancel: ["key"],
};

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const tenant = `prev-runner-${randomUUID().slice(0, 8)}`;
const store = createDeviceStore(database);

beforeAll(async () => {
  await runAsTenant(tenant, () =>
    database
      .insert(users)
      .values({ id: tenant, email: `${tenant}@example.test`, name: tenant }),
  );
});

afterAll(async () => {
  await runAsTenant(tenant, async () => {
    await database
      .delete(registeredDevices)
      .where(eq(registeredDevices.tenantId, tenant));
    await database
      .delete(devicePairCodes)
      .where(eq(devicePairCodes.tenantId, tenant));
    await database.delete(users).where(eq(users.id, tenant));
  });
  await database.$client.end({ timeout: 5 });
});

const owner: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: tenant,
    email: `${tenant}@example.test`,
    role: "user" as const,
  });
  await next();
};

/**
 * A v0.2.15 runner paired and connected: the code minted on the owner's screen, the register call it
 * makes, and the socket `http-server.ts` opens for the token it then presents.
 */
async function connectPreviousRunner(deviceId: string) {
  const minted = await createDeviceRoutes(store, owner).request("/pair", {
    method: "POST",
  });
  expect(minted.status).toBe(201);
  const { code } = (await minted.json()) as { code: string };
  const registered = await createRunnerRoutes(store).request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registerBody(code, deviceId)),
  });
  expect(registered.status).toBe(201);
  const { token } = (await registered.json()) as { token: string };
  const found = await store.deviceForToken(token);
  if (!found)
    throw new Error("The token a v0.2.15 runner got does not open a socket.");
  const sent: string[] = [];
  const socket: RunnerSocketLike = {
    data: {
      runner: {
        tenantId: found.tenantId,
        deviceId: found.deviceId,
        id: found.id,
        credentialVersion: found.credentialVersion,
      },
    },
    send: (value) => sent.push(value),
  };
  const channel = createDeviceChannel();
  await runnerOpen(socket, store, channel);
  return { socket, sent, channel, target: { tenantId: tenant, deviceId } };
}

const parsed = (frames: string[]) =>
  frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);

test("v0.2.15 runner frames are accepted by the v0.2.16 server", async () => {
  const deviceId = `${tenant}-front-desk`;
  const { socket, sent, channel, target } =
    await connectPreviousRunner(deviceId);
  expect(parsed(sent)).toEqual([{ type: "welcome" }]);

  // The beat is acknowledged, and what it reports is kept.
  const stops: unknown[] = [];
  await runnerMessage(socket, store, channel, heartbeat, undefined, {
    onDesktopStopped: (_, info) => {
      stops.push(info);
    },
  });
  expect(parsed(sent.slice(1))).toEqual([{ type: "ack" }]);
  const [device] = (await store.list(tenant)).filter(
    (row) => row.deviceId === deviceId,
  );
  expect(device?.online).toBe(true);
  expect(device?.platform).toBe("win32");
  expect(device?.roots.map(({ ref, name }) => ({ ref, name }))).toEqual([
    { ref: "fld_AAAAAAAAAAAAAAAAAAAAAA", name: "Invoices" },
  ]);
  expect(device?.apps).toEqual([
    { ref: "app_BBBBBBBBBBBBBBBBBBBBBB", name: "Excel" },
  ]);
  expect(stops).toEqual([
    {
      botId: "bot-1",
      actorId: "person-1",
      reason: "hotkey",
      at: 1_764_000_000_000,
    },
  ]);

  // Work sent to it is answered by its result frame.
  const answer = channel.dispatch(target, "files.list", { root: "Invoices" });
  const action = parsed(sent).at(-1);
  expect(action?.type).toBe("action");
  await runnerMessage(socket, store, channel, result(String(action?.id)));
  expect(await answer).toEqual({ entries: [] });

  // Nothing it said was answered with an error.
  expect(parsed(sent).filter((frame) => frame.type === "error")).toEqual([]);
});

test("server talks old names to a v0.2.15 runner", async () => {
  const { socket, sent, channel, target } = await connectPreviousRunner(
    `${tenant}-back-office`,
  );
  await runnerMessage(socket, store, channel, heartbeat);
  await runnerMessage(
    socket,
    store,
    channel,
    JSON.stringify({ type: "claim_work" }),
  );
  const answer = channel.dispatch(target, "files.list", { root: "Invoices" });
  await runnerMessage(
    socket,
    store,
    channel,
    result(String(parsed(sent).at(-1)?.id)),
  );
  await answer;
  // A stopped action is called off by its key.
  const stop = new AbortController();
  const stopped = channel
    .dispatch(target, "files.list", {}, undefined, "key-1", stop.signal)
    .catch((error: unknown) => error);
  stop.abort();
  await stopped;

  const frames = parsed(sent);
  expect(frames.map((frame) => frame.type)).toEqual([
    "welcome",
    "ack",
    "error",
    "action",
    "action",
    "cancel",
  ]);
  for (const frame of frames) {
    const reads = READ_BY_V0215[String(frame.type)];
    expect(reads).toBeArray();
    for (const field of Object.keys(frame))
      expect(["type", ...(reads ?? [])]).toContain(field);
  }
  expect(frames.at(-1)).toEqual({ type: "cancel", key: "key-1" });
});
