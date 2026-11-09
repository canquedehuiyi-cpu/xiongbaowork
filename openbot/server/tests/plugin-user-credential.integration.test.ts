import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  credentials,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  users,
} from "../src/db/schema";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { createAdminRequest, seedAdministrator } from "./support/admin-request";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Whose credential a call to a `user-oauth` server goes out with.
 *
 * Every test here is a refusal or a selection, and both matter for the same reason: this is the
 * mechanism that makes two people asking one question get the answers their own accounts can see.
 * The failure that must not exist is a call falling back to somebody else's grant, or to the
 * deployment's, when the asker has none of their own. That failure is silent by nature — it returns
 * a plausible answer built from documents the asker cannot open — so it is tested for directly
 * rather than inferred from the happy path working.
 *
 * The vendor is never reached. Every case below is decided before the network, which is itself the
 * property: a call with no grant behind it must not leave the building.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const suite = randomUUID().slice(0, 8);
const botId = `agent_oauth_bot_${suite}`;
const askerId = `user_oauth_asker_${suite}`;
const otherId = `user_oauth_other_${suite}`;
/** The administrator who added the server and registered its OAuth client (G01-E P10). */
const adminId = `user_oauth_admin_${suite}`;
const serverId = "google-drive";
const toolName = "search_files";
const ref = `${serverId}/${toolName}`;

// 32 zero bytes in base64. A real AES-256 key length, unlike `"x".repeat(44)`, which decodes to 33
// bytes and makes `importKey` throw — the existing plugin store test gets away with it only because
// every call there is refused before the vault is ever opened.
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

/** The refresh tokens each person's row points at, so a test can tell whose was chosen. */
const askerRefreshToken = `refresh-token-for-asker-${suite}`;
const otherRefreshToken = `refresh-token-for-other-${suite}`;

/**
 * Every token the store decrypted, in order.
 *
 * The store hands a token to the MCP client, which is the one thing this test cannot let happen for
 * real. Recording it at the vault boundary instead answers the only question that matters — whose
 * secret was about to be sent — without a vendor to send it to.
 */
const decrypted: string[] = [];

/** Every refresh token handed to the vendor's token endpoint, in order. */
const exchanged: string[] = [];

/** The deployment's OAuth client, as the connect flow will eventually write it. */
const CLIENT = { clientId: "client-id", clientSecret: "client-secret" };

/** What a minted access token looks like, so a test can tell which refresh token produced it. */
const accessTokenFrom = (refreshToken: string) => `access(${refreshToken})`;

let serverWasAlreadyConfigured = false;
/**
 * The OAuth client this deployment had before the suite ran, restored afterwards.
 *
 * `mcp_servers.credential_id` is live configuration: on a database somebody uses, it points at the
 * client an administrator registered. This suite has to repoint it to exercise the selection, and it
 * used to leave it repointed at a credential the cleanup then deleted — so the connector afterwards
 * reported "no OAuth client registered yet" and the administrator's own registration was gone.
 *
 * There is no foreign key to catch that: `mcp_servers.credential_id` is `text` against a `uuid`
 * primary key, so the database will hold a pointer to a row that does not exist.
 */
let clientBefore: string | null = null;
/**
 * Whether this deployment already advertised the tool this suite inserts.
 *
 * The vendor really does advertise `search_files`, so deleting by name regardless would take a real
 * row; never deleting leaves a fixture that reads on screen as a tool the vendor offers.
 */
let toolWasAlreadyAdvertised = false;
const credentialIds: string[] = [];

/*
 * THREE FRAMES, by whose row it is (G01, G01-E P10).
 *
 * A person's own rows — their user row, the refresh token they granted and the connection pointing
 * at it — are written and read back in that person's frame. The deployment's server rows — the Drive
 * server, its tool and its OAuth client — are the team's, stamped `team`, and written by an
 * administrator holding the admin capability, as the admin routes write them. The Bot is a public
 * team Bot, so each person's frame may run it and see its grant. Calls run in the asker's own frame,
 * as a person's chat turn runs them; the same calls are also asked as `platform` (background work),
 * which reads every tenant's rows. The cross-person questions (the retirements, the cleanup) run as
 * `platform`. Which person's grant a call spends is still decided by `actorId` alone, and a person's
 * frame can spend nobody's but their own: that is what these tests are about.
 */
