import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { brokeredAccounts, mcpServers } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 迁移 0180 的约束（上游 `shared-brokered-schema.integration.test.ts`，按 fork 的表改写）。
 *
 * fork 把团队账号记在应用行上，所以上游「一个应用最多一个部署账号」「部署行不能点名某人」由
 * `mcp_servers` 的 CHECK 承担；一个人的多个账号在 `brokered_accounts`，每人每应用最多一个默认，且只有
 * 本人的帧看得到。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const app = `schema-${suite}`;
const servers: string[] = [];

/** 失败的写入点名的约束，从驱动的 cause 里读，而不是 drizzle 的包装。 */
const violation = (run: () => PromiseLike<unknown>) =>
  Promise.resolve()
    .then(run)
    .then(
      () => "inserted",
      (error: Error) =>
        String((error.cause as Error | undefined)?.message ?? error.message),
    );

const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

async function server(id: string, values: Record<string, unknown> = {}) {
  servers.push(id);
  await platform(() =>
    database.insert(mcpServers).values({
      id,
      title: "GitHub",
      vendor: "Composio",
      url: `composio://${id}`,
      provenance: "composio",
      authScheme: "OAUTH2",
      ...values,
    }),
  );
}

afterAll(async () => {
  await platform(async () => {
    await database
      .delete(brokeredAccounts)
      .where(eq(brokeredAccounts.app, app));
    if (servers.length)
      await database.delete(mcpServers).where(inArray(mcpServers.id, servers));
  });
  await database.$client.close();
});

describe("an app's account mode", () => {
  test("a row written without one is a Personal app, as every app was before", async () => {
    const id = `${app}-default`;
    await server(id);
    const [row] = await platform(() =>
      database
        .select({ mode: mcpServers.accountMode })
        .from(mcpServers)
        .where(eq(mcpServers.id, id)),
    );
    expect(row?.mode).toBe("personal");
  });

  test("a mode that is not one of the two is refused", async () => {
    expect(
      await violation(() => server(`${app}-team`, { accountMode: "team" })),
    ).toMatch(/mcp_servers_account_mode_check/);
  });

  test("a Shared app holds the identity its team account is filed under", async () => {
    expect(
      await violation(() => server(`${app}-bare`, { accountMode: "shared" })),
    ).toMatch(/mcp_servers_shared_account_check/);
    await server(`${app}-shared`, {
      accountMode: "shared",
      sharedVendorUserId: `openbot-deployment:x:${suite}`,
    });
  });

  test("an app always has a mode", async () => {
    expect(
      await violation(() => server(`${app}-null`, { accountMode: null })),
    ).toMatch(/account_mode|not-null|null value/);
  });

  test("a Shared app's connected team account names who connected it", async () => {
    expect(
      await violation(() =>
        server(`${app}-anonymous`, {
          accountMode: "shared",
          sharedVendorUserId: `openbot-deployment:z:${suite}`,
          sharedConnectedAt: new Date(),
        }),
      ),
    ).toMatch(/mcp_servers_shared_account_check/);
  });

  test("a Personal app holds no team account", async () => {
    expect(
      await violation(() =>
        server(`${app}-leftover`, {
          accountMode: "personal",
          sharedVendorUserId: `openbot-deployment:y:${suite}`,
        }),
      ),
    ).toMatch(/mcp_servers_shared_account_check/);
    expect(
      await violation(() =>
        server(`${app}-connected`, {
          accountMode: "personal",
          sharedConnectedAt: new Date(),
        }),
      ),
    ).toMatch(/mcp_servers_shared_account_check/);
    expect(
      await violation(() =>
        server(`${app}-verified`, {
          accountMode: "personal",
          sharedVerified: true,
        }),
      ),
    ).toMatch(/mcp_servers_shared_account_check/);
  });
});

describe("brokered_accounts", () => {
  const person = `a-${suite}`;
  const other = `b-${suite}`;

  test("a person holds at most one default account per app, and two people may each hold one", async () => {
    await runAsTenant(person, () =>
      database.insert(brokeredAccounts).values({
        provider: "composio",
        app,
        userId: person,
        vendorUserId: person,
        accountId: "ca_1",
        identity: "dana@work.example",
        isDefault: true,
      }),
    );
    await runAsTenant(other, () =>
      database.insert(brokeredAccounts).values({
        provider: "composio",
        app,
        userId: other,
        vendorUserId: other,
        accountId: "ca_3",
        isDefault: true,
      }),
    );
    expect(
      await violation(() =>
        runAsTenant(person, () =>
          database.insert(brokeredAccounts).values({
            provider: "composio",
            app,
            userId: person,
            vendorUserId: person,
            accountId: "ca_2",
            isDefault: true,
          }),
        ),
      ),
    ).toMatch(/brokered_accounts_default_idx/);
  });

  test("one account is one row", async () => {
    expect(
      await violation(() =>
        runAsTenant(person, () =>
          database.insert(brokeredAccounts).values({
            provider: "composio",
            app,
            userId: person,
            vendorUserId: person,
            accountId: "ca_1",
          }),
        ),
      ),
    ).toMatch(/brokered_accounts_account_idx/);
  });

  test("a provider this deployment does not broker through is refused", async () => {
    expect(
      await violation(() =>
        runAsTenant(person, () =>
          database.insert(brokeredAccounts).values({
            provider: "arcade",
            app,
            userId: person,
            vendorUserId: person,
          }),
        ),
      ),
    ).toMatch(/brokered_accounts_provider_check/);
  });

  test("a row is only ever a person's, never the platform's or the team's", async () => {
    expect(
      await violation(() =>
        platform(() =>
          database.insert(brokeredAccounts).values({
            provider: "composio",
            app,
            userId: person,
            vendorUserId: person,
            accountId: "ca_platform",
          }),
        ),
      ),
    ).toMatch(/brokered_accounts_tenant_person/);
  });

  test("a person sees their own accounts and nobody else's", async () => {
    const seen = await runAsTenant(person, () =>
      database
        .select({ userId: brokeredAccounts.userId })
        .from(brokeredAccounts)
        .where(eq(brokeredAccounts.app, app)),
    );
    expect(seen).toEqual([{ userId: person }]);
    // 别人的帧既删不掉也改不了。
    await runAsTenant(other, async () => {
      await database
        .delete(brokeredAccounts)
        .where(eq(brokeredAccounts.userId, person));
      await database
        .update(brokeredAccounts)
        .set({ identity: "stolen" })
        .where(eq(brokeredAccounts.userId, person));
    });
    const after = await platform(() =>
      database
        .select({ identity: brokeredAccounts.identity })
        .from(brokeredAccounts)
        .where(eq(brokeredAccounts.userId, person)),
    );
    expect(after).toEqual([{ identity: "dana@work.example" }]);
  });

  test("row-level security is forced, so the table's owner is held to it too", async () => {
    const [row] = await runAsTenant("system", () =>
      database.execute<{ forced: boolean; enabled: boolean }>(
        sql`select relforcerowsecurity as forced, relrowsecurity as enabled from pg_class where relname = 'brokered_accounts'`,
      ),
    );
    expect(row).toEqual({ forced: true, enabled: true });
  });
});
