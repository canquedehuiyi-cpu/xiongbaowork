import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, notLike, sql } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "./audit";
import type { Database } from "./db/client";
import { reasonWithoutStatement } from "./db/query-failure";
import { type credentialKind, credentials } from "./db/schema";
import { TEAM_TENANT } from "./db/schema/tenant";
import { capabilityFor, currentTenant } from "./tenant/context";

type CredentialEnvelope = {
  version: 1;
  iv: string;
  ciphertext: string;
};

/**
 * A credential row's envelope, bound to the row it was written for (audit #9).
 *
 * v1 carries no additional data, so its ciphertext decrypts wherever it is pasted: into another
 * tenant's row, another kind, another id. v2 authenticates the row's own identity as AES-GCM
 * additional data. The binding is NEVER read from the envelope: `bind` only names which binding the
 * reader must rebuild, from the row's own columns, so a copied envelope meets a different tenant or
 * id and fails its tag. `kid` leaves room for a later key-encryption-key rotation.
 */
type CredentialEnvelopeV2 = {
  version: 2;
  alg: "A256GCM";
  bind: "credential";
  kid: string;
  iv: string;
  ciphertext: string;
};

/** What a v2 envelope is bound to: the row's tenant, its id, and the purpose its kind names. */
export type CredentialBinding = {
  tenantId: string;
  id: string;
  kind: CredentialKind;
};

/** Seals a plaintext for the row a store is about to write, once that row's identity is known. */
export type CredentialSeal = (binding: CredentialBinding) => Promise<string>;

const CREDENTIAL_AAD_LABEL = "openbot.vault.credential.v2";
const CREDENTIAL_KID = "k1";
/** Model-library keys are named after the library row, so the deployment lookup never meets one. */
export const MODEL_REGISTRY_KEY_PREFIX = "model_registry:";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Derived from the enum rather than written out again.
 *
 * These were two lists that had to agree, and nothing made them. A kind added to the schema and not
 * here fails at the point of use with a type error about an unrelated call site; a kind removed from
 * the schema and left here compiles and then violates a check constraint at runtime. One source now.
 */
export type CredentialKind = (typeof credentialKind.enumValues)[number];

export type CredentialStatus = {
  id: string;
  kind: CredentialKind;
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  revokedAt: Date | null;
};

type StoredCredential = {
  id: string;
  revokedAt: Date | null;
};

/**
 * A credential to write. Either an envelope already sealed (legacy v1, still accepted while the
 * remaining writers move over), or `seal`: the store picks the row's id and tenant first and asks
 * for a v2 envelope bound to exactly those, so the bound tenant is the column's and not a guess.
 */
export type CredentialStoreValue = {
  kind: CredentialKind;
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  /** Seal to the shared `team` tenant instead of the caller's own. See {@link credentialTenant}. */
  target?: CredentialTarget;
} & (
  | { encryptedValue: string; seal?: never }
  | { seal: CredentialSeal; encryptedValue?: never }
);

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Where a credential write runs.
 *
 * A caller already inside a transaction passes it here, so the write joins that
 * transaction rather than opening one of its own on a second pooled connection.
 * Two connections would mean the credential committing separately from the
 * change that asked for it, and, since the caller is usually holding row locks
 * by then, a pool with nothing spare to hand out deadlocks instead. See the
 * note on `max` in `db/client.ts`.
 */
export type CredentialExecutor =
  | Pick<Database, "select" | "insert" | "update">
  | Pick<Transaction, "select" | "insert" | "update">;