function asPerson<T>(userId: string, work: () => Promise<T>) {
  return runAsTenant(userId, work);
}
function asPlatform<T>(work: () => Promise<T>) {
  return runAsTenant("platform", work);
}
const adminRequest = createAdminRequest(database);
function asAdmin<T>(work: () => Promise<T>) {
  return adminRequest(adminId, work);
}
let releaseAdmin: (() => Promise<void>) | undefined;

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    readSecret: async (id) => {
      const [row] = await database
        .select({
          encryptedValue: credentials.encryptedValue,
          revokedAt: credentials.revokedAt,
          // What the vault's own reader reports, which the store checks a server's secret against.
          id: credentials.id,
          tenantId: credentials.tenantId,
          kind: credentials.kind,
        })
        .from(credentials)
        .where(eq(credentials.id, id));
      return row ?? null;
    },
    // This suite writes its rows directly, so that what is under test is the selection rather than
    // the connect flow. Loud rather than absent, so a call here shows up instead of passing quietly.
    create: async () => {
      throw new Error("this suite writes credentials directly");
    },
    // Google does not rotate, so no exchange here ever reaches the in-place update. Loud, so that
    // one starting to would show up rather than pass quietly.
    updateSecret: async () => {
      throw new Error("this suite writes credentials directly");
    },
    /*
     * A real revocation, against this suite's own rows.
     *
     * It used to throw, on the same principle as `create` above: nothing in the suite revoked, so a
     * call here meant the file had quietly started exercising something it did not claim to. That
     * stopped being true when retirement arrived — revoking IS the thing under test now, and the
     * assertion is that the vault row comes back revoked, which a stub cannot show.
     *
     * `create` still throws, because connections are still written directly.
     */
    revoke: async (id) => {
      const [row] = await database
        .update(credentials)
        .set({ revokedAt: new Date() })
        .where(eq(credentials.id, id))
        .returning({ revokedAt: credentials.revokedAt });
      if (!row?.revokedAt) throw new Error("credential was not revoked");
      return row.revokedAt;
    },
    // The rest of the vault is not this suite's: loud, like `create`.
    rotate: async () => {
      throw new Error("this suite writes credentials directly");
    },
    isLive: async () => {
      throw new Error("this suite writes credentials directly");
    },
    findLiveByKey: async () => {
      throw new Error("this suite writes credentials directly");
    },
  },
  encryptionKey: ENCRYPTION_KEY,
  policy: () => policy,
  // Stops before the network, and records what the call would have gone out with.
  callVendor: async (connection) => {
    decrypted.push(connection.token ?? "<none>");
    return { text: "[vendor not reached in tests]", isError: false };
  },
  /*
   * Stands in for Google's token endpoint, and records whose refresh token was presented.
   *
   * This is where the security property is observable. The access token that reaches the vendor is
   * derived from the refresh token that was spent, so asserting on it proves the whole chain picked
   * one person's grant — rather than proving only that some token was sent.
   */
  exchangeRefreshToken: async ({ client, refreshToken }) => {
    expect(client).toEqual(CLIENT);
    exchanged.push(refreshToken);
    return { accessToken: accessTokenFrom(refreshToken) };
  },
});

/**
 * Retire whatever this key currently holds, the way the product now does.
 *
 * These fixtures insert straight into the vault rather than going through the store, and a key holds
 * at most one live credential since `credentials_active_key_idx`. Re-registering a client or
 * reconnecting a person is a replacement, so the row it replaces is revoked first; without this the
 * second test to call either helper meets the index instead of the behaviour it came to check.
 */
