import { expect, test } from "bun:test";
import { Hono } from "hono";
import {
  createHardModelRoutes,
  HARD_MODEL_EXTERNAL_REFUSAL,
  type HardModelStore,
} from "../src/agents/hard-model-routes";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";
import type { AuditEventInput, AuditStore } from "../src/audit";

/**
 * 员工设置里的「难任务模型」（期七界面）：读、写、权限。能选的是对话里模型选择器那份目录；只有能编辑这位员工
 * 的人（主人、管理员）能改；别人看不到的员工是 404；外部员工没有这个设置。
 */

const ALLOWED = ["openai/gpt-6", "openai/gpt-6-mini"];

type Row = { type: string; hardModel: string | null; owner: string | null };

function fixture(rows: Record<string, Row>) {
  const writes: { agentId: string; hardModel: string | null }[] = [];
  const events: AuditEventInput[] = [];
  const store: HardModelStore = {
    read: async (agentId) => {
      const row = rows[agentId];
      return row ? { type: row.type, hardModel: row.hardModel } : null;
    },
    write: async (agentId, hardModel) => {
      const row = rows[agentId];
      // 别人名下的员工：这个人的帧里写不进去。
      if (!row || row.owner === "someone-else") return false;
      row.hardModel = hardModel;
      writes.push({ agentId, hardModel });
      return true;
    },
  };
  const profiles = {
    get: async (actor: AgentActor, id: string) => {
      const row = rows[id];
      if (!row) return null;
      // 私人员工只有主人（和管理员）看得到。
      if (row.owner !== actor.id && actor.role !== "admin") return null;
      return {
        id,
        visibility: "private",
        ownerUserId: row.owner,
        systemOwned: false,
        deletedAt: null,
      } as unknown as AgentProfile;
    },
  };
  const auditStore = {
    insert: async (event: AuditEventInput) => {
      events.push(event);
    },
  } as unknown as AuditStore;
  const appFor = (actor: AgentActor | null) =>
    new Hono().route(
      "/api/agents",
      createHardModelRoutes({
        store,
        profiles,
        allowed: async () => ALLOWED,
        auditStore,
        requireUser: async (context, next) => {
          if (!actor) return context.json({ error: "Sign in" }, 401);
          context.set("actor", { ...actor, email: `${actor.id}@example.com` });
          await next();
        },
      }),
    );
  return { appFor, writes, events };
}

const put = (body: unknown) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const alice: AgentActor = { id: "alice", role: "user" };
const bob: AgentActor = { id: "bob", role: "user" };
const admin: AgentActor = { id: "root", role: "admin" };

test("主人读到存着的难任务模型，没设置读到 null", async () => {
  const { appFor } = fixture({
    set: { type: "built_in", hardModel: "openai/gpt-6", owner: "alice" },
    unset: { type: "built_in", hardModel: null, owner: "alice" },
  });
  const app = appFor(alice);
  const set = await app.request("/api/agents/set/hard-model");
  expect(set.status).toBe(200);
  expect(await set.json()).toEqual({ hardModel: "openai/gpt-6" });
  expect(
    await (await app.request("/api/agents/unset/hard-model")).json(),
  ).toEqual({ hardModel: null });
});

test("主人存一个目录里的模型：存下、记一条审计，再读回来", async () => {
  const { appFor, writes, events } = fixture({
    mine: { type: "built_in", hardModel: null, owner: "alice" },
  });
  const app = appFor(alice);
  const saved = await app.request(
    "/api/agents/mine/hard-model",
    put({ hardModel: "openai/gpt-6-mini" }),
  );
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ hardModel: "openai/gpt-6-mini" });
  expect(writes).toEqual([{ agentId: "mine", hardModel: "openai/gpt-6-mini" }]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    eventType: "bot.updated",
    targetId: "mine",
    actorUserId: "alice",
  });
  expect(
    await (await app.request("/api/agents/mine/hard-model")).json(),
  ).toEqual({ hardModel: "openai/gpt-6-mini" });
});

test("留空或 null 是清掉；同一个值再存一次什么也不写", async () => {
  const { appFor, writes } = fixture({
    mine: { type: "built_in", hardModel: "openai/gpt-6", owner: "alice" },
  });
  const app = appFor(alice);
  expect(
    (await app.request("/api/agents/mine/hard-model", put({ hardModel: "" })))
      .status,
  ).toBe(200);
  expect(writes).toEqual([{ agentId: "mine", hardModel: null }]);
  const again = await app.request(
    "/api/agents/mine/hard-model",
    put({ hardModel: null }),
  );
  expect(await again.json()).toEqual({ hardModel: null });
  expect(writes).toHaveLength(1);
});

