import type { TransactionSql } from "postgres";
import {
  CREDENTIAL_KID,
  type CredentialKind,
  LEGACY_CREDENTIAL_KID,
  openCredential,
  sealCredential,
} from "./credentials";

/**
 * Rekey every credential envelope sealed under kid `k1` to kid `k2` (v0.2.16).
 *
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
 *
 * WHAT. A v2 envelope's additional data starts with a label, and v0.2.16 changed the label. Each `k1`
 * row is opened under the old label and sealed again under the new one, bound to the same tenant, id
 * and kind. The plaintext does not change and neither does `updated_at`. v1 envelopes carry no label
 * and are not touched (`credentials-reseal.ts` is what moves those to v2); a v2 envelope under any other
 * kid is not one this server ever wrote and is left for `openCredential` to refuse, as before.
 *
 * WHERE IT RUNS. Inside the transaction that applies the business database's migrations
 * (`scripts/migrate.ts`), after them and before the commit. So it commits exactly when the migrations
 * that came with v0.2.16 commit and their rows enter the migration journal, which is what the delivery
 * container's rebrand-preflight.sh counts to say whether the business database changed. Any failure
 * throws, the whole transaction rolls back, and the database is as it was: rows rewritten before the
 * failing one included.
 *
 * EVERY ROW, WHOEVER RUNS IT. Row security on `credentials` is forced, so a migration owner that is
 * neither a superuser nor BYPASSRLS (a managed database's usual owner) would see only the rows its
 * frame admits and silently leave the rest under `k1`. Such an owner lifts the force for this
 * transaction only and puts it back before returning; a rollback puts it back too.
 *
 * IDEMPOTENT. Only `k1` rows are rewritten, so a second run finds none and writes nothing. It runs on
 * every migration, not only the one that brings v0.2.16, so a row a v0.2.15 replica writes while a
 * rolling upgrade is still under way is rekeyed by the next run.
 *
 * NEEDS THE KEY ONLY WHEN THERE IS WORK. With no `k1` row the key is never read; with one and no key,
 * it refuses and says what to set.
 *
 * NEVER PRINTS A SECRET. Errors name the row by id and tenant; never the key, a plaintext or an
 * envelope.
 */
export async function rekeyCredentials(
  tx: TransactionSql,
  encryptionKey: string | undefined,
): Promise<{ rekeyed: number }> {
  const [table] = await tx<
    { bypass: boolean; forced: boolean; owns: boolean }[]
  >`
    select (r.rolsuper or r.rolbypassrls) as bypass, c.relforcerowsecurity as forced,
           pg_has_role(current_user, c.relowner, 'USAGE') as owns
      from pg_roles r, pg_class c
     where r.rolname = current_user and c.oid = 'public.credentials'::regclass`;
  const lift = table !== undefined && !table.bypass && table.forced;
  if (lift) {
    if (!table.owns) {
      throw new Error(
        "凭据换密钥失败：迁移用的数据库角色不是超级用户、没有 BYPASSRLS，也不是 credentials 表的属主，读不全每个租户的凭据。整个迁移事务回滚，业务库没有任何改动。用建库时的 owner 连接串跑迁移。",
      );
    }
    await tx`alter table public.credentials no force row level security`;
  }

  // Every v2 envelope, locked until the commit; which kid it carries is read from the JSON below.
  const rows = await tx<
    { id: string; tenant_id: string; kind: string; encrypted_value: string }[]
  >`
    select id::text as id, tenant_id, kind::text as kind, encrypted_value
      from public.credentials
     where encrypted_value like ${'{"version":2,%'}
     order by id
       for update`;
  const legacy = rows.filter(
    (row) => kidOf(row.encrypted_value) === LEGACY_CREDENTIAL_KID,
  );

  if (legacy.length > 0) {
    const key = usableKey(encryptionKey, legacy.length);
    for (const row of legacy) {
      const binding = {
        tenantId: row.tenant_id,
        id: row.id,
        kind: row.kind as CredentialKind,
      };
      let plaintext: string;
      try {
        plaintext = await openCredential(key, {
          ...binding,
          encryptedValue: row.encrypted_value,
        });
      } catch {
        throw new Error(
          `凭据换密钥失败：凭据 ${row.id}（租户 ${row.tenant_id}，种类 ${row.kind}）用 KEY_ENCRYPTION_KEY 解不开：密钥与写入它时用的不同，或者密文已损坏。整个迁移事务回滚，业务库没有任何改动（已经重新加密的凭据也一并撤回）。先确认迁移进程的 KEY_ENCRYPTION_KEY 与 API 用的是同一个再重跑；确实是这一条坏了，把这段报错发给开发者，不要手工改 credentials 表。`,
        );
      }
      const sealed = await sealCredential(key, binding, plaintext);
      // The new envelope must open to the same secret before the old one is replaced.
      if (
        kidOf(sealed) !== CREDENTIAL_KID ||
        (await openCredential(key, { ...binding, encryptedValue: sealed })) !==
          plaintext
      ) {
        throw new Error(
          `凭据换密钥失败：凭据 ${row.id} 重新加密后打不开。整个迁移事务回滚，业务库没有任何改动。`,
        );
      }
      await tx`update public.credentials set encrypted_value = ${sealed} where id = ${row.id}::uuid`;
    }
  }

  if (lift) {
    await tx`alter table public.credentials force row level security`;
  }
  return { rekeyed: legacy.length };
}

/** The kid of a v2 envelope; nothing for anything else. */
function kidOf(value: string): unknown {
  try {
    const envelope = JSON.parse(value) as { version?: unknown; kid?: unknown };
    return envelope?.version === 2 ? envelope.kid : undefined;
  } catch {
    return undefined;
  }
}

/** The key, checked the way the server checks it, once there is something to open with it. */
function usableKey(encryptionKey: string | undefined, rows: number) {
  const key = encryptionKey?.trim();
  if (!key) {
    throw new Error(
      `凭据换密钥需要 KEY_ENCRYPTION_KEY：库里有 ${rows} 条 v0.2.16 之前格式（k1）的凭据要重新加密，迁移进程的环境里却没有这个变量。整个迁移事务回滚，业务库没有任何改动。把 API 用的同一个 KEY_ENCRYPTION_KEY 加进迁移的环境（外接库：写进 .env.migration）后重跑迁移。`,
    );
  }
  const decoded = Buffer.from(key, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== key) {
    throw new Error(
      "凭据换密钥失败：KEY_ENCRYPTION_KEY 不是 base64 编码的 32 字节密钥。整个迁移事务回滚，业务库没有任何改动。改成 API 用的那一个后重跑迁移。",
    );
  }
  return key;
}