async function retireLive(
  kind: "mcp_oauth_client" | "mcp_user_token",
  keyId: string,
) {
  const revokedAt = new Date();
  // A person's token is theirs; the OAuth client is the team's, retired by an administrator.
  const retire =
    kind === "mcp_user_token" ? asPerson.bind(null, keyId) : asAdmin;
  await retire(() =>
    database
      .update(credentials)
      .set({ revokedAt, updatedAt: revokedAt })
      .where(
        and(
          eq(credentials.kind, kind),
          eq(credentials.provider, serverId),
          eq(credentials.keyId, keyId),
          isNull(credentials.revokedAt),
        ),
      ),
  );
}

/** Register the deployment's OAuth client, which is what `mcp_servers.credential_id` holds. */
async function registerClient() {
  await retireLive("mcp_oauth_client", "oauth-client");
  const encryptedValue = await encryptSecret(
    ENCRYPTION_KEY,
    JSON.stringify(CLIENT),
  );
  // Sealed to `team`, beside its `team` server, by an administrator (G01-E P10, Q3).
  const [credential] = await asAdmin(() =>
    database
      .insert(credentials)
      .values({
        tenantId: "team",
        kind: "mcp_oauth_client",
        provider: serverId,
        keyId: "oauth-client",
        metadata: { clientId: CLIENT.clientId },
        encryptedValue,
      })
      .returning({ id: credentials.id }),
  );
  if (!credential) throw new Error("client was not stored");
  credentialIds.push(credential.id);
  await asAdmin(() =>
    database
      .update(mcpServers)
      .set({ credentialId: credential.id })
      .where(eq(mcpServers.id, serverId)),
  );
  return credential.id;
}

async function connect(userId: string, refreshToken: string) {
  await retireLive("mcp_user_token", userId);
  const encryptedValue = await encryptSecret(ENCRYPTION_KEY, refreshToken);
  const [credential] = await asPerson(userId, () =>
    database
      .insert(credentials)
      .values({
        kind: "mcp_user_token",
        provider: serverId,
        keyId: userId,
        metadata: {},
        encryptedValue,
      })
      .returning({ id: credentials.id }),
  );
  if (!credential) throw new Error("credential was not stored");
  credentialIds.push(credential.id);

  await asPerson(userId, () =>
    database
      .insert(mcpUserCredentials)
      .values({
        serverId,
        userId,
        credentialId: credential.id,
        scope: "https://www.googleapis.com/auth/drive.readonly",
      })
      .onConflictDoUpdate({
        target: [mcpUserCredentials.serverId, mcpUserCredentials.userId],
        set: { credentialId: credential.id },
      }),
  );
  return credential.id;
}

beforeAll(async () => {
  releaseAdmin = await seedAdministrator(database, adminId);
  for (const [id, email] of [
    [askerId, `${askerId}@openbot.test`],
    [otherId, `${otherId}@openbot.test`],
  ]) {
    await asPerson(id, () =>
      database
        .insert(users)
        .values({ id, email, name: id, emailVerified: false })
        .onConflictDoNothing(),
    );
  }

  /*
   * A public team Bot (G01-E P8b), owned by the other person: the asker runs it as a teammate, and
   * both people's frames see it and its grant. Written as `platform`, as a fixture across people.
   */
  await asPlatform(async () => {
    await database
      .insert(agents)
      .values({
        id: botId,
        tenantId: "team",
        name: "Drive Desk",
        type: "remote_ag_ui",
        configuration: {},
      })
      .onConflictDoNothing();
    await database
      .insert(agentProfiles)
      .values({
        agentId: botId,
        tenantId: "team",
        ownerUserId: otherId,
        title: "Research",
        roleDescription: "Finds documents.",
        avatarSeed: "seed",
        visibility: "public",
      })
      .onConflictDoNothing();
  });

  const [existing] = await asPlatform(() =>
    database
      .select({ id: mcpServers.id, credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId)),
  );
  serverWasAlreadyConfigured = existing !== undefined;
  toolWasAlreadyAdvertised =
    (
      await asPlatform(() =>
        database
          .select({ name: mcpTools.name })
          .from(mcpTools)
          .where(
            and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)),
          ),
      )
    ).length > 0;
  clientBefore = existing?.credentialId ?? null;

  // Written directly, so the test needs no vendor to be reachable. What is under test is which
  // credential gets chosen, not the listing. The team's rows, by an administrator (G01-E P10).
  await asAdmin(() =>
    database
      .insert(mcpServers)
      .values({
        id: serverId,
        tenantId: "team",
        title: "Google Drive",
        vendor: "Google",
        url: "https://www.googleapis.com/drive/v3",
        provenance: "first-party",
      })
      .onConflictDoNothing(),
  );
  await asAdmin(() =>
    database
      .insert(mcpTools)
      .values({
        serverId,
        tenantId: "team",
        name: toolName,
        description: "Search files.",
      })
      .onConflictDoNothing(),
  );

  // The Bot holds the tool throughout, a team Bot's grant stamped `team` by an administrator.
  // Everything here is about the person, not the grant.
  await asAdmin(() =>
    database
      .insert(pluginGrants)
      .values({ kind: "mcp", ref, agentId: botId, tenantId: "team" })
      .onConflictDoNothing(),
  );
});

