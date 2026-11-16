import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { testDatabaseUrl } from "./support/database";

/**
 * Migration 0129 on the duplicate rows written before it.
 *
 * 0129 removes every subscription row but one per tenant and then adds `subscriptions_tenant_unique`.
 * The row it keeps has to be the one the quota and model-pool readers were already answering with
 * (the most recent active row; for a tenant with none, the most recent canceled one), or the
 * migration would silently move somebody's plan. Nothing else in the suite runs its data statement
 * on old-shaped data, and every deployment runs it exactly once.
 *
 * Read from the file rather than restated here, so the test proves what the migration does (the
 * pattern of the 0128 test), and run inside a transaction that is rolled back. The shared test
 * database is already past 0129, so the transaction first puts the table back the way 0129 found it
 * (the constraint dropped, the plain index back), writes the duplicates, then runs every statement
 * of the file verbatim. That needs the table's owner (`TEST_DATABASE_ADMIN_URL`, pointed at the same
 * database), which is also who runs migrations; the owner is bound by FORCE ROW LEVEL SECURITY like
 * anybody else, which is the case the file's own `platform` frame is there for.
 */
const MIGRATION = await Bun.file(
  new URL(
    "../recovery/recovery-20261018-v1/sql/0129_subscriptions_tenant_unique.sql",
    import.meta.url,
  ),
).text();
const STATEMENTS = MIGRATION.split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

const url = testDatabaseUrl();

