import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { staffingProposals } from "../src/db/schema/staffing";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 提议表按租户隔离：一个人的招人提议只有在他自己的帧里看得见、写得进；kind 与 status 只能取清单里的值，
 * 否则执行器会遇到它不认识的提议。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const TENANT_A = `sp-${suite}-a`;
const TENANT_B = `sp-${suite}-b`;

const draft = { name: "小客服" };
const proposal = (tenant: string, kind = "employee") => ({
  tenantId: tenant,
  ownerId: tenant,
  proposedByAgentId: `agent-${suite}`,
  kind,
  draft,
  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
});

async function clean() {
  await asPlatform(async () => {
    for (const tenant of [TENANT_A, TENANT_B])
      await database
        .delete(staffingProposals)
        .where(eq(staffingProposals.tenantId, tenant));
  });
}

beforeAll(clean);
afterAll(clean);

describe("staffing_proposals", () => {
  test("rows are visible only inside the owner's tenant frame", async () => {
    await runAsTenant(TENANT_A, async () => {
      await database.insert(staffingProposals).values(proposal(TENANT_A));
    });
    const fromB = await runAsTenant(TENANT_B, () =>
      database
        .select()
        .from(staffingProposals)
        .where(eq(staffingProposals.ownerId, TENANT_A)),
    );
    const fromA = await runAsTenant(TENANT_A, () =>
      database
        .select()
        .from(staffingProposals)
        .where(eq(staffingProposals.ownerId, TENANT_A)),
    );
    expect(fromB).toHaveLength(0);
    expect(fromA).toHaveLength(1);
    expect(fromA[0]?.status).toBe("pending");
    expect(fromA[0]?.threadId).toBeNull();
  });

  test("a row cannot be written into another tenant", async () => {
    await expect(
      runAsTenant(TENANT_B, async () => {
        await database.insert(staffingProposals).values(proposal(TENANT_A));
      }),
    ).rejects.toThrow();
  });

  test("kind and status outside the lists are refused", async () => {
    await expect(
      runAsTenant(TENANT_A, async () => {
        await database
          .insert(staffingProposals)
          .values(proposal(TENANT_A, "x"));
      }),
    ).rejects.toThrow();
    await expect(
      runAsTenant(TENANT_A, async () => {
        await database
          .insert(staffingProposals)
          .values({ ...proposal(TENANT_A), status: "done" as "pending" });
      }),
    ).rejects.toThrow();
  });
});