export type CredentialStore = {
  create: (
    value: CredentialStoreValue,
    executor?: CredentialExecutor,
  ) => Promise<StoredCredential>;
  /**
   * Re-encrypt a live row in place, keeping the id everything already points at.
   *
   * A vendor whose refresh token ROTATES is the one caller. It has already killed the old token at
   * its end by the time it answers, so there is no second grant left to withdraw and nothing to
   * learn from a new row — only a row per tool call, forever. A person RECONNECTING still goes
   * through `rotate`, because that is the act that leaves a live grant behind for us to withdraw at
   * our side too.
   *
   * A revoked or missing row is refused rather than written through: a grant somebody withdrew must
   * not come back to life by being handed a fresh secret.
   *
   * Without an executor this writes on its own connection. With one it joins the caller's
   * transaction, which is how the caller that has locked this row spends the token under that lock:
   * the write has to commit with the lock rather than beside it.
   */
  updateSecret: (
    id: string,
    secret: string | CredentialSeal,
    executor?: CredentialExecutor,
  ) => Promise<void>;
  /**
   * Replace one credential with another, atomically.
   *
   * Retiring the old secret and storing the new one are one decision, so they
   * are one write. Two separate calls cannot be made safe from the outside:
   * an `UPDATE` can commit and still throw on the way back, and no compensating
   * revoke survives the process being killed between them.
   *
   * Without an executor this opens its own transaction. With one it runs inside
   * the caller's, and is atomic with whatever else that transaction is doing.
   */
  rotate: (
    input: CredentialStoreValue & { previousCredentialId: string },
    executor?: CredentialExecutor,
  ) => Promise<StoredCredential>;
  /**
   * With `target`, only a live `team` server secret is revoked, under the same admin-capability
   * refusal as {@link credentialTenant}; without it, behaviour is unchanged.
   */
  revoke: (
    id: string,
    executor?: CredentialExecutor,
    target?: CredentialTarget,
  ) => Promise<Date>;
  /** Whether this credential exists and has not been revoked. */
  isLive: (id: string, executor?: CredentialExecutor) => Promise<boolean>;
  /**
   * The live credential for a key, if the CURRENT TENANT holds one.
   *
   * At most one can exist per tenant, which is what
   * `credentials_tenant_active_key_idx` enforces, so a caller about to store a
   * secret for a key can ask whether it is replacing something rather than
   * finding out from a failed insert. Filtered by tenant explicitly, because row
   * security also shows `system` rows, and another scope's row is never this
   * tenant's to replace.
   */
  findLiveByKey: (
    key: {
      kind: CredentialKind;
      provider: string;
      keyId: string;
      /** Look in the shared `team` tenant instead of the caller's own. */
      target?: CredentialTarget;
    },
    executor?: CredentialExecutor,
  ) => Promise<{ id: string } | null>;
};

export type CredentialSecretReader = {
  readSecret: (id: string) => Promise<{
    encryptedValue: string;
    revokedAt: Date | null;
    /** The row's identity, which a v2 envelope is bound to. A v1 envelope opens without it. */
    id?: string;
    tenantId?: string;
    kind?: CredentialKind;
  } | null>;
};

export type CredentialStatusReader = {
  list: () => Promise<CredentialStatus[]>;
};

export type ModelCredentialSecretReader = {
  readModelSecret: (input: {
    provider: "openai" | "anthropic";
    keyId: string;
  }) => Promise<{
    encryptedValue: string;
    id?: string;
    tenantId?: string;
    kind?: CredentialKind;
  } | null>;
};

type CredentialService = {
  encryptionKey: string;
  store: CredentialStore;
  auditStore: AuditStore;
};

async function aesKey(encodedKey: string) {
  return crypto.subtle.importKey(
    "raw",
    Buffer.from(encodedKey, "base64"),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function parseEnvelope(value: string): CredentialEnvelope {
  try {
    const envelope = JSON.parse(value) as CredentialEnvelope;
    if (
      envelope.version !== 1 ||
      typeof envelope.iv !== "string" ||
      typeof envelope.ciphertext !== "string"
    ) {
      throw new Error("invalid envelope");
    }
    return envelope;
  } catch {
    throw new Error("Credential envelope is invalid");
  }
}

export async function encryptSecret(encodedKey: string, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(encodedKey),
    encoder.encode(plaintext),
  );

  return JSON.stringify({
    version: 1,
    iv: Buffer.from(iv).toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
  } satisfies CredentialEnvelope);
}

/** Refuses a v2 envelope: one of those opens only through {@link openCredential}, with its row. */
export async function decryptSecret(encodedKey: string, value: string) {
  const envelope = parseEnvelope(value);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64") },
    await aesKey(encodedKey),
    Buffer.from(envelope.ciphertext, "base64"),
  );

  return decoder.decode(plaintext);
}