function ownerConnection(): SQL {
  const raw = process.env.TEST_DATABASE_ADMIN_URL?.trim();
  if (!raw) {
    throw new Error(
      "TEST_DATABASE_ADMIN_URL must name the database owner: only the owner can put 0129's table back.",
    );
  }
  const admin = new URL(raw);
  const target = new URL(url);
  if (admin.hostname !== target.hostname || admin.port !== target.port) {
    throw new Error(
      "TEST_DATABASE_ADMIN_URL must reach the same server as TEST_DATABASE_URL.",
    );
  }
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

/** Thrown to unwind the transaction, so the migration never touches the shared database's rows. */
class Rollback extends Error {}

const run = randomUUID().slice(0, 8);
const t = (name: string) => `mig129-${run}-${name}`;
const day = (d: number) => new Date(Date.UTC(2026, 0, d)).toISOString();

type Row = {
  id: string;
  tenant: string;
  plan: string;
  status: "active" | "canceled";
  created: string;
  updated: string;
};

const ROWS: Row[] = [
  // Two active rows: the newer one (by updated_at) is the one the readers answer with.
  {
    id: randomUUID(),
    tenant: t("two-active"),
    plan: "free",
    status: "active",
    created: day(1),
    updated: day(1),
  },
  {
    id: randomUUID(),
    tenant: t("two-active"),
    plan: "pro",
    status: "active",
    created: day(2),
    updated: day(2),
  },
  // An older active row beats a newer canceled one: readers only ever read active rows.
  {
    id: randomUUID(),
    tenant: t("active-wins"),
    plan: "pro",
    status: "active",
    created: day(1),
    updated: day(1),
  },
  {
    id: randomUUID(),
    tenant: t("active-wins"),
    plan: "free",
    status: "canceled",
    created: day(5),
    updated: day(5),
  },
  // Nothing active: the most recent canceled row stays (the readers answer Free either way).
  {
    id: randomUUID(),
    tenant: t("all-canceled"),
    plan: "pro",
    status: "canceled",
    created: day(1),
    updated: day(3),
  },
  {
    id: randomUUID(),
    tenant: t("all-canceled"),
    plan: "free",
    status: "canceled",
    created: day(2),
    updated: day(2),
  },
  // updated_at ties: created_at decides.
  {
    id: randomUUID(),
    tenant: t("updated-tie"),
    plan: "free",
    status: "active",
    created: day(1),
    updated: day(4),
  },
  {
    id: randomUUID(),
    tenant: t("updated-tie"),
    plan: "pro",
    status: "active",
    created: day(2),
    updated: day(4),
  },
  // A tenant with one row is not touched.
  {
    id: randomUUID(),
    tenant: t("single"),
    plan: "pro",
    status: "active",
    created: day(1),
    updated: day(1),
  },
];
// Both timestamps tie: the higher id decides, so the outcome never depends on the scan.
const tieIds = [randomUUID(), randomUUID()].sort();
ROWS.push(
  {
    id: tieIds[0] as string,
    tenant: t("full-tie"),
    plan: "pro",
    status: "active",
    created: day(1),
    updated: day(1),
  },
  {
    id: tieIds[1] as string,
    tenant: t("full-tie"),
    plan: "free",
    status: "active",
    created: day(1),
    updated: day(1),
  },
);

const KEPT: Record<string, { plan: string; status: string }> = {
  [t("two-active")]: { plan: "pro", status: "active" },
  [t("active-wins")]: { plan: "pro", status: "active" },
  [t("all-canceled")]: { plan: "pro", status: "canceled" },
  [t("updated-tie")]: { plan: "pro", status: "active" },
  [t("single")]: { plan: "pro", status: "active" },
  [t("full-tie")]: { plan: "free", status: "active" },
};

describe("migration 0129 on duplicate subscription rows", () => {
  test("its statements are the frame, the de-duplication, the constraint, the index and the reset", () => {
    expect(STATEMENTS).toHaveLength(5);
    expect(STATEMENTS[0]).toMatch(
      /set_config\('app\.tenant_id', 'platform', true\)/,
    );
    expect(STATEMENTS[1]).toMatch(/DELETE FROM public\.subscriptions\b/);
    expect(STATEMENTS[2]).toMatch(
      /ADD CONSTRAINT subscriptions_tenant_unique UNIQUE \(tenant_id\)/,
    );
    expect(STATEMENTS[3]).toMatch(
      /DROP INDEX IF EXISTS public\.subscriptions_tenant_idx/,
    );
    expect(STATEMENTS[4]).toMatch(/set_config\('app\.tenant_id', '', true\)/);
  });

  test("keeps the row every reader already answered with, one per tenant, and leaves other tenants alone", async () => {
    let seen:
      | {
          kept: Record<string, { plan: string; status: string }>;
          othersBefore: number;
          othersAfter: number;
          constraint: number;
          plainIndex: number;
          frame: string;
        }
      | undefined;
    try {
      await owner.begin(async (tx) => {
        // The table as 0129 found it.
        await tx.unsafe(
          "ALTER TABLE public.subscriptions DROP CONSTRAINT subscriptions_tenant_unique",
        );
        await tx.unsafe(
          'CREATE INDEX "subscriptions_tenant_idx" ON "subscriptions" USING btree ("tenant_id")',
        );
        await tx.unsafe("SELECT set_config('app.tenant_id', 'platform', true)");
        for (const row of ROWS) {
          await tx`
            insert into public.subscriptions (id, tenant_id, plan_id, status, created_at, updated_at)
            values (${row.id}, ${row.tenant}, ${row.plan}, ${row.status}, ${row.created}, ${row.updated})
          `;
        }
        const prefix = `mig129-${run}-%`;
        const [before] = await tx`
          select count(*)::int as n from public.subscriptions where tenant_id not like ${prefix}
        `;
        // The migrator starts with no frame; the file must set its own.
        await tx.unsafe("SELECT set_config('app.tenant_id', '', true)");

        for (const statement of STATEMENTS) await tx.unsafe(statement);

        const [frame] =
          await tx`select current_setting('app.tenant_id', true) as value`;
        await tx.unsafe("SELECT set_config('app.tenant_id', 'platform', true)");
        const rows = await tx`
          select tenant_id, plan_id, status from public.subscriptions
           where tenant_id like ${prefix} order by tenant_id
        `;
        const [after] = await tx`
          select count(*)::int as n from public.subscriptions where tenant_id not like ${prefix}
        `;
        const [constraint] = await tx`
          select count(*)::int as n from pg_constraint
           where conname = 'subscriptions_tenant_unique'
             and conrelid = 'public.subscriptions'::regclass and contype = 'u'
        `;
        const [plainIndex] = await tx`
          select count(*)::int as n from pg_indexes
           where schemaname = 'public' and indexname = 'subscriptions_tenant_idx'
        `;
        const kept: Record<string, { plan: string; status: string }> = {};
        for (const row of rows as {
          tenant_id: string;
          plan_id: string;
          status: string;
        }[]) {
          // A second row for a tenant would overwrite the first here; the count below catches it.
          expect(kept[row.tenant_id]).toBeUndefined();
          kept[row.tenant_id] = { plan: row.plan_id, status: row.status };
        }
        seen = {
          kept,
          othersBefore: before.n,
          othersAfter: after.n,
          constraint: constraint.n,
          plainIndex: plainIndex.n,
          frame: frame.value,
        };
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(seen?.kept).toEqual(KEPT);
    expect(seen?.othersAfter).toBe(seen?.othersBefore);
    expect(seen?.constraint).toBe(1);
    expect(seen?.plainIndex).toBe(0);
    // Reset, so a later migration in the same transaction does not inherit `platform`.
    expect(seen?.frame).toBe("");

    // Rolled back: the shared database still has its constraint and none of these rows.
    const [still] = await owner`
      select count(*)::int as n from pg_constraint where conname = 'subscriptions_tenant_unique'
    `;
    expect(still.n).toBe(1);
  });
});
