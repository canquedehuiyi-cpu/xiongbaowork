import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { approvalAction } from "../src/approvals/types";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { approvalRequests } from "../src/db/schema/approvals";
import { workItems } from "../src/db/schema/work";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 审批记下「在哪决定的」（计划 2026-11-16-im-channels-wechat Task 11；规格验收第 203、213 行：网页上显示
 * 「已由 某某 在 微信 批准」）。真的库、真的审批 store 和服务、真的审批路由。
 *
 * - 网页（`POST /api/approvals/:id/decision`）决定的记 `web`；审批服务按调用方说的渠道记（微信、Slack、Teams）。
 * - 读接口（一条、收件箱）带出 `decidedVia`；还在等的、规则放行的是 null。
 * - 迁移 0229 在已有审批行上：只加一列可空的 `decided_via` 和取值约束，旧行为 null。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createApprovalStore(database);
const service = createApprovalService(store);
const suite = randomUUID().slice(0, 8);
const owner = `via-${suite}-owner`;
const approvalIds: string[] = [];

const actorFor =
  (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", { id, email: `${id}@openbot.test`, role: "user" });
    await next();
  };
const routes = createApprovalRoutes(service, actorFor(owner));
const call = (path: string, init?: RequestInit) =>
  runAsTenant(owner, () =>
    routes.request(new Request(`http://openbot.test${path}`, init)),
  );

async function pending(label: string) {
  const request = await runAsTenant(owner, () =>
    store.open(
      approvalAction({
        actorId: owner,
        botId: `bot-${suite}`,
        toolRef: "files/delete",
        effect: "write",
        scope: "~/build",
        args: { path: `~/build/${label}` },
        continuation: {
          runId: `run-${label}-${suite}`,
          threadId: `thread-${suite}`,
          toolCallId: randomUUID(),
          toolName: "files__delete",
          args: { path: `~/build/${label}` },
          messages: [],
          state: {},
          context: [],
          forwardedProps: {},
        },
      }),
    ),
  );
  approvalIds.push(request.id);
  return request;
}
const read = (id: string) => runAsTenant(owner, () => store.get(owner, id));

await runAsTenant(owner, () =>
  database.insert(users).values({ id: owner, email: `${owner}@openbot.test` }),
);

afterAll(async () => {
  await runAsTenant("platform", async () => {
    if (approvalIds.length) {
      await database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, "approval.resume"),
            inArray(workItems.key, approvalIds),
          ),
        );
      await database
        .delete(approvalRequests)
        .where(inArray(approvalRequests.id, approvalIds));
    }
    await database.delete(users).where(eq(users.id, owner));
  });
  await database.$client.close();
  await admin.close();
});

describe("决定记下来源", () => {
  test("网页上批：记 web，一条、收件箱的读接口都带出 decidedVia", async () => {
    const request = await pending("web");
    const before = (await (await call(`/${request.id}`)).json()) as {
      decidedVia?: unknown;
    };
    expect(before.decidedVia ?? null).toBeNull();
    const decided = await call(`/${request.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow_once" }),
    });
    expect(decided.status).toBe(200);
    expect((await read(request.id)).decidedVia).toBe("web");
    const one = (await (await call(`/${request.id}`)).json()) as {
      decidedVia?: unknown;
      status: string;
    };
    expect(one).toMatchObject({ status: "approved", decidedVia: "web" });
    const inbox = (await (await call("/")).json()) as {
      requests: { id: string; decidedVia?: unknown }[];
    };
    expect(
      inbox.requests.find((entry) => entry.id === request.id)?.decidedVia,
    ).toBe("web");
  });

  test("网页上拒绝：同样记 web", async () => {
    const request = await pending("web-deny");
    const decided = await call(`/${request.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    });
    expect(decided.status).toBe(200);
    expect(await read(request.id)).toMatchObject({
      status: "denied",
      decidedVia: "web",
    });
  });

  test("审批服务按调用方说的渠道记：微信、Slack、Teams", async () => {
    for (const via of ["wechat", "slack", "teams"] as const) {
      const request = await pending(via);
      const decided = await runAsTenant(owner, () =>
        service.decide(owner, request.id, "allow_once", via),
      );
      expect(decided.decidedVia).toBe(via);
      expect((await read(request.id)).decidedVia).toBe(via);
    }
  });

  test("没被决定过的、被拒绝重复决定的，来源不变", async () => {
    const request = await pending("twice");
    expect((await read(request.id)).decidedVia ?? null).toBeNull();
    await runAsTenant(owner, () =>
      service.decide(owner, request.id, "deny", "wechat"),
    );
    await expect(
      runAsTenant(owner, () =>
        service.decide(owner, request.id, "allow_once", "slack"),
      ),
    ).rejects.toThrow(/already decided/);
    expect((await read(request.id)).decidedVia).toBe("wechat");
  });

  test("库里只收已知的渠道", async () => {
    const request = await pending("bad");
    const failure = await runAsTenant(owner, async () => {
      await database.execute(
        sql`update ${approvalRequests} set "decided_via" = 'fax' where ${approvalRequests.id} = ${request.id}`,
      );
    }).then(
      () => null,
      (error: unknown) => error,
    );
    // drizzle 把数据库的原话放在 `cause` 里：被拒是因为 0229 的取值约束，不是别的原因。
    expect(String((failure as { cause?: unknown } | null)?.cause)).toMatch(
      /approval_decided_via_check/,
    );
  });
});