/** Length-prefixed UTF-8 frames, so no two different bindings can produce the same bytes. */
function credentialAad(binding: CredentialBinding) {
  const parts = [
    CREDENTIAL_AAD_LABEL,
    binding.tenantId,
    binding.id,
    binding.kind,
  ].map((part) => encoder.encode(part));
  const out = new Uint8Array(
    parts.reduce((total, part) => total + 4 + part.byteLength, 0),
  );
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.byteLength, false);
    out.set(part, offset + 4);
    offset += 4 + part.byteLength;
  }
  return out;
}

function requireBinding(
  binding: Partial<CredentialBinding>,
): CredentialBinding {
  const { tenantId, id, kind } = binding;
  if (!tenantId || !id || !kind) {
    throw new Error("Credential binding is incomplete");
  }
  return { tenantId, id, kind };
}

/** A v2 envelope for one credential row, authenticated against that row's tenant, id and kind. */
export async function sealCredential(
  encodedKey: string,
  binding: CredentialBinding,
  plaintext: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: credentialAad(requireBinding(binding)),
    },
    await aesKey(encodedKey),
    encoder.encode(plaintext),
  );

  return JSON.stringify({
    version: 2,
    alg: "A256GCM",
    bind: "credential",
    kid: CREDENTIAL_KID,
    iv: Buffer.from(iv).toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
  } satisfies CredentialEnvelopeV2);
}

/**
 * Whether this deployment refuses unbound (v1) credential envelopes: `VAULT_REQUIRE_AAD=1|true`.
 *
 * OFF BY DEFAULT, AND THAT IS THE OPEN HALF OF AUDIT #9. Every row written before the v2 envelope
 * is v1, so refusing v1 today would stop every existing credential. While it is off, a v1 envelope
 * copied into another row — another tenant's, or written over a v2 row (a downgrade) — still opens,
 * because v1 authenticates nothing about the row it sits in and nothing records that a row was v2.
 * The switch exists so the reseal plan has something to flip once every live row is v2.
 */
export function vaultRequiresAad(
  environment: Record<string, string | undefined> = process.env,
) {
  const value = environment.VAULT_REQUIRE_AAD?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Open a credential row's envelope.
 *
 * v1 opens as before unless {@link vaultRequiresAad}: rows written before audit #9 have no binding
 * and must keep working until they are resealed. v2 opens only with the binding rebuilt from the
 * row the value was read from; a value copied to another tenant, id or kind fails GCM
 * authentication and throws, which is a fault and deliberately not a
 * {@link CredentialUnusableError}. Anything else is refused.
 */
export async function openCredential(
  encodedKey: string,
  row: Partial<CredentialBinding> & { encryptedValue: string },
  options: { requireAad?: boolean } = {},
) {
  let version: unknown;
  try {
    version = (JSON.parse(row.encryptedValue) as { version?: unknown })
      ?.version;
  } catch {
    throw new Error("Credential envelope is invalid");
  }
  if (version === 1) {
    if (options.requireAad ?? vaultRequiresAad()) {
      throw new Error(
        "Credential envelope is unbound and this deployment requires bound envelopes",
      );
    }
    return decryptSecret(encodedKey, row.encryptedValue);
  }
  if (version !== 2) {
    throw new Error("Credential envelope is invalid");
  }
  const envelope = JSON.parse(row.encryptedValue) as CredentialEnvelopeV2;
  if (
    envelope.alg !== "A256GCM" ||
    envelope.bind !== "credential" ||
    envelope.kid !== CREDENTIAL_KID ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("Credential envelope is invalid");
  }
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Buffer.from(envelope.iv, "base64"),
      additionalData: credentialAad(requireBinding(row)),
    },
    await aesKey(encodedKey),
    Buffer.from(envelope.ciphertext, "base64"),
  );
  return decoder.decode(plaintext);
}