afterAll(async () => {
  /*
   * The suite's own two people, never every row for this vendor.
   *
   * `serverId` here is a real catalogue key, so a deployment somebody uses has real connections
   * under it — and deleting by server id took a person's actual Drive connection with it, after
   * their consent had succeeded. The user ids carry this run's random suffix, so nothing outside it
   * can match.
   */
  await asPlatform(() =>
    database
      .delete(mcpUserCredentials)
      .where(
        and(
          eq(mcpUserCredentials.serverId, serverId),
          inArray(mcpUserCredentials.userId, [askerId, otherId]),
        ),
      ),
  );
  /*
   * Put the client pointer back before deleting anything, so a suite that borrowed live
   * configuration leaves it as it found it. Ordered first on purpose: the deletes below remove the
   * credential the row is currently pointing at.
   *
   * UNCONDITIONAL, and it used to be guarded by `serverWasAlreadyConfigured`. On a database that
   * already had the server the guard was harmless, which is why this passed locally for as long as
   * it did. On a fresh one — CI — the guard skipped, the column kept pointing at a credential this
   * suite created, and the delete below was refused by the foreign key.
   *
   * The guard was hiding a real leak rather than avoiding one. Before that key existed the delete
   * SUCCEEDED and left `mcp_servers.credential_id` addressing a row that no longer existed, which is
   * exactly the dangling pointer that made a configured connector report having no client. Restoring
   * it is right in both cases: `clientBefore` is null when there was no server to borrow from, which
   * is what the column should say.
   */
  await asPlatform(() =>
    database
      .update(mcpServers)
      .set({ credentialId: clientBefore })
      .where(eq(mcpServers.id, serverId)),
  );
  for (const id of credentialIds) {
    await asPlatform(() =>
      database.delete(credentials).where(eq(credentials.id, id)),
    );
  }
  /*
   * Scoped to this suite's own Bot, never to the ref alone. `ref` is `google-drive/search_files`,
   * a real server and a real tool, so a delete by ref alone removes an administrator's grants for
   * Bots people use. See the same note in plugin-store.integration.test.ts, which this shares.
   */
  await asPlatform(() =>
    database
      .delete(pluginGrants)
      .where(and(eq(pluginGrants.ref, ref), eq(pluginGrants.agentId, botId))),
  );
  // The fixture tool goes whether or not this suite owns the server, but only if it put it there.
  if (!toolWasAlreadyAdvertised) {
    await asPlatform(() =>
      database
        .delete(mcpTools)
        .where(
          and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)),
        ),
    );
  }
  if (!serverWasAlreadyConfigured) {
    await asPlatform(() =>
      database.delete(mcpTools).where(eq(mcpTools.serverId, serverId)),
    );
    await asPlatform(() =>
      database.delete(mcpServers).where(eq(mcpServers.id, serverId)),
    );
  }
  await asPlatform(() => database.delete(agents).where(eq(agents.id, botId)));
  await asPerson(askerId, () =>
    database.delete(users).where(eq(users.id, askerId)),
  );
  await asPerson(otherId, () =>
    database.delete(users).where(eq(users.id, otherId)),
  );
  await releaseAdmin?.();
  await database.$client.close();
});

