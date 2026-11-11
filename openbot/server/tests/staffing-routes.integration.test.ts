import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { mintRunAssertion } from "../src/agents/callback-token";
import { createAgentProfileStore } from "../src/agents/profile-store";
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
import { createQuotaService } from "../src/quota/limits";
import { createRoutineStore } from "../src/routines/store";
import { parseDraft } from "../src/staffing/draft";
import { createStaffingExecutor } from "../src/staffing/executor";
import {
  createOwnerNameReader,
  createProposalRoutes,
  createThreadVisibility,
} from "../src/staffing/routes";
import { createStaffingProposalStore } from "../src/staffing/store";
import type { ProposalKind } from "../src/staffing/types";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

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
    const proposal = await propose(owner);
    // 同一租户里的另一个人（跑在主人的帧里）：读得到、不能动。
    const sameTenant = appFor((actor) =>
      actor.id === colleague.id ? owner.id : actor.id,
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
            inArray(agentProfiles.ownerUserId, [colleague.id, stranger.id]),
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
    const channelId = id(`chan-${randomUUID().slice(0, 6)}`);
    const threadId = id(`thread-${randomUUID().slice(0, 6)}`);
    channelIds.push(channelId);
    // 共享群：频道与每个人的成员行都盖 team 戳；主人的线程映射落在主人自己的租户里。
    await asPlatform(async () => {
      await database.insert(channels).values({
        id: channelId,
        tenantId: TEAM_TENANT,
        name: "小组",
        description: "",
      });
      await database.insert(channelMemberships).values(
        [owner.id, member.id].map((userId) => ({
          channelId,
          userId,
          tenantId: TEAM_TENANT,
        })),
      );
    });
    await runAsTenant(owner.id, () =>
      database
        .insert(intelligenceChannelMappings)
        .values({ channelId, userId: owner.id, threadId }),
    );
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
    for (const path of ["apply"]) {
      const first = await mine.call(
        owner,
        `/api/proposals/${proposal.id}/${path}`,
        {
          method: "POST",
        },
      );
      expect(first.status).toBe(410);
      const second = await mine.call(
        owner,
        `/api/proposals/${proposal.id}/${path}`,
        {
          method: "POST",
        },
      );
      expect(second.status).toBe(410);
    }
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
});