/*
 * 迁移 0229 在已有数据上。`approval_requests` 是 FORCE ROW LEVEL SECURITY：测试库属主是超级用户、不受约束，
 * 所以照 0228 测试的写法，在最后回滚的事务里把库放回 0229 之前（去掉这一列和约束），写一条别的租户的、已决定的
 * 审批，把表交给一个普通的属主角色（受行级安全约束，像生产上的迁移角色），再以它逐句执行迁移文件。
 */
const MIGRATION = await Bun.file(
  new URL(
    "../recovery/recovery-20261018-v1/sql/0229_approval_decided_via.sql",
    import.meta.url,
  ),
).text();
const STATEMENTS = MIGRATION.split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

function ownerConnection(): SQL {
  const raw = process.env.TEST_DATABASE_ADMIN_URL?.trim();
  if (!raw)
    throw new Error(
      "TEST_DATABASE_ADMIN_URL must name the database owner: only the owner can put 0229's table back.",
    );
  const adminUrl = new URL(raw);
  const target = new URL(testDatabaseUrl());
  if (adminUrl.hostname !== target.hostname || adminUrl.port !== target.port)
    throw new Error(
      "TEST_DATABASE_ADMIN_URL must reach the same server as TEST_DATABASE_URL.",
    );
  return new SQL({
    adapter: "postgres",
    hostname: adminUrl.hostname,
    port: adminUrl.port ? Number(adminUrl.port) : 5432,
    username: decodeURIComponent(adminUrl.username),
    password: decodeURIComponent(adminUrl.password),
    database: decodeURIComponent(target.pathname.replace(/^\//, "")),
    max: 1,
  });
}
const admin = ownerConnection();
class Rollback extends Error {}

describe("迁移 0229 在已有审批行上", () => {
  test("以受行级安全约束的属主执行：旧行 decided_via 为 null，之后只收已知的渠道", async () => {
    const person = `mig229-${suite}`;
    const role = `mig229_${suite}`;
    const id = `mig229-${suite}-approval`;
    await expect(
      admin.begin(async (tx) => {
        await tx.unsafe(
          'ALTER TABLE "public"."approval_requests" DROP CONSTRAINT IF EXISTS "approval_decided_via_check"',
        );
        await tx.unsafe(
          'ALTER TABLE "public"."approval_requests" DROP COLUMN IF EXISTS "decided_via"',
        );
        await tx.unsafe(
          `INSERT INTO "public"."users" ("id", "email") VALUES ('${person}', '${person}@example.test')`,
        );
        await tx.unsafe(
          `INSERT INTO "public"."approval_requests"
             ("id", "tenant_id", "owner_user_id", "run_id", "tool_call_id", "action_digest", "action", "status", "decision", "decided_at")
           VALUES ('${id}', '${person}', '${person}', 'run', 'call', 'digest', '{}'::jsonb, 'approved', 'allow_once', now())`,
        );
        await tx.unsafe(`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS`);
        await tx.unsafe(`GRANT USAGE, CREATE ON SCHEMA "public" TO "${role}"`);
        await tx.unsafe(
          `ALTER TABLE "public"."approval_requests" OWNER TO "${role}"`,
        );
        await tx.unsafe(`SET LOCAL ROLE "${role}"`);
        // 没有租户帧：迁移里的语句不靠帧，看不到别人的行也照样能加列、加约束。
        await tx.unsafe("SELECT set_config('app.tenant_id', '', true)");
        for (const statement of STATEMENTS) await tx.unsafe(statement);
        await tx.unsafe("RESET ROLE");
        const [row] = (await tx.unsafe(
          `SELECT "decided_via", "status" FROM "public"."approval_requests" WHERE "id" = '${id}'`,
        )) as { decided_via: string | null; status: string }[];
        expect(row).toEqual({ decided_via: null, status: "approved" });
        await tx.unsafe(
          `UPDATE "public"."approval_requests" SET "decided_via" = 'wechat' WHERE "id" = '${id}'`,
        );
        await tx.unsafe("SAVEPOINT bad");
        await expect(
          tx.unsafe(
            `UPDATE "public"."approval_requests" SET "decided_via" = 'fax' WHERE "id" = '${id}'`,
          ),
        ).rejects.toThrow(/approval_decided_via_check/);
        await tx.unsafe("ROLLBACK TO SAVEPOINT bad");
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    // 回滚后共享测试库原样：列还在，表属主没变。
    const [column] = (await admin.unsafe(
      `SELECT "is_nullable" FROM "information_schema"."columns" WHERE "table_name" = 'approval_requests' AND "column_name" = 'decided_via'`,
    )) as { is_nullable: string }[];
    expect(column?.is_nullable).toBe("YES");
  });
});
