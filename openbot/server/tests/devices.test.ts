import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  devicePairCodes,
  OFFLINE_AFTER_MS,
  registeredDevices,
  users,
} from "../src/db/schema";
import { createDeviceChannel } from "../src/devices/channel";
import { createDeviceRoutes, createRunnerRoutes } from "../src/devices/routes";
import { runnerMessage } from "../src/devices/socket";
import { createDeviceStore } from "../src/devices/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 016 acceptance: a machine of the tenant's own, admitted by a code and kept present by a beat.
 *
 * The runner arrives with no session — that is the design, since the machine being set up is in
 * somebody's study and has nothing to log in with — so these tests mount the routes exactly the way
 * `index.ts` does and speak as a runner does: a code, then a bearer token, and nothing else.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenant = `dev-${suite}`;
const other = `dev-other-${suite}`;
const store = createDeviceStore(database);
/** The socket handler takes the dispatch channel; these frames only need one that is empty. */
const channel = createDeviceChannel();
beforeAll(async () => {
  for (const id of [tenant, other])
    await runAsTenant(id, () =>
      database
        .insert(users)
        .values({ id, email: `${id}@example.test`, name: id }),
    );
});

const actor =
  (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", { id, role: "user" as const });
    await next();
  };

const mine = createDeviceRoutes(store, actor(tenant));
const theirs = createDeviceRoutes(store, actor(other));
const runner = createRunnerRoutes(store);

