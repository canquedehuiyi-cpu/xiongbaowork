import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
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
  pluginGrants,
  staffingProposals,
  subscriptions,
  users,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { createPortraitStore } from "../src/portraits/store";
import { createQuotaService } from "../src/quota/limits";
import { createRoutineStore } from "../src/routines/store";
import { parseDraft } from "../src/staffing/draft";
import {
  createStaffingExecutor,
  currentEmployeeVersion,
  type StaffingExecutorDeps,
} from "../src/staffing/executor";
import {
  createProposalRoutes,
  createThreadVisibility,
} from "../src/staffing/routes";
import {
  createStaffingProposalStore,
  STALE_APPLYING_MS,
  type StaffingProposalStore,
} from "../src/staffing/store";
import type { ProposalKind, ResultItem } from "../src/staffing/types";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 提议不会永远停在「执行中」：建好的员工一建好就记进行里，落定出了意外也有退路，读的时候把停得太久的
 * 「执行中」落成部分完成或待确认；全部失败的提议可以作废；读不出 uuid 的 id 是 404；新员工没有单独的
 * 工作指令。每一条都看库里留下了什么。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `sst-${suite}-${name}`;
const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

const profiles = createAgentProfileStore(database, undefined);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profiles, threadIdentity);
const proposals = createStaffingProposalStore(database);

const baseDeps: StaffingExecutorDeps = {
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
  mayUse: async () => true,
};

/** 同一个执行器，提议存储换成会在指定的那几次落定时出错的。 */
function executorWith(store: StaffingProposalStore) {
  return createStaffingExecutor({ ...baseDeps, proposals: store });
}

const people: string[] = [];

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

const employee = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  title: "运营",
  roleDescription: "负责小红书的日常运营。",
  ...extra,
});

async function propose(
  owner: AuthenticatedActor,
  kind: ProposalKind,
  raw: unknown,
  baseVersion: string | null = null,
) {
  const parsed = parseDraft(kind, raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return runAsTenant(owner.id, () =>
    proposals.create({
      ownerId: owner.id,
      proposedByAgentId: `avatar-${owner.id}`,
      threadId: null,
      kind,
      draft: parsed.draft,
      baseVersion,
    }),
  );
}

const stored = async (proposalId: string) =>
  (
    await asPlatform(() =>
      database
        .select({
          status: staffingProposals.status,
          result: staffingProposals.result,
        })
        .from(staffingProposals)
        .where(eq(staffingProposals.id, proposalId)),
    )
  )[0];

const ownedBots = (ownerId: string) =>
  asPlatform(() =>
    database
      .select({ id: agentProfiles.agentId })
      .from(agentProfiles)
      .where(eq(agentProfiles.ownerUserId, ownerId)),
  );

/** 把一份提议写成「执行中」，并把它最后一次被写的时间拨回 `ago` 毫秒之前。 */
async function stuck(
  proposalId: string,
  ago: number,
  result: ResultItem[] | null,
) {
  await asPlatform(() =>
    database
      .update(staffingProposals)
      .set({
        status: "applying",
        result: result as unknown as Record<string, unknown> | null,
        updatedAt: sql`now() - make_interval(secs => ${ago / 1000})`,
      })
      .where(eq(staffingProposals.id, proposalId)),
  );
}

class Unplugged extends Error {}

/** 登录会话认 `x-session` 头；每个请求在本人的帧里跑。 */
function appFor() {
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
      await runAsTenant(context.var.actor.id, () => next());
    });
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/proposals",
    createProposalRoutes(
      proposals,
      executorWith(proposals),
      requireUser,
      createThreadVisibility(database),
      { auditStore },
    ),
  );
  return (actor: AuthenticatedActor, path: string, method = "GET") => {
    known.set(actor.id, actor);
    return app.request(`http://test${path}`, {
      method,
      headers: { "content-type": "application/json", "x-session": actor.id },
    });
  };
}