/**
 * The vault answered, and what it holds cannot be spent: the row is gone, or it is revoked.
 *
 * CRITERION. This is the ONLY thing {@link decryptCredentialForUse} raises that means "access was
 * withdrawn". Everything else it can raise — a query this database refused, a connection it could
 * not open, an envelope that would not decrypt — is a fault, and a caller must be able to tell the
 * two apart without reading either message.
 *
 * REASON. The two used to be plain `Error`s and the only thing separating them from a fault was
 * their wording, which `plugins/store.ts` matched on: a message containing "revoked" or "not found"
 * was a withdrawal, anything else was an error. drizzle reports a failed query as a message that
 * BEGINS `Failed query: select "encrypted_value", "revoked_at" from "credentials" …`, so the column
 * this function reads put the substring into every database fault on this very read — Postgres
 * down, a wrong address, a cancelled statement — and each was announced to the person, the model and
 * the operator as an administrator having taken the credential away. A class cannot be produced by
 * accident that way, and it survives a reworded sentence, which is the same argument
 * `TokenRefusedError` carries a `code` for rather than a phrase in its prose.
 *
 * ONE CLASS FOR BOTH STATES, because no caller acts on the difference: the row being absent and the
 * row being retired are both "this credential is not available and will not become available", and
 * the step is the same. The messages stay distinct for whoever is reading a log.
 */
export class CredentialUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialUnusableError";
  }
}

/**
 * An administrator asked to revoke or rotate a credential that cannot be revoked or rotated as asked.
 *
 * The id names no credential, or one already revoked, or one that is not what the input describes.
 * It carries the status the route answers with. As a plain `Error` it left the route as a bare 500,
 * so a second click on Revoke read as the deployment being broken rather than the credential being
 * gone already.
 */
export class CredentialRefusedError extends Error {
  readonly status: 403 | 404 | 409;

  constructor(message: string, status: 403 | 404 | 409) {
    super(message);
    this.name = "CredentialRefusedError";
    this.status = status;
  }
}

export async function decryptCredentialForUse(
  encodedKey: string,
  reader: CredentialSecretReader,
  credentialId: string,
) {
  const credential = await reader.readSecret(credentialId);
  if (!credential) {
    throw new CredentialUnusableError("Credential was not found");
  }
  if (credential.revokedAt) {
    throw new CredentialUnusableError("Credential is revoked");
  }

  return openCredential(encodedKey, credential);
}

export async function resolveModelApiKey(input: {
  encryptionKey: string;
  reader: ModelCredentialSecretReader;
  provider: "openai" | "anthropic";
  keyId: string;
  environment: Record<string, string | undefined>;
}) {
  const stored = await input.reader.readModelSecret({
    provider: input.provider,
    keyId: input.keyId,
  });
  if (stored) {
    return openCredential(input.encryptionKey, stored);
  }

  const environmentKey =
    input.environment[
      input.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
    ]?.trim();
  return environmentKey || null;
}

/** The only tenant a credential may be written to other than the caller's own. */
export type CredentialTarget = typeof TEAM_TENANT;

/** The kinds that are a shared server's secret, and so the only kinds a `team` target may carry. */
const TEAM_CREDENTIAL_KINDS = [
  "mcp",
  "mcp_oauth_client",
] as const satisfies readonly CredentialKind[];

/**
 * Which tenant a credential write is sealed to and filtered by (G01-E).
 *
 * Without `target` it is the caller's own frame, as it always was. With `target: "team"` it is the
 * shared tenant a team MCP server's secret lives in, and that is allowed only to an administrator
 * holding the admin capability in this very frame (see `auth/admin-scope.ts`) and only for a server
 * secret's kind: a person's own token or an agent key is never sealed where anybody else's frame
 * could reach it (I8). Anything else is refused before a row is read or written.
 */
