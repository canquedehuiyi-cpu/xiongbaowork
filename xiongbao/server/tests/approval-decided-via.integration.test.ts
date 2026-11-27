import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
    context.set("actor", { id, email: `${id}@xiongbao.test`, role: "user" });
    await next();
  };
const routes = createApprovalRoutes(service, actorFor(owner));
const call = (path: string, init?: RequestInit) =>
  runAsTenant(owner, () =>
    routes.request(new Request(`http://xiongbao.test${path}`, init)),
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
  database.insert(users).values({ id: owner, email: `${owner}@xiongbao.test` }),
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