afterAll(async () => {
  await asPlatform(async () => {
    const bots = (
      await database
        .select({ id: agentProfiles.agentId })
        .from(agentProfiles)
        .where(inArray(agentProfiles.ownerUserId, people))
    ).map((row) => row.id);
    await database
      .delete(staffingProposals)
      .where(inArray(staffingProposals.ownerId, people));
    if (bots.length) {
      await database
        .delete(pluginGrants)
        .where(inArray(pluginGrants.agentId, bots));
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

describe("a proposal never stays applying", () => {
  test("the created employee is on the row before anything else can fail", async () => {
    const owner = await person("created");
    const proposal = await propose(owner, "employee", employee("先记下"));
    // 每一次落定都失败（数据库断开的样子）：行停在执行中，但建好的员工已经在结果里。
    const unplugged = executorWith({
      ...proposals,
      finish: async () => {
        throw new Unplugged("finish");
      },
      release: async () => {
        throw new Unplugged("release");
      },
    });

    await expect(
      runAsTenant(owner.id, () => unplugged.apply(owner, proposal.id)),
    ).rejects.toBeInstanceOf(Unplugged);

    const [bot] = await ownedBots(owner.id);
    if (!bot) throw new Error("no bot was created");
    const row = await stored(proposal.id);
    expect(row?.status).toBe("applying");
    expect(
      ((row?.result ?? []) as ResultItem[]).map((item) => [
        item.step,
        item.target,
        item.outcome,
      ]),
    ).toEqual([["create", bot.id, "done"]]);

    // 停得够久之后读它，落成部分完成；重试只补没做完的，不再建第二位员工。
    await stuck(proposal.id, STALE_APPLYING_MS + 60_000, row?.result as never);
    const settled = await runAsTenant(owner.id, () =>
      proposals.get(proposal.id),
    );
    expect(settled?.status).toBe("partially_applied");
    const retried = await runAsTenant(owner.id, () =>
      executorWith(proposals).retry(owner, proposal.id),
    );
    expect(retried.status).toBe("applied");
    expect(await ownedBots(owner.id)).toHaveLength(1);
  });

  test("a finish that throws falls back to settling the proposal", async () => {
    const owner = await person("finish");
    const proposal = await propose(owner, "employee", employee("落定一次"));
    let finishes = 0;
    const flaky = executorWith({
      ...proposals,
      finish: async (...args: Parameters<StaffingProposalStore["finish"]>) => {
        finishes += 1;
        if (finishes === 1) throw new Unplugged("finish");
        return proposals.finish(...args);
      },
    });

    await expect(
      runAsTenant(owner.id, () => flaky.apply(owner, proposal.id)),
    ).rejects.toBeInstanceOf(Unplugged);

    const row = await stored(proposal.id);
    expect(row?.status).toBe("partially_applied");
    expect(
      ((row?.result ?? []) as ResultItem[]).map((item) => item.step),
    ).toEqual(["create"]);
  });

  test("an applying row with results read after the cutoff settles as partially applied", async () => {
    const owner = await person("stale-results");
    const proposal = await propose(owner, "employee", employee("旧的"));
    const kept: ResultItem[] = [
      { step: "create", target: "some-bot", outcome: "done", message: "好" },
    ];
    await stuck(proposal.id, STALE_APPLYING_MS + 60_000, kept);

    const read = await runAsTenant(owner.id, () => proposals.get(proposal.id));

    expect(read?.status).toBe("partially_applied");
    expect(read?.result).toEqual(kept);
    expect((await stored(proposal.id))?.status).toBe("partially_applied");
  });

  test("an applying row without results read after the cutoff goes back to pending", async () => {
    const owner = await person("stale-empty");
    const proposal = await propose(owner, "employee", employee("没做"));
    await stuck(proposal.id, STALE_APPLYING_MS + 60_000, null);

    const response = await appFor()(owner, `/api/proposals/${proposal.id}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { proposal: { status: string } };
    expect(body.proposal.status).toBe("pending");
    expect((await stored(proposal.id))?.status).toBe("pending");
  });

  test("an applying row that is still being worked on is left alone", async () => {
    const owner = await person("fresh");
    const proposal = await propose(owner, "employee", employee("正在做"));
    await stuck(proposal.id, 1000, null);

    const read = await runAsTenant(owner.id, () => proposals.get(proposal.id));

    expect(read?.status).toBe("applying");
  });
});

describe("a proposal whose every step failed", () => {
  test("can be discarded", async () => {
    const owner = await person("all-failed");
    const proposal = await propose(owner, "group_change", {
      channelId: id("no-such-group"),
      name: "新名字",
    });
    await asPlatform(() =>
      database
        .update(staffingProposals)
        .set({
          status: "partially_applied",
          result: [
            {
              step: "rename",
              target: "新名字",
              outcome: "failed",
              message: "找不到这个群聊。",
            },
          ] as unknown as Record<string, unknown>,
        })
        .where(eq(staffingProposals.id, proposal.id)),
    );

    const response = await appFor()(
      owner,
      `/api/proposals/${proposal.id}/discard`,
      "POST",
    );

    expect(response.status).toBe(200);
    expect((await stored(proposal.id))?.status).toBe("discarded");
  });

  test("an applied proposal still cannot be discarded", async () => {
    const owner = await person("applied");
    const proposal = await propose(owner, "employee", employee("做完了"));
    await runAsTenant(owner.id, () =>
      executorWith(proposals).apply(owner, proposal.id),
    );

    const response = await appFor()(
      owner,
      `/api/proposals/${proposal.id}/discard`,
      "POST",
    );

    expect(response.status).toBe(409);
    expect((await stored(proposal.id))?.status).toBe("applied");
  });
});

describe("an id that is not a uuid", () => {
  test("is not found on every route rather than a server error", async () => {
    const owner = await person("not-uuid");
    const call = appFor();
    for (const [method, path] of [
      ["GET", "/api/proposals/not-a-uuid"],
      ["PATCH", "/api/proposals/not-a-uuid"],
      ["POST", "/api/proposals/not-a-uuid/apply"],
      ["POST", "/api/proposals/not-a-uuid/retry"],
      ["POST", "/api/proposals/not-a-uuid/discard"],
    ] as const) {
      const response = await call(owner, path, method);
      expect([method, path, response.status]).toEqual([method, path, 404]);
      expect(await response.json()).toEqual({ error: "找不到这份提议。" });
    }
  });
});

describe("work instructions", () => {
  test("a new employee's draft keeps no separate instructions and says so", () => {
    const parsed = parseDraft(
      "employee",
      employee("没有指令", { instructions: "每天先看邮件。" }),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect("instructions" in parsed.draft).toBe(false);
    expect(parsed.dropped.map((item) => item.field)).toEqual(["instructions"]);
  });

  test("a change that only sets instructions on an ordinary employee is refused by name", async () => {
    const owner = await person("instructions");
    const made = await propose(owner, "employee", employee("普通员工"));
    await runAsTenant(owner.id, () =>
      executorWith(proposals).apply(owner, made.id),
    );
    const [bot] = await ownedBots(owner.id);
    if (!bot) throw new Error("no bot was created");
    const base = await runAsTenant(owner.id, () =>
      currentEmployeeVersion(database, bot.id),
    );
    const change = await propose(
      owner,
      "employee_change",
      { agentId: bot.id, set: { instructions: "改成先看日程。" } },
      base,
    );

    const applied = await runAsTenant(owner.id, () =>
      executorWith(proposals).apply(owner, change.id),
    );

    expect(applied.status).toBe("partially_applied");
    expect(
      (applied.result ?? []).map((item) => [item.step, item.outcome]),
    ).toEqual([["update", "failed"]]);
    expect(applied.result?.[0]?.message).toBe(
      "这位员工没有单独的工作指令，它按职责描述工作；要改它的做法，请改职责描述。",
    );
  });
});