describe("a person who has not connected", () => {
  test("is refused, and told to connect rather than told it broke", () => {
    // A refusal, not an error. Nothing is wrong: they simply have not granted access yet, and the
    // sentence they get should be one they can act on.
    expect(
      asPlatform(() =>
        store.callTool({ ref, args: {}, botId, actorId: askerId }),
      ),
    ).rejects.toThrow(PluginRefusedError);
  });

  test("is not quietly served the deployment's own credential", async () => {
    // The failure this whole table exists to prevent. A fallback here would answer from whatever the
    // deployment could see and look exactly like a correct answer.
    //
    // A REAL credential row, where this used to write the string "a-deployment-credential". The
    // column was `text` against a `uuid` primary key with no foreign key, so the database accepted a
    // pointer to something that could not exist — and the test was therefore asserting against a
    // state no deployment could reach, which is a weaker claim than it looked. It is now a genuine
    // deployment credential that a fallback could really have spent.
    const deploymentCredential = await registerClient();

    await expect(
      asPlatform(() =>
        store.callTool({ ref, args: {}, botId, actorId: askerId }),
      ),
    ).rejects.toThrow(PluginRefusedError);
    expect(decrypted).toEqual([]);

    // Repointed away before the credential is left behind, because the foreign key is `restrict`:
    // the row cannot be deleted while this column addresses it, which is the point of the key.
    await asPlatform(() =>
      database
        .update(mcpServers)
        .set({ credentialId: null })
        .where(eq(mcpServers.id, serverId)),
    );
    expect(deploymentCredential).toBeTruthy();
  });
});

describe("nobody in particular", () => {
  test("cannot borrow a connected person's access", async () => {
    await connect(askerId, askerRefreshToken);
    decrypted.length = 0;

    // The anonymous actor is the empty string, and an empty string must never match a row. A lookup
    // that let it through would hand a run nobody is attributable for whichever grant sorted first.
    await expect(
      asPlatform(() => store.callTool({ ref, args: {}, botId, actorId: "" })),
    ).rejects.toThrow(PluginRefusedError);
    expect(decrypted).toEqual([]);
  });
});

describe("a person who has connected", () => {
  test("is told plainly when the deployment has registered no client", async () => {
    // The person did their part and cannot fix this one, so the refusal names the administrator's
    // job rather than sending them back to try connecting again.
    await connect(askerId, askerRefreshToken);
    await asPlatform(() =>
      database
        .update(mcpServers)
        .set({ credentialId: null })
        .where(eq(mcpServers.id, serverId)),
    );

    await expect(
      asPlatform(() =>
        store.callTool({ ref, args: {}, botId, actorId: askerId }),
      ),
    ).rejects.toThrow(/OAuth client/);
  });

  test("goes out with their own token and nobody else's", async () => {
    await registerClient();
    await connect(askerId, askerRefreshToken);
    await connect(otherId, otherRefreshToken);
    decrypted.length = 0;
    exchanged.length = 0;

    await asPlatform(() =>
      store.callTool({ ref, args: {}, botId, actorId: askerId }),
    );
    expect(exchanged).toEqual([askerRefreshToken]);
    expect(decrypted).toEqual([accessTokenFrom(askerRefreshToken)]);

    decrypted.length = 0;
    exchanged.length = 0;
    await asPlatform(() =>
      store.callTool({ ref, args: {}, botId, actorId: otherId }),
    );
    expect(exchanged).toEqual([otherRefreshToken]);
    expect(decrypted).toEqual([accessTokenFrom(otherRefreshToken)]);
  });

  test("never sends the refresh token itself to the vendor", async () => {
    // The refresh token is long-lived and reauthorises indefinitely; the access token expires. Only
    // the short-lived one may leave, and a regression here would be invisible in behaviour.
    await registerClient();
    await connect(askerId, askerRefreshToken);
    decrypted.length = 0;

    await asPlatform(() =>
      store.callTool({ ref, args: {}, botId, actorId: askerId }),
    );
    expect(decrypted).not.toContain(askerRefreshToken);
  });

  test("is refused once their credential is revoked, and told to reconnect", async () => {
    const credentialId = await connect(askerId, askerRefreshToken);
    decrypted.length = 0;

    await asPerson(askerId, () =>
      database
        .update(credentials)
        .set({ revokedAt: new Date() })
        .where(eq(credentials.id, credentialId)),
    );

    /*
     * A refusal rather than a thrown vendor error.
     *
     * The vault already refuses a revoked secret, but it does so by throwing, which reaches the
     * person as "that tool could not be called" — indistinguishable from the vendor being down. A
     * withdrawn grant is not a fault, and the sentence should say what to do about it.
     */
    await expect(
      asPlatform(() =>
        store.callTool({ ref, args: {}, botId, actorId: askerId }),
      ),
    ).rejects.toThrow(PluginRefusedError);
    expect(decrypted).toEqual([]);
  });

  test("does not gain access to a server they connected a different one for", async () => {
    // The lookup is keyed on the pair. A row for one server must not satisfy another.
    await connect(askerId, askerRefreshToken);
    decrypted.length = 0;

    await asPlatform(() =>
      database
        .delete(mcpUserCredentials)
        .where(
          and(
            eq(mcpUserCredentials.serverId, serverId),
            inArray(mcpUserCredentials.userId, [askerId, otherId]),
          ),
        ),
    );

    await expect(
      asPlatform(() =>
        store.callTool({ ref, args: {}, botId, actorId: askerId }),
      ),
    ).rejects.toThrow(PluginRefusedError);
    expect(decrypted).toEqual([]);
  });
});

