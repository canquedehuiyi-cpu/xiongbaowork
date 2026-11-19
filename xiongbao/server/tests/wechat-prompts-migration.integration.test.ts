import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { testDatabaseUrl } from "./support/database";

/**
 * 迁移 0228（计划 2026-11-16-im-channels-wechat Task 7 修复轮 2）在已有数据上：同一 (user, kind, ref) 开着两条
 * 提示时，先关掉多余的那条，再建部分唯一索引。
 *
 * `wechat_prompts` 是 FORCE ROW LEVEL SECURITY，表的属主也受约束：迁移不开 `platform` 帧时 UPDATE 一行都看不到，
 * 建索引就撞上重复数据。测试库的属主是超级用户、不受行级安全约束，所以这里在一个最后回滚的事务里，把表交给
 * 一个临时的、普通的属主角色（受行级安全约束，像生产上的迁移角色），先把库放回 0228 之前的样子（去掉索引、
 * 写两条重复的开着的提示），再以那个角色逐句执行迁移文件。照 0129 / 0131 测试的写法，读文件、不重抄。
 */
const MIGRATION = await Bun.file(
  new URL(
    "../recovery/recovery-20261018-v1/sql/0228_wechat_prompts_open_ref.sql",
    import.meta.url,
  ),
).text();
const STATEMENTS = MIGRATION.split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

const url = testDatabaseUrl();

function ownerConnection(): SQL {
  const raw = process.env.TEST_DATABASE_ADMIN_URL?.trim();
  if (!raw)
    throw new Error(
      "TEST_DATABASE_ADMIN_URL must name the database owner: only the owner can put 0228's table back.",
    );
  const admin = new URL(raw);
  const target = new URL(url);
  if (admin.hostname !== target.hostname || admin.port !== target.port)
    throw new Error(
      "TEST_DATABASE_ADMIN_URL must reach the same server as TEST_DATABASE_URL.",
    );
  return new SQL({
    adapter: "postgres",
    hostname: admin.hostname,
    port: admin.port ? Number(admin.port) : 5432,
    username: decodeURIComponent(admin.username),
    password: decodeURIComponent(admin.password),
    database: decodeURIComponent(target.pathname.replace(/^\//, "")),
    max: 1,
  });
}

const owner = ownerConnection();
afterAll(async () => {
  await owner.close();
});

/** 抛出来让事务回滚，迁移不碰共享测试库的数据。 */
class Rollback extends Error {}

const run = randomUUID().slice(0, 8);
const person = `mig228-${run}-person`;
const role = `mig228_${run}`;

/** 在回滚的事务里：放回 0228 之前、写两条重复的开着的提示，再以普通属主角色执行 `statements`。 */
async function before0228(
  statements: string[],
  check: (tx: SQL) => Promise<void>,
) {
  await expect(
    owner.begin(async (tx) => {
      await tx.unsafe(
        'DROP INDEX IF EXISTS "public"."wechat_prompts_open_ref_idx"',
      );
      await tx.unsafe(
        `INSERT INTO "public"."users" ("id", "email") VALUES ('${person}', '${person}@example.test')`,
      );
      for (const code of ["A1", "A2"])
        await tx.unsafe(
          `INSERT INTO "public"."wechat_prompts" ("id", "tenant_id", "user_id", "code", "kind", "ref_id")
           VALUES ('${randomUUID()}', '${person}', '${person}', '${code}', 'approval', 'same-approval')`,
        );
      await tx.unsafe(
        `INSERT INTO "public"."wechat_prompts" ("id", "tenant_id", "user_id", "code", "kind", "ref_id")
         VALUES ('${randomUUID()}', '${person}', '${person}', 'A3', 'approval', 'other-approval')`,
      );
      await tx.unsafe(`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS`);
      await tx.unsafe(`GRANT USAGE, CREATE ON SCHEMA "public" TO "${role}"`);
      await tx.unsafe(
        `ALTER TABLE "public"."wechat_prompts" OWNER TO "${role}"`,
      );
      await tx.unsafe(`SET LOCAL ROLE "${role}"`);
      for (const statement of statements) await tx.unsafe(statement);
      await tx.unsafe("RESET ROLE");
      await check(tx);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

describe("迁移 0228 在已有的重复提示上", () => {
  test("以受行级安全约束的属主执行：多余的那条关掉，只剩编号最小的开着，索引建好", async () => {
    await before0228(STATEMENTS, async (tx) => {
      const rows = (await tx.unsafe(
        `SELECT "code", "ref_id", "state" FROM "public"."wechat_prompts" WHERE "user_id" = '${person}' ORDER BY "code"`,
      )) as { code: string; ref_id: string; state: string }[];
      expect(rows).toEqual([
        { code: "A1", ref_id: "same-approval", state: "open" },
        { code: "A2", ref_id: "same-approval", state: "done" },
        { code: "A3", ref_id: "other-approval", state: "open" },
      ]);
      const indexes = (await tx.unsafe(
        `SELECT "indexname" FROM "pg_indexes" WHERE "indexname" = 'wechat_prompts_open_ref_idx'`,
      )) as { indexname: string }[];
      expect(indexes).toHaveLength(1);
      // 帧在迁移最后清掉了。
      const [setting] = (await tx.unsafe(
        `SELECT current_setting('app.tenant_id', true) AS "tenant"`,
      )) as { tenant: string | null }[];
      expect(setting?.tenant ?? "").toBe("");
    });
  });

  test("对照：不开 platform 帧时一行也关不掉，建索引撞上重复数据", async () => {
    const unframed = STATEMENTS.filter(
      (statement) => !statement.includes("set_config("),
    );
    expect(unframed.length).toBe(STATEMENTS.length - 2);
    await expect(
      owner.begin(async (tx) => {
        await tx.unsafe(
          'DROP INDEX IF EXISTS "public"."wechat_prompts_open_ref_idx"',
        );
        await tx.unsafe(
          `INSERT INTO "public"."users" ("id", "email") VALUES ('${person}-x', '${person}-x@example.test')`,
        );
        for (const code of ["A1", "A2"])
          await tx.unsafe(
            `INSERT INTO "public"."wechat_prompts" ("id", "tenant_id", "user_id", "code", "kind", "ref_id")
             VALUES ('${randomUUID()}', '${person}-x', '${person}-x', '${code}', 'approval', 'same-approval')`,
          );
        await tx.unsafe(`CREATE ROLE "${role}_x" NOSUPERUSER NOBYPASSRLS`);
        await tx.unsafe(
          `GRANT USAGE, CREATE ON SCHEMA "public" TO "${role}_x"`,
        );
        await tx.unsafe(
          `ALTER TABLE "public"."wechat_prompts" OWNER TO "${role}_x"`,
        );
        await tx.unsafe(`SET LOCAL ROLE "${role}_x"`);
        await tx.unsafe("SELECT set_config('app.tenant_id', '', true)");
        for (const statement of unframed) await tx.unsafe(statement);
        throw new Rollback();
      }),
    ).rejects.toThrow(/wechat_prompts_open_ref_idx|duplicate|unique/i);
  });
});