function credentialTenant(
  kind: CredentialKind | undefined,
  target: CredentialTarget | undefined,
): string {
  const tenant = currentTenant();
  if (target === undefined) return tenant;
  if (target !== TEAM_TENANT) {
    throw new CredentialRefusedError("Unknown credential target", 403);
  }
  if (capabilityFor(tenant) !== "admin") {
    throw new CredentialRefusedError(
      "Only an administrator may write a shared credential",
      403,
    );
  }
  if (
    kind !== undefined &&
    !(TEAM_CREDENTIAL_KINDS as readonly CredentialKind[]).includes(kind)
  ) {
    throw new CredentialRefusedError(
      "Only an MCP server's credential may be shared",
      403,
    );
  }
  return target;
}

/**
 * The row to insert. A sealed value gets its id and tenant chosen here, explicitly, so the binding
 * in its envelope is exactly the row's columns rather than whatever the column default resolves to.
 * `tenant` is the one {@link credentialTenant} answered; a caller that already resolved it passes it
 * so the check and the binding cannot disagree.
 */
async function sealedRow(
  value: CredentialStoreValue,
  tenant: string = credentialTenant(value.kind, value.target),
) {
  const base = {
    kind: value.kind,
    provider: value.provider,
    keyId: value.keyId,
    metadata: value.metadata,
    // Written explicitly only for a target: the caller's own rows keep taking the column default.
    ...(value.target === undefined ? {} : { tenantId: tenant }),
  };
  const { seal, encryptedValue } = value;
  if (!seal) {
    if (typeof encryptedValue !== "string") {
      throw new Error(
        "Credential value carries neither an envelope nor a seal",
      );
    }
    return { ...base, encryptedValue };
  }
  const binding: CredentialBinding = {
    id: randomUUID(),
    tenantId: tenant,
    kind: value.kind,
  };
  return { ...base, ...binding, encryptedValue: await seal(binding) };
}

