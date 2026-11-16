import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { mintRunAssertion } from "../src/agents/callback-token";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import {
  type AppVariables,
  type AuthenticatedActor,
  type AuthService,
  createRequireUser,
} from "../src/auth/guards";
import {
  createGroupConversations,
  createGroupStore,
} from "../src/channels/group";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { loadConfig } from "../src/config";
import type {
  CredentialSecretReader,
  CredentialStore,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  staffingProposals,
  subscriptions,
  users,
} from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import { createPluginStore } from "../src/plugins/store";
import { createPortraitStore } from "../src/portraits/store";
import { createQuotaService, QuotaExceeded } from "../src/quota/limits";
import { createRoutineStore } from "../src/routines/store";
import { parseDraft } from "../src/staffing/draft";
import {
  createStaffingExecutor,
  ProposalRefusedError,
  ProposalStaleError,
} from "../src/staffing/executor";
import {
  createOwnerNameReader,
  createProposalRoutes,
  createThreadVisibility,
} from "../src/staffing/routes";
import { createStaffingProposalStore } from "../src/staffing/store";
import type { Proposal, ProposalKind } from "../src/staffing/types";
import { capabilityFor, runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * 提议的 HTTP 接口：谁能看、谁能动、过期怎么答、机器凭证进不进得来、每一步写了什么轨迹。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `str-${suite}-${name}`;
const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

const profiles = createAgentProfileStore(database, undefined);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profiles, threadIdentity);
const proposals = createStaffingProposalStore(database);
const executor = createStaffingExecutor({
  database,
  proposals,
  profiles,
  quota: createQuotaService(database),
  plugins: createPluginStore({
    database,
    auditStore,
    credentials: {
      readSecret: async () => null,
    } as unknown as CredentialSecretReader & CredentialStore,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  }),
  composioConfigured: false,
  routines: createRoutineStore(database),
  channels: channelStore,
  groups: createGroupConversations({
    store: createGroupStore(database, () => threadIdentity.mint()),
    queue: createWorkQueue(database),
    owner: id("replica"),
    roster: async () => null,
    runTurn: async () => ({ replyText: "ok" }),
    caps: { maxDepth: 1, maxPerRun: 2 },
    mayAddress: async () => true,
    auditStore,
    createChannel: (ownerUserId, agentIds, options) =>
      channelStore.create({ id: ownerUserId, role: "user" }, agentIds, options),
    canUseBot: async () => true,
    progressEveryMs: 0,
  }),
  portraits: createPortraitStore(database),
  auditStore,
});

const people: string[] = [];
const channelIds: string[] = [];

async function person(name: string): Promise<AuthenticatedActor> {
  const userId = id(`${name}-${randomUUID().slice(0, 6)}`);
  await runAsTenant(userId, async () => {
    await database
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name });
    await database
      .insert(subscriptions)
      .values({ tenantId: userId, planId: "pro" });
  });
  people.push(userId);
  return { id: userId, email: `${userId}@example.test`, role: "user" };
}

/**
 * 登录会话认的是 `session=<用户 id>` 这个头；员工运行带的签名凭证不是会话，换不到人。
 * `frameOf` 让「同一租户里的另一个人」的请求跑在主人的帧里。
 */