test("不在目录里的模型名一律 400，不存", async () => {
  const { appFor, writes } = fixture({
    mine: { type: "built_in", hardModel: null, owner: "alice" },
  });
  const response = await appFor(alice).request(
    "/api/agents/mine/hard-model",
    put({ hardModel: "someone-else/secret-model" }),
  );
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toContain(
    "someone-else/secret-model",
  );
  expect(writes).toEqual([]);
});

test("形状不对的 body 400", async () => {
  const { appFor } = fixture({
    mine: { type: "built_in", hardModel: null, owner: "alice" },
  });
  const app = appFor(alice);
  for (const body of [{}, { hardModel: 5 }, { hardModel: "x", extra: 1 }, []])
    expect(
      (await app.request("/api/agents/mine/hard-model", put(body))).status,
    ).toBe(400);
});

test("别人看不到的员工：读、写都是 404，什么也没存", async () => {
  const { appFor, writes } = fixture({
    mine: { type: "built_in", hardModel: null, owner: "alice" },
  });
  const app = appFor(bob);
  expect((await app.request("/api/agents/mine/hard-model")).status).toBe(404);
  expect(
    (
      await app.request(
        "/api/agents/mine/hard-model",
        put({ hardModel: "openai/gpt-6" }),
      )
    ).status,
  ).toBe(404);
  expect((await app.request("/api/agents/nobody/hard-model")).status).toBe(404);
  expect(writes).toEqual([]);
});

test("能看到但不能编辑的人改不了：403，读照样读得到", async () => {
  // 公开的员工，别人看得到、管不了。
  const writes: unknown[] = [];
  const app = new Hono().route(
    "/api/agents",
    createHardModelRoutes({
      store: {
        read: async () => ({ type: "built_in", hardModel: null }),
        write: async (...args) => {
          writes.push(args);
          return true;
        },
      },
      profiles: {
        get: async () =>
          ({
            id: "shared",
            visibility: "public",
            ownerUserId: "alice",
            systemOwned: false,
            deletedAt: null,
          }) as unknown as AgentProfile,
      },
      allowed: async () => ALLOWED,
      requireUser: async (context, next) => {
        context.set("actor", { ...bob, email: "bob@example.com" });
        await next();
      },
    }),
  );
  const response = await app.request(
    "/api/agents/shared/hard-model",
    put({ hardModel: "openai/gpt-6" }),
  );
  expect(response.status).toBe(403);
  expect((await app.request("/api/agents/shared/hard-model")).status).toBe(200);
  expect(writes).toEqual([]);
});

test("管理员改得了别人的员工，只要那一行在他的帧里写得进去；写不进去是 403", async () => {
  const { appFor, writes } = fixture({
    theirs: { type: "built_in", hardModel: null, owner: "alice" },
    foreign: { type: "built_in", hardModel: null, owner: "someone-else" },
  });
  const app = appFor(admin);
  expect(
    (
      await app.request(
        "/api/agents/theirs/hard-model",
        put({ hardModel: "openai/gpt-6" }),
      )
    ).status,
  ).toBe(200);
  const refused = await app.request(
    "/api/agents/foreign/hard-model",
    put({ hardModel: "openai/gpt-6" }),
  );
  expect(refused.status).toBe(403);
  expect(writes).toEqual([{ agentId: "theirs", hardModel: "openai/gpt-6" }]);
});

test("外部员工没有这个设置：读、写都是 400", async () => {
  const { appFor, writes } = fixture({
    codex: { type: "device_acp", hardModel: null, owner: "alice" },
  });
  const app = appFor(alice);
  const read = await app.request("/api/agents/codex/hard-model");
  expect(read.status).toBe(400);
  expect(await read.json()).toEqual({ error: HARD_MODEL_EXTERNAL_REFUSAL });
  expect(
    (
      await app.request(
        "/api/agents/codex/hard-model",
        put({ hardModel: "openai/gpt-6" }),
      )
    ).status,
  ).toBe(400);
  expect(writes).toEqual([]);
});

test("没登录是 401", async () => {
  const { appFor } = fixture({});
  expect((await appFor(null).request("/api/agents/x/hard-model")).status).toBe(
    401,
  );
});