export function createCredentialStore(
  database: Database,
): CredentialStore &
  CredentialSecretReader &
  CredentialStatusReader &
  ModelCredentialSecretReader {
  return {
    create: async (value, executor = database) => {
      const [credential] = await executor
        .insert(credentials)
        .values(await sealedRow(value))
        .returning({ id: credentials.id, revokedAt: credentials.revokedAt });

      if (!credential) {
        throw new Error("Credential could not be stored");
      }
      return credential;
    },
    updateSecret: async (id, secret, executor = database) => {
      let encryptedValue: string;
      if (typeof secret === "string") {
        encryptedValue = secret;
      } else {
        /*
         * The row's own tenant and kind, read under a lock in the caller's executor, are what the new
         * envelope is bound to. A missing or revoked row is refused below by the same guarded UPDATE.
         */
        const [row] = await executor
          .select({ tenantId: credentials.tenantId, kind: credentials.kind })
          .from(credentials)
          .where(and(eq(credentials.id, id), isNull(credentials.revokedAt)))
          .for("update");
        if (!row) {
          throw new Error("Credential was not found or is revoked");
        }
        encryptedValue = await secret({ id, ...row });
      }
      const [credential] = await executor
        .update(credentials)
        .set({ encryptedValue, updatedAt: new Date() })
        .where(and(eq(credentials.id, id), isNull(credentials.revokedAt)))
        .returning({ id: credentials.id });

      /*
       * One statement, so nothing can revoke the row between a check and the write.
       *
       * The cost is that "no such row" and "revoked" arrive as the same answer, hence the one
       * message naming both. The caller acts identically on either: it refuses its call.
       */
      if (!credential) {
        throw new Error("Credential was not found or is revoked");
      }
    },
    rotate: async (input, executor) => {
      /*
       * Read here, before `write` runs: the tenant whose row is retired and whose envelope is sealed
       * is the caller's (or the target's), decided once, so the check and the binding agree whatever
       * frame the transaction's callback happens to run in.
       */
      const tenant = credentialTenant(input.kind, input.target);
      const write = async (transaction: CredentialExecutor) => {
        /**
         * The previous credential, locked for the rest of the transaction.
         *
         * Two replicas rotating the same secret would otherwise both read it
         * as live and both act; the second waits here and then finds it
         * revoked. Its identity is read alongside its state so a rotation
         * aimed at the wrong id is refused rather than silently retiring a
         * secret the caller never named.
         */
        const [previous] = await transaction
          .select({
            revokedAt: credentials.revokedAt,
            kind: credentials.kind,
            provider: credentials.provider,
            keyId: credentials.keyId,
          })
          .from(credentials)
          .where(
            and(
              eq(credentials.id, input.previousCredentialId),
              // Row security also shows `system` rows; only this tenant's own row is its to retire.
              eq(credentials.tenantId, tenant),
            ),
          )
          .for("update");
        if (!previous) {
          throw new CredentialRefusedError(
            "Previous credential was not found",
            404,
          );
        }
        if (previous.revokedAt) {
          throw new CredentialRefusedError(
            "Previous credential is already revoked",
            409,
          );
        }
        if (
          previous.kind !== input.kind ||
          previous.provider !== input.provider ||
          previous.keyId !== input.keyId
        ) {
          throw new CredentialRefusedError(
            "Previous credential does not match the input's kind, provider or keyId",
            409,
          );
        }

        // Revoke, then insert. Both orders are invisible from outside the
        // transaction, and this one never holds two live rows for one key even
        // in the middle of it, which is the invariant a uniqueness constraint
        // on live credentials would later depend on.
        const revokedAt = new Date();
        const [revoked] = await transaction
          .update(credentials)
          .set({ revokedAt, updatedAt: revokedAt })
          .where(
            and(
              eq(credentials.id, input.previousCredentialId),
              isNull(credentials.revokedAt),
            ),
          )
          .returning({ revokedAt: credentials.revokedAt });
        if (!revoked?.revokedAt) {
          // Ruled out by the lock above under contention; reaching here means
          // the row was deleted outright between the two statements, which
          // aborts the transaction and leaves nothing committed.
          throw new Error("Previous credential was not found");
        }

        const [inserted] = await transaction
          .insert(credentials)
          .values(await sealedRow(input, tenant))
          .returning({
            id: credentials.id,
            revokedAt: credentials.revokedAt,
          });
        if (!inserted) {
          throw new Error("Credential could not be stored");
        }

        return inserted;
      };

      // A caller already in a transaction has its own atomicity to keep, and
      // the credential belongs to it rather than to a transaction of its own.
      return executor ? write(executor) : database.transaction(write);
    },
    revoke: async (id, executor = database, target) => {
      // A target is checked before anything is written; its kind is pinned in the WHERE below.
      const shared =
        target === undefined
          ? undefined
          : and(
              eq(credentials.tenantId, credentialTenant(undefined, target)),
              inArray(credentials.kind, [...TEAM_CREDENTIAL_KINDS]),
            );
      const revokedAt = new Date();
      const [credential] = await executor
        .update(credentials)
        .set({ revokedAt, updatedAt: revokedAt })
        // Only a live row is stamped. Without the guard a second revoke would
        // overwrite the first one's timestamp and report success, so a caller
        // could not tell retiring a credential from finding it already gone.
        .where(
          and(eq(credentials.id, id), isNull(credentials.revokedAt), shared),
        )
        .returning({ revokedAt: credentials.revokedAt });

      if (!credential?.revokedAt) {
        throw new CredentialRefusedError(
          "Credential was not found or already revoked",
          404,
        );
      }
      return credential.revokedAt;
    },
    isLive: async (id, executor = database) => {
      const [credential] = await executor
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.id, id), isNull(credentials.revokedAt)));

      return credential !== undefined;
    },
    findLiveByKey: async (
      { kind, provider, keyId, target },
      executor = database,
    ) => {
      const tenant = credentialTenant(kind, target);
      const [credential] = await executor
        .select({ id: credentials.id })
        .from(credentials)
        .where(
          and(
            eq(credentials.tenantId, tenant),
            eq(credentials.kind, kind),
            eq(credentials.provider, provider),
            eq(credentials.keyId, keyId),
            isNull(credentials.revokedAt),
          ),
        );

      return credential ?? null;
    },
    readSecret: async (id) => {
      const [credential] = await database
        .select({
          encryptedValue: credentials.encryptedValue,
          revokedAt: credentials.revokedAt,
          id: credentials.id,
          tenantId: credentials.tenantId,
          kind: credentials.kind,
        })
        .from(credentials)
        .where(eq(credentials.id, id));

      return credential ?? null;
    },
    readModelSecret: async ({ provider, keyId }) => {
      const [credential] = await database
        .select({
          encryptedValue: credentials.encryptedValue,
          id: credentials.id,
          tenantId: credentials.tenantId,
          kind: credentials.kind,
        })
        .from(credentials)
        .where(
          and(
            eq(credentials.kind, "model"),
            eq(credentials.provider, provider),
            eq(credentials.keyId, keyId),
            // A model-library key is reached by the library row's id, never by this name.
            notLike(credentials.keyId, `${MODEL_REGISTRY_KEY_PREFIX}%`),
            isNull(credentials.revokedAt),
          ),
        )
        .orderBy(
          /*
           * The deployment's key before any tenant's. Row security shows this tenant's rows beside
           * `system`'s, and with keys unique per tenant (audit #9) a tenant can hold a row under the
           * same name; it must not become the key the deployment runs on.
           */
          desc(sql`(${credentials.tenantId} = 'system')`),
          desc(credentials.createdAt),
          // UUID descending selects the lexicographically greatest ID on a timestamp tie.
          desc(credentials.id),
        )
        .limit(1);

      return credential ?? null;
    },
    list: async () => {
      const records = await database
        .select({
          id: credentials.id,
          kind: credentials.kind,
          provider: credentials.provider,
          keyId: credentials.keyId,
          metadata: credentials.metadata,
          revokedAt: credentials.revokedAt,
        })
        .from(credentials)
        .orderBy(credentials.createdAt);

      return records.map((credential) => ({
        ...credential,
        metadata: credential.metadata as Record<string, unknown>,
      }));
    },
  };
}