function appFor(frameOf: (actor: AuthenticatedActor) => string = (a) => a.id) {
  const known = new Map<string, AuthenticatedActor>();
  const auth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const actor = known.get(headers.get("x-session") ?? "");
        return actor
          ? {
              user: {
                id: actor.id,
                email: actor.email,
                role: "user",
                name: actor.id,
                image: null,
              },
            }
          : null;
      },
    },
  } as unknown as AuthService;
  const base = createRequireUser(auth, { rolesForUser: async () => [] });
  const requireUser: typeof base = async (context, next) =>
    base(context, async () => {
      const actor = context.var.actor;
      await runAsTenant(frameOf(actor), () => next());
    });
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/proposals",
    createProposalRoutes(
      proposals,
      executor,
      requireUser,
      createThreadVisibility(database),
      { auditStore, ownerName: createOwnerNameReader(database) },
    ),
  );
  return {
    call: (
      actor: AuthenticatedActor | null,
      path: string,
      init: { method?: string; body?: unknown; headers?: HeadersInit } = {},
    ) => {
      if (actor) known.set(actor.id, actor);
      return app.request(`http://test${path}`, {
        method: init.method ?? "GET",
        headers: {
          "content-type": "application/json",
          ...(actor ? { "x-session": actor.id } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    },
  };
}

const employee = (name: string) => ({
  name,
  title: "运营",
  roleDescription: "负责小红书的日常运营。",
});

async function propose(
  owner: AuthenticatedActor,
  options: {
    threadId?: string | null;
    raw?: unknown;
    kind?: ProposalKind;
  } = {},
) {
  const kind = options.kind ?? "employee";
  const parsed = parseDraft(kind, options.raw ?? employee("小蓝"));
  if (!parsed.ok) throw new Error(parsed.error);
  return runAsTenant(owner.id, () =>
    proposals.create({
      ownerId: owner.id,
      proposedByAgentId: `avatar-${owner.id}`,
      threadId: options.threadId ?? null,
      kind,
      draft: parsed.draft,
      baseVersion: null,
    }),
  );
}

/** 共享群：频道与每个人的成员行都盖 team 戳；主人的线程映射落在主人自己的租户里。返回主人的线程 id。 */
async function sharedGroup(
  owner: AuthenticatedActor,
  members: AuthenticatedActor[],
) {
  const channelId = id(`chan-${randomUUID().slice(0, 6)}`);
  const threadId = id(`thread-${randomUUID().slice(0, 6)}`);
  channelIds.push(channelId);
  await asPlatform(async () => {
    await database.insert(channels).values({
      id: channelId,
      tenantId: TEAM_TENANT,
      name: "小组",
      description: "",
    });
    await database.insert(channelMemberships).values(
      members.map((member) => ({
        channelId,
        userId: member.id,
        tenantId: TEAM_TENANT,
      })),
    );
  });
  await runAsTenant(owner.id, () =>
    database
      .insert(intelligenceChannelMappings)
      .values({ channelId, userId: owner.id, threadId }),
  );
  return threadId;
}

const trailOf = (proposalId: string) =>
  asPlatform(() =>
    database
      .select({
        eventType: auditEvents.eventType,
        actorUserId: auditEvents.actorUserId,
      })
      .from(auditEvents)
      .where(sql`${auditEvents.payload}->>'proposalId' = ${proposalId}`),
  );

const statusOf = async (proposalId: string) =>
  (
    await asPlatform(() =>
      database
        .select({ status: staffingProposals.status })
        .from(staffingProposals)
        .where(eq(staffingProposals.id, proposalId)),
    )
  )[0]?.status;

afterAll(async () => {
  await asPlatform(async () => {
    const bots = (
      await database
        .select({ id: agentProfiles.agentId })
        .from(agentProfiles)
        .where(inArray(agentProfiles.ownerUserId, people))
    ).map((row) => row.id);
    if (channelIds.length) {
      await database
        .delete(intelligenceChannelMappings)
        .where(inArray(intelligenceChannelMappings.channelId, channelIds));
      await database.delete(channels).where(inArray(channels.id, channelIds));
    }
    await database
      .delete(staffingProposals)
      .where(inArray(staffingProposals.ownerId, people));
    if (bots.length) {
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, bots));
      await database.delete(agents).where(inArray(agents.id, bots));
    }
    await database
      .delete(subscriptions)
      .where(inArray(subscriptions.tenantId, people));
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.close();
});

describe("staffing proposal routes", () => {
  test("only the owner can apply, edit or discard", async () => {
    const owner = await person("owner");
    const colleague = await person("colleague");
    const stranger = await person("stranger");
    const bystander = await person("bystander");
    const threadId = await sharedGroup(owner, [owner, colleague]);
    const proposal = await propose(owner, { threadId });
    // 同一租户里的另一个人（跑在主人的帧里）：在群里的看得到、不能动（403）；不在群里的和读不到一样（404）。
    const sameTenant = appFor((actor) =>
      actor.id === colleague.id || actor.id === bystander.id
        ? owner.id
        : actor.id,
    );
    const attempts = [
      ["PATCH", "", { draft: employee("改名") }],
      ["POST", "/apply", undefined],
      ["POST", "/discard", undefined],
      ["POST", "/retry", undefined],
    ] as const;
    for (const [method, suffix, body] of attempts) {
      const response = await sameTenant.call(
        colleague,
        `/api/proposals/${proposal.id}${suffix}`,
        { method, body },
      );
      expect(response.status).toBe(403);
    }
    for (const [method, suffix, body] of attempts) {
      const response = await sameTenant.call(
        bystander,
        `/api/proposals/${proposal.id}${suffix}`,
        { method, body },
      );
      expect(response.status).toBe(404);
    }
    // 别的租户：行安全让这份提议根本读不到。
    const elsewhere = appFor();
    for (const [method, suffix, body] of attempts) {
      const response = await elsewhere.call(
        stranger,
        `/api/proposals/${proposal.id}${suffix}`,
        { method, body },
      );
      expect(response.status).toBe(404);
    }
    expect(await statusOf(proposal.id)).toBe("pending");
    expect(
      await asPlatform(() =>
        database
          .select({ id: agentProfiles.agentId })
          .from(agentProfiles)
          .where(
            inArray(agentProfiles.ownerUserId, [
              colleague.id,
              bystander.id,
              stranger.id,
            ]),
          ),
      ),
    ).toEqual([]);

    // 主人自己可以。
    const mine = appFor();
    const read = await mine.call(owner, `/api/proposals/${proposal.id}`);
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      canAct: boolean;
      proposal: { id: string };
    };
    expect(body.canAct).toBe(true);
    expect(body.proposal.id).toBe(proposal.id);
    const discarded = await mine.call(
      owner,
      `/api/proposals/${proposal.id}/discard`,
      {
        method: "POST",
      },
    );
    expect(discarded.status).toBe(200);
    expect(await statusOf(proposal.id)).toBe("discarded");
    const again = await mine.call(
      owner,
      `/api/proposals/${proposal.id}/apply`,
      {
        method: "POST",
      },
    );
    expect(again.status).toBe(409);
  });

  test("a person in the same group sees a summary without actions", async () => {
    const owner = await person("owner");
    const member = await person("member");
    const outsider = await person("outsider");
    const threadId = await sharedGroup(owner, [owner, member]);
    const proposal = await propose(owner, { threadId });
    const sameTenant = appFor(() => owner.id);

    const seen = await sameTenant.call(member, `/api/proposals/${proposal.id}`);
    expect(seen.status).toBe(200);
    const body = (await seen.json()) as Record<string, unknown>;
    expect(body).toEqual({
      summary: {
        kind: "employee",
        title: "小蓝",
        ownerName: "owner",
        status: "pending",
      },
      canAct: false,
    });
    expect(JSON.stringify(body)).not.toContain("draft");

    const notInGroup = await sameTenant.call(
      outsider,
      `/api/proposals/${proposal.id}`,
    );
    expect(notInGroup.status).toBe(404);
  });

  test("an expired proposal answers 410", async () => {
    const owner = await person("owner");
    const proposal = await propose(owner);
    await runAsTenant(owner.id, () =>
      database
        .update(staffingProposals)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(staffingProposals.id, proposal.id)),
    );
    const mine = appFor();
    for (const attempt of [1, 2]) {
      const response = await mine.call(
        owner,
        `/api/proposals/${proposal.id}/apply`,
        { method: "POST" },
      );
      expect(`${attempt}:${response.status}`).toBe(`${attempt}:410`);
    }
    // 改草稿、作废答 409：这两件事对一份已过期的提议是「状态不允许」，只有确认才说「已过期」。
    const edit = await mine.call(owner, `/api/proposals/${proposal.id}`, {
      method: "PATCH",
      body: { draft: employee("改名") },
    });
    expect(edit.status).toBe(409);
    const discard = await mine.call(
      owner,
      `/api/proposals/${proposal.id}/discard`,
      { method: "POST" },
    );
    expect(discard.status).toBe(409);
    expect(await statusOf(proposal.id)).toBe("expired");
    const trail = await trailOf(proposal.id);
    expect(trail.map((event) => event.eventType)).toEqual([
      "staffing.proposal_expired",
    ]);
  });

  test("a run's machine credential is refused", async () => {
    const owner = await person("owner");
    const proposal = await propose(owner);
    const assertion = mintRunAssertion(
      {
        agentId: `avatar-${owner.id}`,
        userId: owner.id,
      } as Parameters<typeof mintRunAssertion>[0],
      "x".repeat(44),
    );
    const mine = appFor();
    for (const suffix of ["/apply", "/discard", "/retry"]) {
      const response = await mine.call(
        null,
        `/api/proposals/${proposal.id}${suffix}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${assertion}` },
        },
      );
      expect(response.status).toBe(401);
    }
    const read = await mine.call(null, `/api/proposals/${proposal.id}`, {
      headers: { authorization: `Bearer ${assertion}` },
    });
    expect(read.status).toBe(401);
    expect(await statusOf(proposal.id)).toBe("pending");
  });

  test("each step writes an audit row carrying the proposal id", async () => {
    const owner = await person("owner");
    const mine = appFor();

    const edited = await propose(owner);
    const patch = await mine.call(owner, `/api/proposals/${edited.id}`, {
      method: "PATCH",
      body: { draft: employee("小绿") },
    });
    expect(patch.status).toBe(200);
    const discard = await mine.call(
      owner,
      `/api/proposals/${edited.id}/discard`,
      {
        method: "POST",
      },
    );
    expect(discard.status).toBe(200);
    expect(
      (await trailOf(edited.id)).map((event) => event.eventType).sort(),
    ).toEqual(["staffing.proposal_discarded", "staffing.proposal_edited"]);

    const applied = await propose(owner, { raw: employee("小黄") });
    const apply = await mine.call(owner, `/api/proposals/${applied.id}/apply`, {
      method: "POST",
    });
    expect(apply.status).toBe(200);
    const result = (await apply.json()) as { proposal: { status: string } };
    expect(result.proposal.status).toBe("applied");
    const trail = await trailOf(applied.id);
    expect(trail.map((event) => event.eventType)).toContain(
      "staffing.proposal_applied",
    );
    expect(trail.every((event) => event.actorUserId === owner.id)).toBe(true);
    expect(
      await asPlatform(() =>
        database
          .select({ name: agents.name })
          .from(agents)
          .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
          .where(and(eq(agentProfiles.ownerUserId, owner.id))),
      ),
    ).toEqual([{ name: "小黄" }]);
  });

  describe("error mapping", () => {
    const failing = (error: Error) =>
      createProposalRoutes(
        proposals,
        {
          apply: async () => {
            throw error;
          },
          retry: async () => {
            throw error;
          },
        } as unknown as Parameters<typeof createProposalRoutes>[1],
        async (context, next) => {
          context.set("actor", ownerActor);
          await runAsTenant(ownerActor.id, () => next());
        },
        async () => false,
      );
    let ownerActor: AuthenticatedActor;
    const post = async (error: Error) => {
      ownerActor = await person("owner");
      const proposal = await propose(ownerActor);
      const response = await failing(error).request(
        `http://test/${proposal.id}/apply`,
        { method: "POST" },
      );
      return { status: response.status, body: await response.json() };
    };

    test("a stale draft answers 409 with the redraft sentence", async () => {
      expect(await post(new ProposalStaleError())).toEqual({
        status: 409,
        body: { error: "内容已变化，请让小管家重新起草。" },
      });
    });

    test("a full plan answers 402 with the quota body", async () => {
      const error = new QuotaExceeded("wakers", 2, 2, "free");
      expect(await post(error)).toEqual({ status: 402, body: error.body });
    });

    test("a capability refusal answers 403 and a draft refusal 400", async () => {
      expect(
        await post(new ProposalRefusedError("管理员没有开放这项能力。", true)),
      ).toEqual({ status: 403, body: { error: "管理员没有开放这项能力。" } });
      expect(
        await post(new ProposalRefusedError("名字需要 1 到 80 个字符。")),
      ).toEqual({ status: 400, body: { error: "名字需要 1 到 80 个字符。" } });
    });

    test("an edit the draft check rejects answers 400 and changes nothing", async () => {
      const owner = await person("owner");
      const proposal = await propose(owner);
      const response = await appFor().call(
        owner,
        `/api/proposals/${proposal.id}`,
        { method: "PATCH", body: { draft: { name: "", title: "x" } } },
      );
      expect(response.status).toBe(400);
      const read = await runAsTenant(owner.id, () =>
        proposals.get(proposal.id),
      );
      expect(read?.draft).toEqual(proposal.draft);
    });
  });

  test("createApp mounts the routes with the admin capability in effect", async () => {
    const seen: { who: string; capability: string }[] = [];
    const person = (who: string): Proposal => ({
      id: "p1",
      ownerId: who,
      proposedByAgentId: "a",
      threadId: null,
      kind: "employee",
      draft: employee("小蓝") as unknown as Proposal["draft"],
      baseVersion: null,
      status: "applied",
      result: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    });
    const users = new Map([
      ["admin-user", { id: "admin-user", role: "admin" }],
      ["plain-user", { id: "plain-user", role: "user" }],
    ]);
    const args: never[] = Array.from({ length: 34 }) as never[];
    args[0] = loadConfig(testEnvironment()) as never;
    args[1] = {
      handler: () => new Response(null, { status: 204 }),
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const found = users.get(headers.get("x-session") ?? "");
          return found
            ? {
                user: {
                  id: found.id,
                  email: `${found.id}@example.test`,
                  role: found.role,
                  name: found.id,
                  image: null,
                },
              }
            : null;
        },
      },
    } as never;
    args[2] = {
      rolesForUser: async (userId: string) => [users.get(userId)?.role],
    } as never;
    args[33] = {
      staffing: {
        store: {
          expireIfLapsed: async () => false,
          get: async (proposalId: string) => person(proposalId),
        },
        executor: {
          apply: async (actor: { id: string }) => {
            seen.push({ who: actor.id, capability: capabilityFor(actor.id) });
            return person(actor.id);
          },
        },
        canSeeThread: async () => false,
      },
    } as never;
    const app = createApp(...args);
    const apply = (session: string | null, as: string) =>
      app.request(`http://test/api/proposals/${as}/apply`, {
        method: "POST",
        headers: session ? { "x-session": session } : {},
      });
    expect((await apply("admin-user", "admin-user")).status).toBe(200);
    expect((await apply("plain-user", "plain-user")).status).toBe(200);
    expect(seen).toEqual([
      { who: "admin-user", capability: "admin" },
      { who: "plain-user", capability: "" },
    ]);
    expect((await apply(null, "admin-user")).status).toBe(401);
  });
});