/*
 * The same selection asked from the asker's OWN frame, which is how a person's chat turn calls a tool
 * (G01-E P10). The team's OAuth client is sealed to `team` and no person's frame may read it by id:
 * it reaches the call through the `openbot_team_server_secret` broker. A person's frame reads only
 * that person's own connection, so it can never spend anybody else's grant, whoever it names.
 */
describe("in the asker's own frame", () => {
  test("each person goes out with their own token and nobody else's", async () => {
    const clientId = await registerClient();
    await connect(askerId, askerRefreshToken);
    await connect(otherId, otherRefreshToken);
    decrypted.length = 0;
    exchanged.length = 0;

    await asPerson(askerId, () =>
      store.callTool({ ref, args: {}, botId, actorId: askerId }),
    );
    expect(exchanged).toEqual([askerRefreshToken]);
    expect(decrypted).toEqual([accessTokenFrom(askerRefreshToken)]);

    decrypted.length = 0;
    exchanged.length = 0;
    await asPerson(otherId, () =>
      store.callTool({ ref, args: {}, botId, actorId: otherId }),
    );
    expect(exchanged).toEqual([otherRefreshToken]);
    expect(decrypted).toEqual([accessTokenFrom(otherRefreshToken)]);

    // The client came through the broker: neither frame can read it by id.
    for (const person of [askerId, otherId]) {
      expect(
        await asPerson(person, () =>
          database
            .select({ id: credentials.id })
            .from(credentials)
            .where(eq(credentials.id, clientId)),
        ),
      ).toEqual([]);
    }
  });

  test("naming another person spends nothing of theirs", async () => {
    await registerClient();
    await connect(askerId, askerRefreshToken);
    await connect(otherId, otherRefreshToken);
    decrypted.length = 0;
    exchanged.length = 0;

    // The asker's frame, claiming to act for the other person: their connection is not this frame's
    // to read, so the call is refused as one nobody connected, before any token is exchanged.
    await expect(
      asPerson(askerId, () =>
        store.callTool({ ref, args: {}, botId, actorId: otherId }),
      ),
    ).rejects.toThrow(PluginRefusedError);
    expect(exchanged).toEqual([]);
    expect(decrypted).toEqual([]);
  });
});

/*
 * OFFBOARDING. "We removed their access" has to be true of the refresh token, not only of the
 * session — the session is the half they cannot use, and the token is the half this deployment is
 * still holding. For a per-person connector it is the first thing a customer asks about.
 */