export type CredentialInput = {
  kind: CredentialKind;
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  plaintext: string;
  actorUserId?: string;
};

export type CredentialAdminService = CredentialStatusReader & {
  create: (input: CredentialInput) => Promise<CredentialStatus>;
  rotate: (
    input: CredentialInput & { previousCredentialId: string },
  ) => Promise<CredentialStatus>;
  revoke: (
    credentialId: string,
    actorUserId?: string,
  ) => Promise<{
    id: string;
    revokedAt: Date;
  }>;
};

async function persistCredential(
  service: CredentialService,
  input: CredentialInput,
): Promise<CredentialStatus> {
  const stored = await service.store.create({
    kind: input.kind,
    provider: input.provider,
    keyId: input.keyId,
    metadata: input.metadata,
    seal: (binding) =>
      sealCredential(service.encryptionKey, binding, input.plaintext),
  });

  return {
    id: stored.id,
    kind: input.kind,
    provider: input.provider,
    keyId: input.keyId,
    metadata: input.metadata,
    revokedAt: stored.revokedAt,
  };
}

/**
 * Store a credential for a key.
 *
 * A key holds one live credential, so storing a second one for a key that
 * already has one is a replacement rather than an addition, and it is carried
 * out as a rotation: the two writes are atomic and the trail records
 * `credential.rotated` naming what was replaced.
 *
 * This is the shape the product asks for. The Credentials page offers Add and
 * Revoke and has no rotate control, so replacing a model key is done by adding
 * one for the same provider and keyId. Refusing that would leave no way to
 * replace a key at all, and inserting it would raise a bare unique violation
 * from `credentials_tenant_active_key_idx`.
 */
export async function createCredential(
  service: CredentialService,
  input: CredentialInput,
): Promise<CredentialStatus> {
  const existing = await service.store.findLiveByKey({
    kind: input.kind,
    provider: input.provider,
    keyId: input.keyId,
  });
  if (existing) {
    return rotateCredential(service, {
      ...input,
      previousCredentialId: existing.id,
    });
  }

  const credential = await persistCredential(service, input);

  await recordAuditEvent(service.auditStore, {
    eventType: "credential.created",
    targetType: "credential",
    targetId: credential.id,
    actorUserId: input.actorUserId,
    payload: {
      kind: input.kind,
      provider: input.provider,
      keyId: input.keyId,
    },
  });

  return credential;
}