async function call<T>(
  app: { request: (input: Request) => Promise<Response> },
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<{ status: number; body: T }> {
  const response = await app.request(
    new Request(`http://openbot.test${path}`, {
      method,
      headers: {
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    }),
  );
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as T,
  };
}

type DeviceRow = {
  id: string;
  deviceId: string;
  name: string;
  platform: string | null;
  lastSeenAt: string | null;
  online: boolean;
};

/** Pair a machine end to end, the way the runner does it: mint, then spend. */
async function pair(deviceId: string, name = "Studio desktop") {
  const minted = await call<{ code: string }>(mine, "POST", "/pair");
  expect(minted.status).toBe(201);
  const claimed = await call<{ token: string; device: DeviceRow }>(
    runner,
    "POST",
    "/register",
    { body: { code: minted.body.code, deviceId, name, platform: "win32" } },
  );
  expect(claimed.status).toBe(201);
  if (!claimed.body.token) throw new Error("The pairing returned no token.");
  return { token: claimed.body.token, device: claimed.body.device };
}

test("a pairing code admits one machine, and its token is shown once", async () => {
  const { token, device } = await pair(`${suite}-studio`);
  expect(device.name).toBe("Studio desktop");
  expect(device.online).toBeTrue();

  const listed = await call<{ devices: DeviceRow[] }>(mine, "GET", "/");
  const row = listed.body.devices.find((d) => d.deviceId === `${suite}-studio`);
  expect(row?.online).toBeTrue();
  expect(row?.platform).toBe("win32");

  // What the deployment kept is a hash, and the token appears in no stored column.
  const [stored] = await runAsTenant(tenant, () =>
    database
      .select({ tokenHash: registeredDevices.tokenHash })
      .from(registeredDevices)
      .where(eq(registeredDevices.id, device.id)),
  );
  expect(stored!.tokenHash).not.toContain(token);
  expect(stored!.tokenHash.length).toBe(64);
  expect(JSON.stringify(listed.body).includes(stored!.tokenHash)).toBeFalse();
});

test("a spent, an unknown and an expired code are refused identically", async () => {
  const minted = await call<{ code: string }>(mine, "POST", "/pair");
  const first = await call<{ token: string }>(runner, "POST", "/register", {
    body: {
      code: minted.body.code,
      deviceId: `${suite}-twice`,
      name: "Twice",
    },
  });
  expect(first.status).toBe(201);

  const spent = await call<{ error?: string }>(runner, "POST", "/register", {
    body: { code: minted.body.code, deviceId: `${suite}-twice`, name: "Twice" },
  });
  const unknown = await call<{ error?: string }>(runner, "POST", "/register", {
    body: { code: "ZZZZZZZZ", deviceId: `${suite}-ghost`, name: "Ghost" },
  });

  // Expired, minted directly because the live window is ten minutes and a test should not wait out.
  const expired = `${suite}-expired`;
  await runAsTenant(tenant, () =>
    database.insert(devicePairCodes).values({
      code: expired,
      tenantId: tenant,
      expiresAt: new Date(Date.now() - 1_000),
    }),
  );
  const stale = await call<{ error?: string }>(runner, "POST", "/register", {
    body: { code: expired, deviceId: `${suite}-late`, name: "Late" },
  });

  expect(spent.status).toBe(403);
  expect(unknown.status).toBe(403);
  expect(stale.status).toBe(403);
  // Same sentence for all three: which one it was is only useful to somebody trying codes.
  expect(spent.body.error).toBe(unknown.body.error);
  expect(stale.body.error).toBe(spent.body.error);

  const listed = await call<{ devices: DeviceRow[] }>(mine, "GET", "/");
  expect(
    listed.body.devices.some((d) => d.deviceId === `${suite}-late`),
  ).toBeFalse();
});

test("a missing or wrong required field is a refusal, not a half-registration", async () => {
  const minted = await call<{ code: string }>(mine, "POST", "/pair");
  const noName = await call(runner, "POST", "/register", {
    body: { code: minted.body.code, deviceId: `${suite}-nameless` },
  });
  expect(noName.status).toBe(400);
  const notJson = await runner.request(
    new Request("http://openbot.test/register", {
      method: "POST",
      body: "code",
    }),
  );
  expect(notJson.status).toBe(400);
});

test("presence is the last beat: a silent machine goes offline inside a minute", async () => {
  const { token, device } = await pair(`${suite}-beat`);

  const beat = await call<{ ok: boolean }>(runner, "POST", "/heartbeat", {
    token,
  });
  expect(beat.status).toBe(200);
  expect(beat.body.ok).toBeTrue();

  const fresh = (await store.list(tenant)).find(
    (row) => row.deviceId === `${suite}-beat`,
  );
  expect(fresh?.online).toBeTrue();

  // A machine switched off at the wall sends no goodbye, so time alone has to turn it offline.
  await runAsTenant(tenant, () =>
    database
      .update(registeredDevices)
      .set({ lastSeenAt: new Date(Date.now() - OFFLINE_AFTER_MS - 1_000) })
      .where(eq(registeredDevices.id, device.id)),
  );
  const quiet = (await store.list(tenant)).find(
    (row) => row.deviceId === `${suite}-beat`,
  );
  expect(quiet?.online).toBeFalse();

  await call(runner, "POST", "/heartbeat", { token });
  const back = (await store.list(tenant)).find(
    (row) => row.deviceId === `${suite}-beat`,
  );
  expect(back?.online).toBeTrue();
});

test("no token and a token that is not a device both get 401", async () => {
  const anonymous = await call(runner, "POST", "/heartbeat", {});
  expect(anonymous.status).toBe(401);
  const forged = await call(runner, "POST", "/heartbeat", {
    token: "obot_dev_not-a-real-device-token",
  });
  expect(forged.status).toBe(401);
  const wrongShape = await call(runner, "POST", "/heartbeat", {
    token: "sk-somebody-elses-key",
  });
  expect(wrongShape.status).toBe(401);
});

test("re-pairing the same machine replaces its token rather than adding a device", async () => {
  const first = await pair(`${suite}-replaced`, "Before");
  const again = await pair(`${suite}-replaced`, "After");

  const listed = await store.list(tenant);
  const rows = listed.filter((row) => row.deviceId === `${suite}-replaced`);
  expect(rows.length).toBe(1);
  expect(rows[0]?.name).toBe("After");

  // The old token is dead: a laptop reinstalled must not leave two working credentials behind.
  const retired = await call(runner, "POST", "/heartbeat", {
    token: first.token,
  });
  expect(retired.status).toBe(401);
  const current = await call<{ ok: boolean }>(runner, "POST", "/heartbeat", {
    token: again.token,
  });
  expect(current.status).toBe(200);
});

test("another tenant cannot see, name or evict this machine", async () => {
  const { device } = await pair(`${suite}-private`, "Private laptop");

  const listed = await call<{ devices: DeviceRow[] }>(theirs, "GET", "/");
  expect(listed.body.devices).toEqual([]);
  expect((await store.list(other)).length).toBe(0);

  const stolen = await call(theirs, "DELETE", `/${device.id}`);
  expect(stolen.status).toBe(404);
  // Refused from the wrong tenant, and still there for the right one.
  expect(
    (await store.list(tenant)).some((row) => row.id === device.id),
  ).toBeTrue();

  // A device id that collides across tenants is two machines, not one shared row.
  await runAsTenant(other, () =>
    database.insert(registeredDevices).values({
      tenantId: other,
      deviceId: `${suite}-private`,
      name: "Their laptop",
      tokenHash: "x".repeat(64),
    }),
  );
  const shared = await store.list(other);
  expect(shared.length).toBe(1);
  expect(shared[0]?.name).toBe("Their laptop");
  // Their write to the same device id did not become this tenant's row.
  const untouched = (await store.list(tenant)).find(
    (row) => row.deviceId === `${suite}-private`,
  );
  expect(untouched?.name).toBe("Private laptop");
  expect(untouched?.id).toBe(device.id);
});

test("removing a device retires its credential", async () => {
  const { token, device } = await pair(`${suite}-removed`, "To be removed");

  const gone = await call(mine, "DELETE", `/${device.id}`);
  expect(gone.status).toBe(200);
  expect(
    (await store.list(tenant)).some((row) => row.id === device.id),
  ).toBeFalse();

  const beat = await call(runner, "POST", "/heartbeat", { token });
  expect(beat.status).toBe(401);
});

/**
 * The socket frames, with no session and no tenant context on the call stack.
 *
 * A websocket callback runs outside any request's async scope, which is exactly the state a runner's
 * heartbeat arrives in. Driving `runnerMessage` from a bare test frame asserts the store carries its
 * own tenant rather than inheriting one that is not there.
 */
async function fakeSocket(tenantId: string, deviceId: string) {
  const [device] = await runAsTenant(tenantId, () =>
    database
      .select()
      .from(registeredDevices)
      .where(eq(registeredDevices.deviceId, deviceId)),
  );
  if (!device) throw new Error("Missing paired test device.");
  const sent: string[] = [];
  return {
    sent,
    socket: {
      data: {
        runner: {
          tenantId,
          deviceId,
          id: device.id,
          credentialVersion: device.tokenHash,
        },
      },
      send: (value: string) => sent.push(value),
    },
  };
}

test("a heartbeat over the socket marks the machine alive and is acknowledged", async () => {
  const { device } = await pair(`${suite}-socket`, "Socket machine");
  const { sent, socket } = await fakeSocket(tenant, `${suite}-socket`);

  await runnerMessage(
    socket,
    store,
    channel,
    JSON.stringify({ type: "heartbeat" }),
  );
  expect(sent).toEqual([JSON.stringify({ type: "ack" })]);

  await runAsTenant(tenant, () =>
    database
      .update(registeredDevices)
      .set({ lastSeenAt: new Date(Date.now() - OFFLINE_AFTER_MS - 1_000) })
      .where(eq(registeredDevices.id, device.id)),
  );
  await runnerMessage(
    socket,
    store,
    channel,
    JSON.stringify({ type: "heartbeat" }),
  );
  expect(
    (await store.list(tenant)).find((row) => row.id === device.id)?.online,
  ).toBeTrue();
});

test("an unknown frame is answered by name and rubbish is refused", async () => {
  const { socket, sent } = await fakeSocket(tenant, `${suite}-socket`);

  await runnerMessage(
    socket,
    store,
    channel,
    JSON.stringify({ type: "claim_work" }),
  );
  expect(sent[0]).toContain("claim_work");
  expect(sent[0]).toContain("error");

  await runnerMessage(socket, store, channel, "not json at all");
  expect(sent[1]).toContain("Frames must be JSON objects");

  await runnerMessage(socket, store, channel, JSON.stringify([1, 2]));
  expect(sent[2]).toContain("Frames must be JSON objects");

  // A byte frame arrives as a Uint8Array off the socket, not a string.
  await runnerMessage(
    socket,
    store,
    channel,
    new Uint8Array(Buffer.from(JSON.stringify({ type: "heartbeat" }))),
  );
  expect(sent[3]).toEqual(JSON.stringify({ type: "ack" }));

  /*
   * A `result` frame answers something the channel asked. It is consumed quietly — replying to it
   * would be a second answer to a request that already has one, and treating it as unknown would tell
   * the runner a thing nobody here understands.
   */
  await runnerMessage(
    socket,
    store,
    channel,
    JSON.stringify({ type: "result", id: "no-such-request", ok: true }),
  );
  expect(sent.length).toBe(4);
});

afterAll(async () => {
  for (const scope of [tenant, other]) {
    await runAsTenant(scope, async () => {
      await database
        .delete(registeredDevices)
        .where(eq(registeredDevices.tenantId, scope));
      await database
        .delete(devicePairCodes)
        .where(eq(devicePairCodes.tenantId, scope));
      await database.delete(users).where(eq(users.id, scope));
    });
  }
  await database.$client.end({ timeout: 5 });
});
