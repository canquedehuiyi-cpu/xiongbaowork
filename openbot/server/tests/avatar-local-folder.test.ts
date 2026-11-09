import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { heartbeatFrame } from "../../runner/src/index";
import { createRootRegistry } from "../../runner/src/roots";
import type { AppVariables } from "../src/auth/guards";
import {
  AVATAR_SOURCE_LIMIT,
  createAvatarSourceRoutes,
  createAvatarSourceStore,
} from "../src/avatar-sources";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  avatarSources,
  devicePairCodes,
  registeredDevices,
  subscriptions,
  users,
} from "../src/db/schema";
import { createDeviceChannel } from "../src/devices/channel";
import { createDeviceRoutes, createRunnerRoutes } from "../src/devices/routes";
import { runnerMessage } from "../src/devices/socket";
import {
  createDeviceStore,
  reportedApps,
  reportedRoots,
} from "../src/devices/store";
import { runAsTenant } from "../src/tenant/context";
import { avatarAgentId, provisionTenant } from "../src/tenant/provisioning";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Story F1, stage 2 (S2): a folder on the person's own paired machine as an information source.
 *
 * Against the real database with row security on. The runner side is the real one: its registry
 * makes the reference and its heartbeat frame carries the report, so "the server never sees the path"
 * is checked against what a runner actually sends, and against every stored column afterwards.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const personA = `avf-${suite}-a`;
const personB = `avf-${suite}-b`;
const everyone = [personA, personB];
const sources = createAvatarSourceStore(database);
const devices = createDeviceStore(database);
const channel = createDeviceChannel();
const scratch = mkdtempSync(join(tmpdir(), "avatar-local-folder-"));

const actor =
  (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", { id, email: `${id}@f1.test`, role: "user" });
    await runAsTenant(id, () => next());
  };

