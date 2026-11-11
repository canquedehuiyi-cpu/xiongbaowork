// 上游 server/tests/arcade-provider-check.test.ts 按 fork 的表改写（X5，迁移 0192）：上游的
// `brokered_connections.provider` 在 fork 是 `composio_connections.provider` 与 `brokered_accounts.provider`。
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { brokeredAccounts, composioConnections } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { checkRoster } from "./support/constraints";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const app = `arcade-check-${randomUUID().slice(0, 8)}`;
const person = `person-${app}`;
const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

/** 失败的写入点名的约束，从驱动的 cause 里读，而不是 drizzle 的包装。 */
const outcome = (run: () => PromiseLike<unknown>) =>
  Promise.resolve()
    .then(run)
    .then(
      () => "inserted",
      (error: Error) =>
        String((error.cause as Error | undefined)?.message ?? error.message),
    );

afterAll(async () => {
  await platform(async () => {
    await database
      .delete(composioConnections)
      .where(eq(composioConnections.toolkit, app));
    await database
      .delete(brokeredAccounts)
      .where(eq(brokeredAccounts.app, app));
  });
  await database.$client.close();
});

describe("composio_connections.provider", () => {
  test("a row written without a provider is Composio's, as every row before 0192 is", async () => {
    await runAsTenant(person, () =>
      database
        .insert(composioConnections)
        .values({ toolkit: app, userId: person }),
    );
    const [row] = await runAsTenant(person, () =>
      database
        .select({ provider: composioConnections.provider })
        .from(composioConnections)
        .where(eq(composioConnections.toolkit, app)),
    );
    expect(row?.provider).toBe("composio");
  });

  test("an arcade row inserts", async () => {
    expect(
      await outcome(() =>
        runAsTenant(person, () =>
          database.insert(composioConnections).values({
            toolkit: `${app}-Gmail`,
            userId: person,
            provider: "arcade",
          }),
        ),
      ),
    ).toBe("inserted");
    await platform(() =>
      database
        .delete(composioConnections)
        .where(eq(composioConnections.toolkit, `${app}-Gmail`)),
    );
  });

  /**
   * 名单本身，而不是其中一个样本：多收一个提供商是一个没有 adapter 能服务、却会被
   * `assertActivatable` 数进去的行。名单从数据库读回，而不是从写它的迁移里读。
   */
  test("the CHECK admits exactly the two providers the broker implements", async () => {
    expect(
      await platform(() =>
        checkRoster(database, "composio_connections_provider_check"),
      ),
    ).toEqual(["arcade", "composio"]);
    expect(
      await platform(() =>
        checkRoster(database, "brokered_accounts_provider_check"),
      ),
    ).toEqual(["arcade", "composio"]);
  });

  test("an unknown provider is refused by the CHECK", async () => {
    expect(
      await outcome(() =>
        runAsTenant(person, () =>
          database.execute(
            sql`insert into composio_connections (toolkit, user_id, provider) values (${`${app}-x`}, ${person}, 'nope')`,
          ),
        ),
      ),
    ).toMatch(/composio_connections_provider_check/);
  });
});