export async function rotateCredential(
  service: CredentialService,
  input: CredentialInput & { previousCredentialId: string },
): Promise<CredentialStatus> {
  // The store seals the new secret for the row id it picks, inside its
  // transaction, because the envelope is bound to that id (audit #9); one
  // AES-GCM call is all that runs while the connection is held. Both writes are
  // atomic, and a failure leaves the vault as it was, which is why the success
  // event below is written only once that has returned.
  let stored: StoredCredential;
  try {
    stored = await service.store.rotate({
      previousCredentialId: input.previousCredentialId,
      kind: input.kind,
      provider: input.provider,
      keyId: input.keyId,
      metadata: input.metadata,
      seal: (binding) =>
        sealCredential(service.encryptionKey, binding, input.plaintext),
    });
  } catch (error) {
    /*
     * A refused rotation is worth a row of its own.
     *
     * The vault refuses one aimed at a credential that is already revoked, one aimed at a credential
     * that does not exist, and one whose key does not match the credential it names. Each of those is
     * either a caller with a bug or an attempt to retire a key the caller was not asked to retire,
     * and each of them left nothing behind while only successes were recorded.
     *
     * Written outside the transaction that has just rolled back, so the row survives the failure it
     * describes.
     *
     * THE REASON IS ASKED FOR THROUGH {@link reasonWithoutStatement}, and the sentence this comment
     * used to carry — "the vault's own message and never the secret, which never left this
     * function" — was false. Not every throw caught here is the vault's own: the rotation runs
     * three statements, and a `DrizzleQueryError` from any of them has `Failed query: <the
     * statement>` and `params: <every bound value>` for a message. The insert binds
     * `encryptedValue`, so the values in that message include the credential envelope this function
     * had just built — and `audit_events` is append-only by trigger, exported, and kept for the
     * deployment's whole retention window, so a secret landing there is not one anybody can take
     * back out. A refusal the vault itself wrote still arrives here word for word; only the shape
     * that carries a statement is answered with the driver's complaint instead.
     */
    await recordAuditEvent(service.auditStore, {
      eventType: "credential.rotation_refused",
      targetType: "credential",
      targetId: input.previousCredentialId,
      actorUserId: input.actorUserId,
      payload: {
        kind: input.kind,
        provider: input.provider,
        keyId: input.keyId,
        reason: reasonWithoutStatement(error),
      },
    });
    throw error;
  }

  await recordAuditEvent(service.auditStore, {
    eventType: "credential.rotated",
    targetType: "credential",
    targetId: stored.id,
    actorUserId: input.actorUserId,
    payload: {
      previousCredentialId: input.previousCredentialId,
      kind: input.kind,
      provider: input.provider,
      keyId: input.keyId,
    },
  });

  return {
    id: stored.id,
    kind: input.kind,
    provider: input.provider,
    keyId: input.keyId,
    metadata: input.metadata,
    revokedAt: stored.revokedAt,
  };
}

export async function revokeCredential(
  service: CredentialService,
  credentialId: string,
  actorUserId?: string,
) {
  const revokedAt = await service.store.revoke(credentialId);

  await recordAuditEvent(service.auditStore, {
    eventType: "credential.revoked",
    targetType: "credential",
    targetId: credentialId,
    actorUserId,
    payload: {},
  });

  return { id: credentialId, revokedAt };
}

export function createCredentialAdminService(
  encryptionKey: string,
  store: CredentialStore & CredentialStatusReader,
  auditStore: AuditStore,
): CredentialAdminService {
  const service = { encryptionKey, store, auditStore };

  return {
    list: store.list,
    create: (input) => createCredential(service, input),
    rotate: (input) => rotateCredential(service, input),
    revoke: (credentialId, actorUserId) =>
      revokeCredential(service, credentialId, actorUserId),
  };
}