describe("retiring the credentials a person owns", () => {
  /*
   * Counted as a property, not as a number.
   *
   * `connect` above writes vault rows directly and leaves earlier ones alone, so how many a person
   * has accumulated depends on which tests ran first — and asserting an exact `retired` count would
   * make these pass or fail on suite order rather than on behaviour. What has to be true is that
   * nothing usable is left, which is the same claim however many there were.
   *
   * The product path does not accumulate them: `recordConnection` revokes the previous credential
   * when it repoints the join row.
   */
  const unrevokedTokensFor = async (userId: string) =>
    (
      await asPerson(userId, () =>
        database
          .select({ id: credentials.id })
          .from(credentials)
          .where(
            and(
              eq(credentials.kind, "mcp_user_token"),
              eq(credentials.keyId, userId),
              isNull(credentials.revokedAt),
            ),
          ),
      )
    ).length;

  test("the vault stops holding a usable secret, and the connection is gone", async () => {
    await registerClient();
    const credentialId = await connect(askerId, askerRefreshToken);

    // Reachable first, so what follows is an assertion about the retirement and not about setup.
    await asPlatform(() =>
      store.callTool({ ref, args: {}, botId, actorId: askerId }),
    );
    expect(exchanged.at(-1)).toBe(askerRefreshToken);

    await asPlatform(() =>
      store.retireConnectionsFor(askerId, "admin@openbot.local"),
    );

    const [credential] = await asPerson(askerId, () =>
      database
        .select({ revokedAt: credentials.revokedAt })
        .from(credentials)
        .where(eq(credentials.id, credentialId)),
    );
    expect(credential?.revokedAt).not.toBeNull();
    expect(await unrevokedTokensFor(askerId)).toBe(0);

    // The join row goes too, so no page claims a connection this deployment can no longer use.
    expect(await asPlatform(() => store.connectionsFor(askerId))).toEqual([]);

    // And a call is refused rather than answered from a revoked credential.
    await expect(
      asPlatform(() =>
        store.callTool({ ref, args: {}, botId, actorId: askerId }),
      ),
    ).rejects.toBeInstanceOf(PluginRefusedError);
  });

  /*
   * THE ORPHAN. `mcp_user_credentials.user_id` cascades, so deleting a user row takes the join row
   * with it and leaves the credential behind: unrevoked, referenced by nothing, reachable from no
   * screen. Looking the owner up in the vault by `key_id` instead of through the join table is what
   * makes it reachable at all, so that is asserted rather than assumed.
   */
  test("a credential orphaned by a deleted user row is still retired", async () => {
    await registerClient();
    const credentialId = await connect(otherId, otherRefreshToken);

    // Exactly what the cascade leaves behind.
    await asPerson(otherId, () =>
      database
        .delete(mcpUserCredentials)
        .where(eq(mcpUserCredentials.userId, otherId)),
    );

    await asPlatform(() =>
      store.retireConnectionsFor(otherId, "admin@openbot.local"),
    );

    const [credential] = await asPerson(otherId, () =>
      database
        .select({ revokedAt: credentials.revokedAt })
        .from(credentials)
        .where(eq(credentials.id, credentialId)),
    );
    expect(credential?.revokedAt).not.toBeNull();
    expect(await unrevokedTokensFor(otherId)).toBe(0);
  });

  test("retiring twice is quiet, and nobody owns nothing", async () => {
    await registerClient();
    await connect(askerId, askerRefreshToken);

    expect(
      (
        await asPlatform(() =>
          store.retireConnectionsFor(askerId, "admin@openbot.local"),
        )
      ).retired,
    ).toBeGreaterThan(0);
    // Already revoked is something an administrator can legitimately do twice.
    expect(
      (
        await asPlatform(() =>
          store.retireConnectionsFor(askerId, "admin@openbot.local"),
        )
      ).retired,
    ).toBe(0);
    // The empty actor is ANONYMOUS_ACTOR. It owns nothing, and must not match rows by being empty.
    expect(
      (
        await asPlatform(() =>
          store.retireConnectionsFor("", "admin@openbot.local"),
        )
      ).retired,
    ).toBe(0);
  });
});