async function call<T>(
  app: { request: (input: Request) => Response | Promise<Response> },
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

const sourceRoutes = (person: string) =>
  createAvatarSourceRoutes(sources, actor(person));
const deviceRoutes = (person: string) =>
  createDeviceRoutes(devices, actor(person));
const runnerRoutes = createRunnerRoutes(devices);

type Source = {
  id: string;
  kind: string;
  label: string;
  note: string;
  deviceId?: string;
  rootRef?: string;
};

const addSource = (person: string, body: unknown) =>
  call<{ source?: Source; error?: string }>(
    sourceRoutes(person),
    "POST",
    "/",
    body,
  );

/**
 * A machine of `person`'s, paired the way the runner pairs, with a real registry offering `folders`,
 * whose report has been sent over the socket exactly as the runner's heartbeat sends it.
 */
async function machine(person: string, folders: string[]) {
  const deviceId = `${person}-${randomUUID().slice(0, 6)}`;
  const minted = await call<{ code: string }>(
    deviceRoutes(person),
    "POST",
    "/pair",
  );
  const claimed = await call<{ token: string }>(
    runnerRoutes,
    "POST",
    "/register",
    { code: minted.body.code, deviceId, name: "书房电脑", platform: "linux" },
  );
  expect(claimed.status).toBe(201);
  const owner = await devices.deviceForToken(claimed.body.token);
  if (!owner) throw new Error("The paired machine has no owner.");

  const base = mkdtempSync(join(scratch, "m-"));
  const dataDir = join(base, "data");
  const registry = createRootRegistry({ dataDir, privatePaths: [dataDir] });
  const paths: string[] = [];
  for (const name of folders) {
    const path = join(base, "客户资料", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "readme.md"), `${name}\n`);
    registry.add(name, path);
    paths.push(path);
  }
  const sent: string[] = [];
  const socket = { data: { runner: owner }, send: (v: string) => sent.push(v) };
  const beat = (frame = heartbeatFrame(registry)) =>
    runnerMessage(socket, devices, channel, frame);
  await beat();
  expect(sent.at(-1)).toBe(JSON.stringify({ type: "ack" }));
  return { deviceId, registry, paths, base, beat, socket };
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

async function clear(person: string) {
  await runAsTenant(person, () =>
    database
      .delete(avatarSources)
      .where(eq(avatarSources.agentId, avatarAgentId(person))),
  );
}

afterAll(async () => {
  for (const person of everyone) {
    await runAsTenant(person, async () => {
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

describe("what a machine reports", () => {
  test("the heartbeat's folders reach the owner's device list as a reference and a name, and nothing else", async () => {
    const { deviceId, registry } = await machine(personA, ["合同", "周报"]);
    const listed = await call<{
      devices: Array<{ deviceId: string; roots: unknown }>;
    }>(deviceRoutes(personA), "GET", "/");
    const mine = listed.body.devices.find((d) => d.deviceId === deviceId);
    expect(mine?.roots).toEqual(registry.reported());
    expect(registry.reported().map((root) => root.name)).toEqual([
      "合同",
      "周报",
    ]);
    // The other person's list has no machine of A's in it at all.
    const theirs = await call<{ devices: Array<{ deviceId: string }> }>(
      deviceRoutes(personB),
      "GET",
      "/",
    );
    expect(theirs.body.devices.map((d) => d.deviceId)).not.toContain(deviceId);
  });

  test("a beat without a report keeps the folders; an empty report clears them; odd entries and paths are dropped", async () => {
    const { deviceId, beat, registry } = await machine(personA, ["日程"]);
    const rootsOf = async () =>
      (await devices.list(personA)).find((d) => d.deviceId === deviceId)?.roots;
    const [root] = registry.reported();

    await beat(JSON.stringify({ type: "heartbeat" }));
    expect(await rootsOf()).toEqual(registry.reported());

    await beat(
      JSON.stringify({
        type: "heartbeat",
        roots: [
          { ref: root?.ref, name: "  日程  ", path: "/home/me/日程" },
          { ref: root?.ref, name: "重复" },
          { ref: "../../etc", name: "坏的" },
          { ref: "fld_BBBBBBBBBBBBBBBBBBBBBB", name: "" },
          { ref: "fld_CCCCCCCCCCCCCCCCCCCCCC", name: "名".repeat(61) },
          "not an object",
        ],
      }),
    );
    expect(await rootsOf()).toEqual([{ ref: root?.ref, name: "日程" }]);

    await beat(JSON.stringify({ type: "heartbeat", roots: [] }));
    expect(await rootsOf()).toEqual([]);
    expect(reportedRoots("nope")).toBeUndefined();
  });
});

describe("the local apps a machine reports", () => {
  const appRef = (c: string) => `app_${c.repeat(22)}`;

  test("a heartbeat's apps are stored and listed for the owner", async () => {
    const { deviceId, beat } = await machine(personA, []);
    const appsOf = async () =>
      (await devices.list(personA)).find((d) => d.deviceId === deviceId)?.apps;
    await beat(
      JSON.stringify({
        type: "heartbeat",
        apps: [{ ref: appRef("A"), name: "  记账本  " }],
      }),
    );
    expect(await appsOf()).toEqual([{ ref: appRef("A"), name: "记账本" }]);
    const listed = await call<{
      devices: Array<{ deviceId: string; apps: unknown }>;
    }>(deviceRoutes(personA), "GET", "/");
    expect(
      listed.body.devices.find((d) => d.deviceId === deviceId)?.apps,
    ).toEqual([{ ref: appRef("A"), name: "记账本" }]);
  });

  test("malformed apps (bad ref, 41-char name, 21st entry, duplicate) are dropped", async () => {
    const { deviceId, beat } = await machine(personA, []);
    const good = Array.from({ length: 20 }, (_, i) => ({
      ref: `app_${String(i).padStart(22, "x")}`,
      name: `应用${i}`,
    }));
    await beat(
      JSON.stringify({
        type: "heartbeat",
        apps: [
          { ref: "app_short", name: "坏引用" },
          { ref: appRef("B"), name: "名".repeat(41) },
          good[0],
          { ref: good[0]?.ref, name: "重复" },
          ...good.slice(1),
          { ref: appRef("C"), name: "第二十一个" },
          "not an object",
        ],
      }),
    );
    const apps = (await devices.list(personA)).find(
      (d) => d.deviceId === deviceId,
    )?.apps;
    expect(apps).toEqual(good);
    expect(reportedApps("nope")).toBeUndefined();
  });

  test("an older runner without apps keeps []", async () => {
    const { deviceId, beat } = await machine(personA, []);
    await beat(JSON.stringify({ type: "heartbeat", roots: [] }));
    const appsOf = async () =>
      (await devices.list(personA)).find((d) => d.deviceId === deviceId)?.apps;
    expect(await appsOf()).toEqual([]);
    await beat(
      JSON.stringify({
        type: "heartbeat",
        apps: [{ ref: appRef("D"), name: "x" }],
      }),
    );
    await beat(JSON.stringify({ type: "heartbeat" }));
    expect(await appsOf()).toEqual([{ ref: appRef("D"), name: "x" }]);
  });
});

describe("a local folder as an information source", () => {
  test("saving one keeps the machine and the reference; the absolute path is nowhere the server stored anything", async () => {
    const { deviceId, registry, paths, base } = await machine(personA, [
      "工作资料",
    ]);
    const [root] = registry.reported();
    const saved = await addSource(personA, {
      kind: "local_folder",
      deviceId,
      rootRef: root?.ref,
      note: "季度报告和合同",
    });
    expect(saved.status).toBe(201);
    // No name given: the one the machine reports.
    expect(saved.body.source).toMatchObject({
      kind: "local_folder",
      label: "工作资料",
      note: "季度报告和合同",
      deviceId,
      rootRef: root?.ref,
    });

    const state = await call<{ sources: Source[] }>(
      sourceRoutes(personA),
      "GET",
      "/",
    );
    expect(
      state.body.sources.map(({ kind, label }) => ({ kind, label })),
    ).toEqual([{ kind: "local_folder", label: "工作资料" }]);

    // Spec §9 S2: every column of every row the server holds for this person, as text, with no path.
    const stored = await runAsTenant(personA, async () => [
      ...(await database
        .select()
        .from(avatarSources)
        .where(eq(avatarSources.tenantId, personA))),
      ...(await database
        .select()
        .from(registeredDevices)
        .where(eq(registeredDevices.tenantId, personA))),
    ]);
    const text = JSON.stringify(stored);
    expect(text).toContain(root?.ref as string);
    for (const secret of [...paths, base, scratch, "客户资料"]) {
      expect(text).not.toContain(secret);
    }
    // And the database itself, searched for the folder's parent directory in any registered device.
    const [hit] = await runAsTenant("platform", () =>
      database.execute<{ n: number }>(
        sql`select count(*)::int as n from registered_devices where roots::text like ${`%${base}%`} or name like ${`%${base}%`}`,
      ),
    );
    expect(hit?.n).toBe(0);
    await clear(personA);
  });

  test("a folder this person's machines do not report is refused, and so is one already saved", async () => {
    const { deviceId, registry } = await machine(personA, ["周报"]);
    const [root] = registry.reported();
    for (const body of [
      { kind: "local_folder", deviceId, rootRef: "fld_DDDDDDDDDDDDDDDDDDDDDD" },
      { kind: "local_folder", deviceId: "no-such-machine", rootRef: root?.ref },
    ]) {
      expect(await addSource(personA, body)).toEqual({
        status: 400,
        body: {
          error:
            "你的设备上没有这个本地文件夹。请先在设备端添加它，并确认设备已连接。",
        },
      });
    }
    for (const body of [
      { kind: "local_folder", deviceId },
      { kind: "local_folder", rootRef: root?.ref },
      { kind: "local_folder", deviceId, rootRef: "/home/me/周报" },
    ]) {
      expect(await addSource(personA, body)).toEqual({
        status: 400,
        body: { error: "请选择一台设备上的本地文件夹。" },
      });
    }
    expect(
      (
        await addSource(personA, {
          kind: "local_folder",
          deviceId,
          rootRef: root?.ref,
          label: "我的周报",
        })
      ).status,
    ).toBe(201);
    expect(
      await addSource(personA, {
        kind: "local_folder",
        deviceId,
        rootRef: root?.ref,
      }),
    ).toEqual({ status: 409, body: { error: "这个本地文件夹已经登记过了。" } });
    expect(
      await addSource(personA, {
        kind: "local_folder",
        deviceId,
        rootRef: root?.ref,
        label: "名".repeat(61),
      }),
    ).toEqual({ status: 400, body: { error: "名称最多 60 个字。" } });
    await clear(personA);
  });

  test("another person's machine or folder is refused, even with its exact device id and reference", async () => {
    const a = await machine(personA, ["合同"]);
    const [aRoot] = a.registry.reported();
    const b = await machine(personB, ["私人"]);
    const [bRoot] = b.registry.reported();

    // B names A's machine and A's folder: refused, and nothing is stored for B.
    expect(
      await addSource(personB, {
        kind: "local_folder",
        deviceId: a.deviceId,
        rootRef: aRoot?.ref,
      }),
    ).toMatchObject({ status: 400 });
    // B names its own machine with A's reference, and A names B's machine with B's: both refused.
    expect(
      await addSource(personB, {
        kind: "local_folder",
        deviceId: b.deviceId,
        rootRef: aRoot?.ref,
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await addSource(personA, {
        kind: "local_folder",
        deviceId: b.deviceId,
        rootRef: bRoot?.ref,
      }),
    ).toMatchObject({ status: 400 });
    for (const person of everyone) {
      expect(
        await runAsTenant(person, () =>
          database
            .select({ id: avatarSources.id })
            .from(avatarSources)
            .where(eq(avatarSources.tenantId, person)),
        ),
      ).toEqual([]);
    }
    // Each still saves their own.
    expect(
      (
        await addSource(personB, {
          kind: "local_folder",
          deviceId: b.deviceId,
          rootRef: bRoot?.ref,
        })
      ).status,
    ).toBe(201);
    await clear(personB);
  });

  test(`folders and declarations share the limit of ${AVATAR_SOURCE_LIMIT}, and a removal frees a place`, async () => {
    const names = Array.from({ length: 4 }, (_, index) => `文件夹${index + 1}`);
    const { deviceId, registry } = await machine(personA, names);
    for (let index = 0; index < AVATAR_SOURCE_LIMIT - 3; index += 1) {
      expect(
        (
          await addSource(personA, {
            kind: "declaration",
            label: `声明${index}`,
          })
        ).status,
      ).toBe(201);
    }
    const [first, second, third, fourth] = registry.reported();
    for (const root of [first, second, third]) {
      expect(
        (
          await addSource(personA, {
            kind: "local_folder",
            deviceId,
            rootRef: root?.ref,
          })
        ).status,
      ).toBe(201);
    }
    expect(
      await addSource(personA, {
        kind: "local_folder",
        deviceId,
        rootRef: fourth?.ref,
      }),
    ).toMatchObject({ status: 409 });

    const state = await call<{ sources: Source[] }>(
      sourceRoutes(personA),
      "GET",
      "/",
    );
    const folder = state.body.sources.find((s) => s.kind === "local_folder");
    expect(
      (await call(sourceRoutes(personA), "DELETE", `/${folder?.id}`)).status,
    ).toBe(200);
    expect(
      (
        await addSource(personA, {
          kind: "local_folder",
          deviceId,
          rootRef: fourth?.ref,
        })
      ).status,
    ).toBe(201);
    await clear(personA);
  });

  test("other kinds are still refused", async () => {
    for (const kind of ["notebook", "connector", 7]) {
      expect(await addSource(personA, { kind, label: "以后" })).toEqual({
        status: 400,
        body: { error: "目前只支持文字声明和本地文件夹这两种信息来源。" },
      });
    }
  });
});
