import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { mergedMigrationsFolder } from "../scripts/migrate";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { applyMigrations } from "../src/db/apply-migrations";
import { createDatabase } from "../src/db/client";
import { deploymentNameOf } from "../src/tenant-package";
import {
  startWorkOfferedListener,
  WORK_OFFERED_TOPIC,
} from "../src/work/queue";

/**
 * The v0.2.16 rename migration (0240), run the way a deployment runs it: a database is migrated by
 * the real migrator to the last v0.2.15 migration, rows carrying the old names are written into it,
 * and then the same migrator carries it forward. Everything below reads the database afterwards.
 *
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，this file spells the old names on purpose: they
 * are the data the migration exists to find. It goes when the migration goes (R4 baseline).
 *
 * Creating a database takes the owner (`TEST_DATABASE_ADMIN_URL`); without it this is skipped.
 */
const owner = process.env.TEST_DATABASE_ADMIN_URL?.trim();
const LAST_V0215_MIGRATION = "0239_aihub_provider_template";
const RENAME_MIGRATION = join(
  import.meta.dir,
  "..",
  "recovery",
  "recovery-20261018-v1",
  "sql",
  "0240_rebrand_names.sql",
);
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

/** A new database standing at v0.2.15's schema, migrated by the migrator every deployment runs. */
async function databaseAtV0215(label: string) {
  const name = `xiongbao_rebrand_${label}_${randomUUID().slice(0, 8)}`;
  await onAdmin((admin) => admin.unsafe(`CREATE DATABASE "${name}"`));
  created.push(name);
  const client = postgres(databaseUrl(name), { max: 1, onnotice: () => {} });
  const folder = await mergedMigrationsFolder({
    through: LAST_V0215_MIGRATION,
  });
  try {
    await applyMigrations(client, folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  return client;
}

/** Carry a database forward with the folder a v0.2.16 deployment ships. */
async function migrateToHead(client: postgres.Sql) {
  const folder = await mergedMigrationsFolder();
  try {
    await applyMigrations(client, folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** The rename migration's statements, as the migrator splits them. */
async function renameStatements() {
  return (await readFile(RENAME_MIGRATION, "utf8"))
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const userA = `rebrand-a-${randomUUID()}`;
const userB = `rebrand-b-${randomUUID()}`;
const botId = `rebrand-bot-${randomUUID()}`;
const threadId = `rebrand-thread-${randomUUID()}`;
const teamChannel = `rebrand-team-${randomUUID()}`;
const auditIds = [randomUUID(), randomUUID()];

/** Whatever 0240 could touch, as text: the catalogue it renames and the rows it rewrites. */
async function fingerprint(client: postgres.Sql) {
  const [row] = await client<{ text: string }[]>`
    select concat_ws(E'\n',
      (select string_agg(p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)), E'\n' order by 1)
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'),
      (select string_agg(t.tgrelid::regclass::text || ' ' || t.tgname, E'\n' order by 1)
         from pg_trigger t where not t.tgisinternal),
      (select string_agg(c.conrelid::regclass::text || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid), E'\n' order by 1)
         from pg_constraint c where c.connamespace = 'public'::regnamespace),
      (select string_agg(c.oid::regclass::text || ' ' || coalesce(c.relacl::text, ''), E'\n' order by 1)
         from pg_class c where c.relnamespace = 'public'::regnamespace),
      (select string_agg(p.polrelid::regclass::text || ' ' || p.polname || ' ' || p.polroles::regrole[]::text, E'\n' order by 1)
         from pg_policy p),
      (select string_agg(coalesce(d.defaclacl::text, ''), E'\n' order by 1) from pg_default_acl d),
      (select string_agg(array_to_string(s.setconfig, ','), E'\n' order by 1) from pg_db_role_setting s),
      (select string_agg(md5(g::text), E'\n' order by 1) from plugin_grants g),
      (select string_agg(md5(e::text), E'\n' order by 1) from enterprise_settings e),
      (select string_agg(md5(u::text), E'\n' order by 1) from users u),
      (select string_agg(md5(p::text), E'\n' order by 1) from platform_model_pool p),
      (select string_agg(md5(r::text), E'\n' order by 1) from thread_run_events r),
      (select string_agg(md5(d::text), E'\n' order by 1) from deployment_packages d),
      (select string_agg(md5(a::text), E'\n' order by 1) from audit_events a)
    ) as text`;
  return row?.text ?? "";
}

async function auditRows(client: postgres.Sql) {
  return client<{ row: string }[]>`
    select row_to_json(a)::text as row from audit_events a where id = any(${auditIds}::uuid[]) order by id`;
}

afterAll(async () => {
  if (!owner) return;
  await onAdmin(async (admin) => {
    for (const name of created)
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    /*
     * A database migrated on a cluster whose roles another database had already renamed recreates
     * the old roles (0054, 0109). Nothing references them once these databases are gone; drop them
     * so a known-password login does not outlive the suite. Ones another database still uses stay.
     */
    for (const role of ["openbot_app", "openbot_role_writer"]) {
      const [held] = await admin<{ refs: number }[]>`
        select count(*)::int as refs from pg_shdepend d join pg_roles r on r.oid = d.refobjid
         where r.rolname = ${role}`;
      const [exists] = await admin<{ n: number }[]>`
        select count(*)::int as n from pg_roles where rolname = ${role}`;
      if (exists?.n && held?.refs === 0)
        await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
  });
}, 120_000);

describe.skipIf(!owner)("the v0.2.16 rename migration", () => {
  let client: postgres.Sql;
  let auditBefore: { row: string }[] = [];
  /** What a v0.2.15 deployment called itself with no DEPLOYMENT_ID: its package id, `openbot`. */
  const v0215Prefix = createThreadIdentity("openbot").mint().slice(0, 14);

  beforeAll(async () => {
    client = await databaseAtV0215("main");
    await client.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', 'platform', true)`;
      await tx`insert into users (id, email, preferences) values
        (${userA}, ${`${userA}@example.test`}, '{"skin":"openbot","proactive":"on"}'),
        (${userB}, ${`${userB}@example.test`}, '{"skin":"classic"}')`;
      await tx`insert into agents (id, name, type, configuration, tenant_id)
        values (${botId}, 'Rebrand Bot', 'built_in', '{}', 'system')`;
      await tx`insert into plugin_grants (kind, ref, agent_id, granted_by, tenant_id) values
        ('skill', 'personal-default-skill', ${botId}, 'openbot:personal-defaults', 'system'),
        ('mcp', 'staffing-app', ${botId}, 'openbot:staffing-default', 'system'),
        ('mcp', 'always-on-app', ${botId}, 'openbot:always-on', 'system'),
        ('skill', 'person-picked-skill', ${botId}, ${userA}, 'system')`;
      await tx`insert into enterprise_settings (key, value, updated_by)
        values ('rebrand.test', '{"value":[]}', 'openbot:personal-defaults')`;
      await tx`insert into platform_model_pool (provider, model_name, label, api_key_env)
        values ('deepseek', 'rebrand-model', 'Rebrand', 'OPENBOT_POOL_DEEPSEEK')`;
      await tx`insert into threads (id, tenant_id, agent_id) values (${threadId}, ${userA}, ${botId})`;
      await tx`insert into thread_run_events (thread_id, run_id, seq, event, tenant_id) values
        (${threadId}, 'run-1', 1, ${JSON.stringify({ type: "RUN_ERROR", message: "refused", code: "OPENBOT_MODEL_REFUSED" })}::jsonb, ${userA}),
        (${threadId}, 'run-1', 2, ${JSON.stringify({ type: "RUN_ERROR", message: "quota", code: "quota_exceeded" })}::jsonb, ${userA}),
        (${threadId}, 'run-1', 3, ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: "OPENBOT_MODEL_REFUSED openbot:always-on", code: "OPENBOT_MODEL_REFUSED" })}::jsonb, ${userA}),
        (${threadId}, 'run-1', 4, ${JSON.stringify({ type: "RUN_ERROR", message: "tools", code: "OPENBOT_TOOL_LIMIT_EXCEEDED" })}::jsonb, ${userA})`;
      await tx`insert into audit_events (id, actor_user_id, event_type, target_type, payload, tenant_id) values
        (${auditIds[0]}::uuid, 'openbot:personal-defaults', 'configuration.changed', 'skill', '{"actor":"openbot:personal-defaults","provider":"OpenBot"}', 'system'),
        (${auditIds[1]}::uuid, ${userA}, 'agent.tool_limit_refused', 'agent', '{"code":"OPENBOT_MODEL_REFUSED","skin":"openbot"}', ${userA})`;
      await tx`insert into deployment_packages (tenant_id, source_path, checksum)
        values ('openbot', '/app/examples/xiongbao', 'checksum')`;
      await tx`insert into channels (id, name, description, tenant_id, created_by)
        values (${teamChannel}, 'Team room', '', 'team', ${userA})`;
      await tx`insert into channel_memberships (channel_id, user_id, tenant_id)
        values (${teamChannel}, ${userA}, 'team')`;
    });
    const [{ name }] = await client<
      { name: string }[]
    >`select current_database() as name`;
    await client.unsafe(
      `ALTER DATABASE "${name}" SET openbot.audit_retention_days = '30'`,
    );
    auditBefore = await auditRows(client);
    await migrateToHead(client);
  }, 300_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  test("roles, functions and triggers carry the new names", async () => {
    const roles = await client<{ rolname: string }[]>`
      select rolname from pg_roles where rolname in ('xiongbao_app', 'xiongbao_role_writer') order by 1`;
    expect(roles.map((row) => row.rolname)).toEqual([
      "xiongbao_app",
      "xiongbao_role_writer",
    ]);
    const oldFunctions = await client`
      select proname from pg_proc
       where pronamespace = 'public'::regnamespace
         and (proname like 'openbot%' or prosrc like '%openbot%')`;
    expect([...oldFunctions]).toEqual([]);
    const oldTriggers = await client`
      select tgname from pg_trigger where not tgisinternal and tgname like 'openbot%'`;
    expect([...oldTriggers]).toEqual([]);
    const renamed = await client<{ proname: string }[]>`
      select proname from pg_proc
       where pronamespace = 'public'::regnamespace and proname like 'xiongbao\\_%' order by 1`;
    expect(renamed.map((row) => row.proname)).toEqual(
      expect.arrayContaining([
        "xiongbao_team_row_guard",
        "xiongbao_team_channel_member",
        "xiongbao_team_channel_creator",
        "xiongbao_team_bot_visible",
        "xiongbao_team_server_secret",
        "xiongbao_grant_stamp_guard",
        "xiongbao_team_channel_hand_over_core",
        "xiongbao_team_channel_hand_over_write",
      ]),
    );
    const [{ guards }] = await client<{ guards: number }[]>`
      select count(*)::int as guards from pg_trigger
       where not tgisinternal and tgname = 'xiongbao_team_row_guard'`;
    expect(guards).toBeGreaterThan(10);
    // Nothing in this database still refers to a role under the old name.
    const [{ refs }] = await client<{ refs: number }[]>`
      select count(*)::int as refs from pg_shdepend d join pg_roles r on r.oid = d.refobjid
       where r.rolname in ('openbot_app', 'openbot_role_writer')
         and d.dbid = (select oid from pg_database where datname = current_database())`;
    expect(refs).toBe(0);
    const grants = await client<{ grantee: string; privilege_type: string }[]>`
      select grantee, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'user_roles'
         and grantee in ('xiongbao_app', 'xiongbao_role_writer')
       order by 1, 2`;
    expect([...grants]).toEqual([
      { grantee: "xiongbao_app", privilege_type: "SELECT" },
      { grantee: "xiongbao_role_writer", privilege_type: "DELETE" },
      { grantee: "xiongbao_role_writer", privilege_type: "INSERT" },
      { grantee: "xiongbao_role_writer", privilege_type: "SELECT" },
    ]);
    const [defaults] = await client<{ acl: string }[]>`
      select defaclacl::text as acl from pg_default_acl where defaclobjtype = 'r'`;
    expect(defaults?.acl).toContain("xiongbao_app=arwd/");
    expect(defaults?.acl).not.toContain("openbot_app");
  });

  test("RLS policies still evaluate after the function rename", async () => {
    const own = `rebrand-own-${randomUUID()}`;
    const outcome = await client.begin(async (tx) => {
      await tx`set local role xiongbao_app`;
      await tx`select set_config('app.tenant_id', ${userA}, true)`;
      await tx`insert into channels (id, name, description) values (${own}, 'Mine', '')`;
      const mine = await tx`select id from channels where id = ${own}`;
      const team = await tx`select id from channels where id = ${teamChannel}`;
      const [creator] = await tx<{ creator: boolean }[]>`
        select public.xiongbao_team_channel_creator(${teamChannel}) as creator`;
      await tx`update channels set title = 'Renamed' where id = ${own}`;
      const moved = await tx
        .savepoint(
          (sp) =>
            sp`update channels set tenant_id = ${userB} where id = ${own}`,
        )
        .then(
          () => "moved",
          (error: Error) => error.message,
        );
      await tx`select set_config('app.tenant_id', ${userB}, true)`;
      const strangerMine = await tx`select id from channels where id = ${own}`;
      const strangerTeam =
        await tx`select id from channels where id = ${teamChannel}`;
      return {
        mine: mine.length,
        team: team.length,
        creator: creator?.creator,
        moved,
        strangerMine: strangerMine.length,
        strangerTeam: strangerTeam.length,
      };
    });
    expect(outcome).toEqual({
      mine: 1,
      team: 1,
      creator: true,
      moved: "tenant_id of channels is fixed",
      strangerMine: 0,
      strangerTeam: 0,
    });
  });

  test("markers and preferences are rewritten", async () => {
    const grants = await client<{ ref: string; granted_by: string }[]>`
      select ref, granted_by from plugin_grants where agent_id = ${botId} order by ref`;
    expect([...grants]).toEqual([
      { ref: "always-on-app", granted_by: "xiongbao:always-on" },
      { ref: "person-picked-skill", granted_by: userA },
      {
        ref: "personal-default-skill",
        granted_by: "xiongbao:personal-defaults",
      },
      { ref: "staffing-app", granted_by: "xiongbao:staffing-default" },
    ]);
    const [setting] = await client<{ updated_by: string }[]>`
      select updated_by from enterprise_settings where key = 'rebrand.test'`;
    expect(setting?.updated_by).toBe("xiongbao:personal-defaults");

    const skins = await client<
      { id: string; preferences: Record<string, string> }[]
    >`
      select id, preferences from users where id in (${userA}, ${userB}) order by id`;
    expect([...skins]).toEqual([
      { id: userA, preferences: { skin: "xiongbao", proactive: "on" } },
      { id: userB, preferences: { skin: "classic" } },
    ]);

    const [pool] = await client<{ api_key_env: string }[]>`
      select api_key_env from platform_model_pool where model_name = 'rebrand-model'`;
    expect(pool?.api_key_env).toBe("XIONGBAO_POOL_DEEPSEEK");

    const events = await client<
      { seq: number; event: Record<string, string> }[]
    >`
      select seq, event from thread_run_events where thread_id = ${threadId} order by seq`;
    expect(events.map((row) => row.event)).toEqual([
      { type: "RUN_ERROR", message: "refused", code: "XIONGBAO_MODEL_REFUSED" },
      { type: "RUN_ERROR", message: "quota", code: "quota_exceeded" },
      {
        type: "TEXT_MESSAGE_CONTENT",
        delta: "OPENBOT_MODEL_REFUSED openbot:always-on",
        code: "OPENBOT_MODEL_REFUSED",
      },
      {
        type: "RUN_ERROR",
        message: "tools",
        code: "XIONGBAO_TOOL_LIMIT_EXCEEDED",
      },
    ]);

    const [retention] = await client<{ config: string[] }[]>`
      select setconfig as config from pg_db_role_setting
       where setdatabase = (select oid from pg_database where datname = current_database()) and setrole = 0`;
    expect(retention?.config).toContain("xiongbao.audit_retention_days=30");

    const packages = await client<
      { tenant_id: string; digest: string | null }[]
    >`
      select tenant_id, former_name_digest as digest from deployment_packages`;
    expect([...packages]).toEqual([
      {
        tenant_id: "xiongbao",
        digest: createHash("sha256").update("openbot").digest("hex"),
      },
    ]);

    const checks = await client<{ name: string; definition: string }[]>`
      select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
       where conname in ('apx_capture_codec_ck', 'apx_prepared_wire_version_ck', 'apx_capture_wire_size_ck',
                         'platform_model_pool_api_key_env')
       order by 1`;
    expect(checks.map((row) => row.definition)).toEqual([
      "CHECK ((codec_version = 'XIONGBAO_EXACT_INPUT_JSON_V1'::text))",
      "CHECK (((octet_length(envelope_bytes) >= 65) AND (octet_length(envelope_bytes) <= 1048640)))",
      "CHECK ((envelope_wire_version = 'XIONGBAO_APPROVAL_EXACT_WIRE_V1'::text))",
      "CHECK ((api_key_env ~ '^XIONGBAO_POOL_[A-Z0-9_]{1,64}$'::text))",
    ]);
  });

  test("thread id prefix is unchanged after the tenant rename", async () => {
    const [{ name }] = await client<
      { name: string }[]
    >`select current_database() as name`;
    const database = createDatabase(databaseUrl(name), { max: 1 });
    try {
      const deployment = await deploymentNameOf(database, {
        tenantId: "xiongbao",
        formerTenantIds: [],
      });
      expect(deployment.name).toBe("xiongbao");
      expect(createThreadIdentity(deployment).mint().slice(0, 14)).toBe(
        v0215Prefix,
      );
    } finally {
      await database.$client.end({ timeout: 5 });
    }
  });

  test("migration applied twice changes nothing", async () => {
    const before = await fingerprint(client);
    const statements = await renameStatements();
    await client.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
    });
    expect(await fingerprint(client)).toBe(before);
  });

  test("work offered on either channel name wakes a v0.2.16 listener, which announces on the new one", async () => {
    const [{ name }] = await client<
      { name: string }[]
    >`select current_database() as name`;
    const heard: string[] = [];
    const listener = await startWorkOfferedListener(
      databaseUrl(name),
      (kind) => {
        heard.push(kind);
      },
    );
    try {
      await client`select pg_notify(${WORK_OFFERED_TOPIC}, 'from-v0216')`;
      await client`select pg_notify('openbot_work_offered', 'from-v0215')`;
      const deadline = Date.now() + 5_000;
      while (heard.length < 2 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(heard.sort()).toEqual(["from-v0215", "from-v0216"]);
      expect(WORK_OFFERED_TOPIC).toBe("xiongbao_work_offered");
    } finally {
      await listener.stop();
    }
  });

  test("audit_events rows are untouched", async () => {
    expect(auditBefore).toHaveLength(2);
    expect([...(await auditRows(client))]).toEqual([...auditBefore]);
  });
});

describe.skipIf(!owner)(
  "the v0.2.16 rename migration refuses stored approval exact inputs",
  () => {
    test("a stored exact-input row refuses the rename and rolls every migration back", async () => {
      const client = await databaseAtV0215("refuse");
      try {
        const [{ applied }] = await client<{ applied: number }[]>`
        select count(*)::int as applied from drizzle.__drizzle_migrations`;
        await client.begin(async (tx) => {
          // Only the row's own CHECKs matter here; the referenced approval and thread are not the point.
          await tx`set local session_replication_role = replica`;
          await tx`insert into approval_exact_input_captures (
            id, approval_id, tenant_id, owner_user_id, actor_user_id, domain_id, thread_id, agent_id,
            approval_run_id, source_actual_run_id, tool_call_id, action_digest, source_binding,
            source_binding_version, codec_version, stage, plaintext_sha256, envelope_bytes,
            envelope_wire_version, key_version)
          values (gen_random_uuid(), 'approval', 'tenant', 'owner', 'actor', gen_random_uuid(), 'thread',
            'agent', 'run', 'source-run', 'call', 'digest', '{}', 'OPENBOT_APPROVAL_EXACT_SOURCE_BINDING_V1',
            'OPENBOT_EXACT_INPUT_JSON_V1', 'capture', ${"a".repeat(64)}, ${Buffer.alloc(64)},
            'OPENBOT_APPROVAL_EXACT_WIRE_V1', 'key')`;
        });
        // The migrator wraps the database's error; the refusal is the database's own message.
        const refusal = await migrateToHead(client).then(
          () => "migrated",
          (error: Error) =>
            error.cause instanceof Error ? error.cause.message : error.message,
        );
        expect(refusal).toContain("approval_exact_input_captures 1 行");
        expect(refusal).toContain("业务库没有任何改动");
        const [{ after }] = await client<{ after: number }[]>`
        select count(*)::int as after from drizzle.__drizzle_migrations`;
        expect(after).toBe(applied);
        const functions = await client`
        select proname from pg_proc where proname = 'openbot_team_row_guard'`;
        expect(functions).toHaveLength(1);
      } finally {
        await client.end({ timeout: 5 });
      }
    }, 300_000);
  },
);
