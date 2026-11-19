import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import postgres from "postgres";

/**
 * 0207's hand-over names the crew in SQL, and the image's embedded PostgreSQL is a SQL_ASCII cluster
 * (`docker/s6/scripts/postgres-init.sh` runs `initdb` with no locale or encoding, and the image sets
 * no `LANG`). There `left()`, `length()` and `btrim()` count bytes, and a Unicode escape in a literal
 * cannot be converted at all: the file used to fail outright, and cutting a long Chinese title at 80
 * would have split a character and stored bytes that are not UTF-8.
 *
 * So the real migrations are run into a fresh database of each encoding, and the same hand-over is
 * made in both: a long Chinese title with ideographic spaces round it, whose name and whose
 * 「（2）」 the heir already has. The name stored must be valid UTF-8, at most 80 characters, cut
 * the way the app's `pickGroupName` cuts, and the same in both.
 *
 * Creating a database takes the owner (`TEST_DATABASE_ADMIN_URL`); without it this is skipped. The
 * databases are dropped afterwards.
 */
const owner = process.env.TEST_DATABASE_ADMIN_URL?.trim();
const serverRoot = join(import.meta.dir, "..");
const created: string[] = [];

function databaseUrl(name: string) {
  const url = new URL(owner as string);
  url.pathname = `/${name}`;
  return url.href;
}

async function onAdmin<T>(work: (admin: postgres.Sql) => Promise<T>) {
  const admin = postgres(databaseUrl("postgres"), {
    max: 1,
    onnotice: () => {},
  });
  try {
    return await work(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** A new database of `encoding`, migrated the way every deployment migrates (`scripts/migrate.ts`). */
async function migratedDatabase(encoding: "UTF8" | "SQL_ASCII") {
  const name = `openbot_encoding_${encoding.toLowerCase()}_${randomUUID().slice(0, 8)}`;
  await onAdmin((admin) =>
    admin.unsafe(
      `CREATE DATABASE "${name}" ENCODING '${encoding}' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
    ),
  );
  created.push(name);
  const run = Bun.spawn(
    [process.execPath, "run", join("scripts", "migrate.ts")],
    {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl(name) },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, out, err] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  if (code !== 0) {
    const said = `${out}\n${err}`;
    const reason = said.match(/PostgresError: .*/)?.[0] ?? said.slice(-2000);
    throw new Error(`migrating a ${encoding} database failed: ${reason}`);
  }
  return databaseUrl(name);
}

afterAll(async () => {
  if (!owner) return;
  await onAdmin(async (admin) => {
    for (const name of created) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  });
}, 60_000);

/** What the app's `pickGroupName` keeps: the first `limit` code points. */
const clip = (text: string, limit: number) =>
  Array.from(text).slice(0, limit).join("");

/** 102 characters, all but two of them three bytes in UTF-8: a cut by bytes lands mid-character. */
const body = `ab${"季度复盘与下一步计划".repeat(10)}`;
const title = `　 ${body} 　`;

describe.skipIf(!owner)(
  "a hand-over names the crew the same in a SQL_ASCII database",
  () => {
    for (const encoding of ["SQL_ASCII", "UTF8"] as const) {
      test(`${encoding}: a long Chinese title that clashes twice`, async () => {
        const url = await migratedDatabase(encoding);
        const client = postgres(url, { max: 1, onnotice: () => {} });
        try {
          const [{ server_encoding }] = await client<
            { server_encoding: string }[]
          >`show server_encoding`;
          expect(server_encoding).toBe(encoding);

          const from = `enc-from-${randomUUID()}`;
          const heir = `enc-heir-${randomUUID()}`;
          const channel = `channel_${randomUUID()}`;
          const crew = randomUUID();
          // The heir already has the plain name and its 「（2）」.
          const taken = [clip(body, 80), `${clip(body, 77)}（2）`];

          const [name] = await client.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', 'platform', true)`;
            await tx`insert into users (id, email) values (${from}, ${`${from}@example.test`}), (${heir}, ${`${heir}@example.test`})`;
            await tx`insert into waker_groups (id, tenant_id, name) values (${crew}::uuid, ${from}, '旧名字')`;
            for (const clash of taken) {
              await tx`insert into waker_groups (tenant_id, name) values (${heir}, ${clash})`;
            }
            await tx`insert into channels (id, name, description, tenant_id, created_by, title, waker_group_id)
                   values (${channel}, '员工甲、员工乙', '', 'team', ${from}, ${title}, ${crew}::uuid)`;
            await tx`select public.openbot_team_channel_hand_over_write(${channel}, ${from}, ${heir}, ${crew}::uuid)`;
            return tx<{ tenant: string; bytes: Buffer }[]>`
            select tenant_id as tenant, textsend(name) as bytes from waker_groups where id = ${crew}::uuid`;
          });

          expect(name?.tenant).toBe(heir);
          // Throws on any byte sequence that is not UTF-8: a character cut in half.
          const stored = new TextDecoder("utf-8", { fatal: true }).decode(
            name?.bytes,
          );
          expect(Array.from(stored).length).toBeLessThanOrEqual(80);
          expect(stored).toBe(`${clip(body, 77)}（3）`);
        } finally {
          await client.end({ timeout: 5 });
        }
      }, 120_000);
    }
  },
);
