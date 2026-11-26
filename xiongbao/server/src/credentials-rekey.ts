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
 * WHEN IT RUNS AND WHEN IT COMMITS. On every run of `scripts/migrate.ts`, inside the transaction that
 * applies the business database's migrations, after them and before the commit; it commits with that
 * transaction or not at all. Any failure throws and the whole transaction rolls back, the rows rekeyed
 * before the failing one and the migrations' journal rows included.
 *
 * WHAT THAT MEANS FOR THE JOURNAL. The run that brings v0.2.16 applies 0240 and rekeys in one commit, so
 * there the rekey lands exactly when the migration journal grows. A later run with nothing to migrate
 * rekeys only `k1` rows written after that commit, which only a v0.2.15 process still running beside
 * v0.2.16 can write: a rolling upgrade of an external database. The delivery container cannot have one
 * (migrate.sh runs before any service starts), so there a rekey never commits without the journal
 * changing, and rebrand-preflight.sh's journal count tells truthfully whether the business database
 * changed. An external database does not go through rebrand-preflight.sh.
 *
 * EVERY ROW, WHOEVER RUNS IT. Row security on `credentials` is forced, so a migration owner that is
 * neither a superuser nor BYPASSRLS sees only the rows its frame admits. The work runs in the `platform`
 * frame, as migrations 0114, 0115, 0121 and 0240 do: the `tenant_isolation` policies admit any row to
 * it for SELECT and UPDATE, and the `team` frame refusals do not apply. The setting is
 * transaction-local and put back as it was before returning. Nothing about the table changes.
 *
 * IDEMPOTENT. Only `k1` rows are read for update and rewritten, so a run that finds none locks nothing
 * and writes nothing.
 *
 * NEEDS THE KEY ONLY WHEN THERE IS WORK. With no `k1` row the key is never read; with one and no key,
 * or a key that is not one, it refuses and says what to set.
 *
 * NEVER PRINTS A SECRET. Errors name the row by id, tenant and kind; never the key, a plaintext or an
 * envelope.
 */
export async function rekeyCredentials(
  tx: TransactionSql,
  encryptionKey: string | undefined,
): Promise<{ rekeyed: number }> {
  const [access] = await tx<{ allowed: boolean }[]>`
    select has_table_privilege('public.credentials', 'SELECT, UPDATE') as allowed`;
  if (!access?.allowed) {
    throw new Error(
      "凭据换密钥失败：迁移用的数据库角色没有读写 credentials 表的权限。整个迁移事务回滚，业务库没有任何改动。用建库时的 owner 连接串跑迁移。",
    );
  }

  const [previous] = await tx<{ frame: string | null }[]>`
    select current_setting('app.tenant_id', true) as frame`;
  const frame = previous?.frame ?? "";
  await tx`select set_config('app.tenant_id', 'platform', true)`;
  let failed = false;
  try {
    return await rekeyInPlatformFrame(tx, encryptionKey);
  } catch (failure) {
    failed = true;
    throw failure;
  } finally {
    // Put back even when this throws, for a caller that catches and carries on in the transaction. After
    // a failed statement the transaction cannot run this, and the rollback that follows resets it anyway.
    await tx`select set_config('app.tenant_id', ${frame}, true)`.catch(
      (restore: unknown) => {
        if (!failed) throw restore;
      },
    );
  }
}

async function rekeyInPlatformFrame(
  tx: TransactionSql,
  encryptionKey: string | undefined,
): Promise<{ rekeyed: number }> {
  // Only the k1 rows, locked until the commit. The LIKE narrows to them (`sealCredential` writes compact
  // JSON); the kid is then read from the JSON itself.
  const rows = await tx<
    { id: string; tenant_id: string; kind: string; encrypted_value: string }[]
  >`
    select id::text as id, tenant_id, kind::text as kind, encrypted_value
      from public.credentials
     where encrypted_value like ${'{"version":2,%'}
       and encrypted_value like ${`%"kid":"${LEGACY_CREDENTIAL_KID}"%`}
     order by id
       for update`;
  const legacy = rows.filter(
    (row) => kidOf(row.encrypted_value) === LEGACY_CREDENTIAL_KID,
  );
  if (legacy.length === 0) return { rekeyed: 0 };

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
