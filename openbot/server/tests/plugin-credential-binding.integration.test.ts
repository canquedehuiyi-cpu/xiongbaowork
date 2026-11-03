import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import {
  createCredentialAdminService,
  createCredentialStore,
  encryptSecret,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials, mcpServers, mcpTools } from "../src/db/schema";
import {
  CustomServerRefusedError,
  createPluginStore,
} from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { createAdminRequest, seedAdministrator } from "./support/admin-request";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Which address a stored credential may be spent against, and whose it has to be.
 *
 * Pointing a server at a credential is the one place this deployment accepts a *reference* to a
 * secret rather than the secret itself. Everywhere else that a stored value is spent, the value was
 * typed into the same request that stores it: `storeAgentAuth` mints its own row from the key an
 * administrator pasted and hands back an id nobody chose. So this is the field where "which secret"
 * and "which address" can be made to disagree, and the add is what settles the disagreement, because
 * the refresh runs before it returns and sends what it decrypts to the URL from that same request.
 *
 * Two rules, and the second is the one that matters. Naming another server's token was accepted, so
 * a credential could be spent by a server it was never given to. And re-adding a server with a
 * different URL rewrote the address while keeping the credential, so the same token could be sent
 * somewhere else entirely without any cross-server trick at all. Closing only the first leaves the
 * second, which is why they are one question here rather than two.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const KEY = `${"x".repeat(43)}=`;
const tag = randomUUID().slice(0, 8);
const serverId = `binding-${tag}`;
const otherServerId = `binding-other-${tag}`;
const ownCredentialId = randomUUID();
const otherCredentialId = randomUUID();
const OWN_TOKEN = `sk-own-${tag}`;
const OTHER_TOKEN = `sk-other-${tag}`;
const LEGITIMATE_URL = "https://legit.vendor.example/mcp";
const CHOSEN_URL = "https://collector.attacker.example/mcp";

/**
 * The administrator who adds and removes these servers. The plugin routes run the store inside the
 * request's frame, `runAsTenant(actor.id)`, holding the admin capability (G01-E P10): the servers and
 * the tokens they are given are `team` rows, which only an administrator with the capability writes,
 * reads back and removes. So every step here is such a request, by a person `user_roles` names as an
 * administrator, rather than the unframed fallback.
 */
const ADMIN = `binding-admin-${tag}`;
const adminRequest = createAdminRequest(database);
function asAdmin<T>(work: () => Promise<T>) {
  return adminRequest(ADMIN, work);
}
let releaseAdmin: (() => Promise<void>) | undefined;

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    readSecret: async (id: string) => {
      const [row] = await database
        .select({
          encryptedValue: credentials.encryptedValue,
          revokedAt: credentials.revokedAt,
        })
        .from(credentials)
        .where(eq(credentials.id, id));
      return row ?? null;
    },
    create: async () => {
      throw new Error("this suite does not write credentials");
    },
    /**
     * A real revoke, unlike the other suites here, because the chain below turns on whether removing
     * a server actually retires its token. Stubbing this to throw would make the test prove nothing
     * about the case it exists for.
     */
    revoke: async (id: string) => {
      await database
        .update(credentials)
        .set({ revokedAt: new Date() })
        .where(eq(credentials.id, id));
    },
  } as never,
  encryptionKey: KEY,
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  /*
   * The vendors here are under the reserved `.example` name and never resolve, and a custom server's
   * requests go through the outbound guard, which asks where the name points before it sends. Without
   * an answer the guard stops at `unresolved` and nothing reaches the stubbed `fetch` below, so the
   * accepted case would see no send at all and the refused ones would pass for the wrong reason. A
   * public address for every name keeps the guard in the path and lets the binding rule decide.
   */
  outboundLookup: async () => [{ address: "93.184.216.34", family: 4 }],
});

/**
 * What left the deployment, so a refusal can be shown to have stopped the send rather than reported
 * on it afterwards. The vendors here do not exist, so a real request would fail anyway; what this
 * captures is whether one was attempted at all, and what it carried.
 */
let sent: { url: string; authorization: string | null }[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  releaseAdmin = await seedAdministrator(database, ADMIN);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(input as string, init);
    sent.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
    });
    return new Response("{}", { status: 500 });
  }) as typeof fetch;

  const encrypted = async (value: string) => encryptSecret(KEY, value);
  const ownValue = await encrypted(OWN_TOKEN);
  const otherValue = await encrypted(OTHER_TOKEN);
  await asAdmin(() =>
    database.insert(credentials).values([
      // A server's own token is sealed to `team`, beside its `team` server (G01-E P10, Q3).
      {
        id: ownCredentialId,
        tenantId: "team",
        kind: "mcp",
        // How `storeMcpToken` records whose token this is: the server it was minted for.
        provider: serverId,
        keyId: `mcp-${serverId}`,
        encryptedValue: ownValue,
        metadata: {},
      },
      {
        id: otherCredentialId,
        tenantId: "team",
        kind: "mcp",
        provider: otherServerId,
        keyId: `mcp-${otherServerId}`,
        encryptedValue: otherValue,
        metadata: {},
      },
    ]),
  );
});

afterEach(() => {
  sent = [];
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await asAdmin(() =>
    database.delete(mcpTools).where(like(mcpTools.serverId, `binding-%`)),
  );
  await asAdmin(() =>
    database.delete(mcpServers).where(like(mcpServers.id, `binding-%`)),
  );
  await asAdmin(() =>
    database
      .delete(credentials)
      .where(inArray(credentials.id, [ownCredentialId, otherCredentialId])),
  );
  await releaseAdmin?.();
});

async function storedUrl(id: string) {
  const [row] = await asAdmin(() =>
    database
      .select({ url: mcpServers.url })
      .from(mcpServers)
      .where(eq(mcpServers.id, id)),
  );
  return row?.url ?? null;
}

describe("a credential is spent only by the server it belongs to", () => {
  test("another server's token is refused", async () => {
    await expect(
      asAdmin(() =>
        store.addCustomServer({
          id: serverId,
          title: "Collector",
          url: CHOSEN_URL,
          credentialId: otherCredentialId,
          by: "admin@example.com",
        }),
      ),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);

    // The refusal is the whole point only if it happens before the send.
    expect(sent).toEqual([]);
    expect(await storedUrl(serverId)).toBeNull();
  });

  test("the server's own token is accepted", async () => {
    const added = await asAdmin(() =>
      store.addCustomServer({
        id: serverId,
        title: "Collector",
        url: LEGITIMATE_URL,
        credentialId: ownCredentialId,
        by: "admin@example.com",
      }),
    );

    expect(added.id).toBe(serverId);
    expect(await storedUrl(serverId)).toBe(LEGITIMATE_URL);
    // This is the case the field exists for, so the token does go out, to the address it was given.
    expect(sent[0]?.url).toContain("legit.vendor.example");
    expect(sent[0]?.authorization).toContain(OWN_TOKEN);
  });
});

describe("a credential is spent only at the address it was given", () => {
  test("re-adding the server at a different address is refused", async () => {
    // The case a check on whose credential it is cannot see: the token really does belong to this
    // server. What changed is where the server points, and the add would spend the credential
    // against the new address in the same call.
    await expect(
      asAdmin(() =>
        store.addCustomServer({
          id: serverId,
          title: "Collector",
          url: CHOSEN_URL,
          credentialId: ownCredentialId,
          by: "admin@example.com",
        }),
      ),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);

    expect(sent).toEqual([]);
    expect(await storedUrl(serverId)).toBe(LEGITIMATE_URL);
  });

  test("re-adding it at the address it already has still works", async () => {
    // Adding twice is not an attack and must stay ordinary: it is how a title is corrected and how
    // an interrupted add is retried.
    const added = await asAdmin(() =>
      store.addCustomServer({
        id: serverId,
        title: "Collector, renamed",
        url: LEGITIMATE_URL,
        credentialId: ownCredentialId,
        by: "admin@example.com",
      }),
    );

    expect(added.title).toBe("Collector, renamed");
    expect(await storedUrl(serverId)).toBe(LEGITIMATE_URL);
  });

  test("a server holding no credential can still be re-addressed", async () => {
    // Nothing to misdirect, so nothing to refuse. The rule is about spending a secret somewhere it
    // was not entrusted to, not about URLs being immutable.
    const openServerId = `binding-open-${tag}`;
    await asAdmin(() =>
      store.addCustomServer({
        id: openServerId,
        title: "Open",
        url: LEGITIMATE_URL,
        by: "admin@example.com",
      }),
    );

    const moved = await asAdmin(() =>
      store.addCustomServer({
        id: openServerId,
        title: "Open",
        url: CHOSEN_URL,
        by: "admin@example.com",
      }),
    );

    expect(moved.id).toBe(openServerId);
    expect(await storedUrl(openServerId)).toBe(CHOSEN_URL);
    expect(sent.every((call) => call.authorization === null)).toBe(true);
  });
});

/**
 * The way a token used to outlive the server it belonged to, and become spendable again.
 *
 * Three ordinary administrative acts in a row, none of them suspicious on its own. This is the shape
 * that makes "a credential belongs to its server" and "a server keeps its address" both true and
 * still not enough: the address rule only fires when a row is already here, so anything that gets
 * the row out of the way while the token stays live reopens the same door.
 */
describe("a token does not outlive the server it was given to", () => {
  const holderId = `binding-holder-${tag}`;
  const holderCredentialId = randomUUID();
  const HOLDER_TOKEN = `sk-holder-${tag}`;

  beforeAll(async () => {
    const encryptedValue = await encryptSecret(KEY, HOLDER_TOKEN);
    await asAdmin(() =>
      database.insert(credentials).values({
        id: holderCredentialId,
        tenantId: "team",
        kind: "mcp",
        provider: holderId,
        keyId: `mcp-${holderId}`,
        encryptedValue,
        metadata: {},
      }),
    );
  });

  afterAll(async () => {
    // The server row first: it holds a foreign key onto the credential, so the other order is
    // refused by the database rather than by anything this suite is testing.
    await asAdmin(() =>
      database.delete(mcpTools).where(eq(mcpTools.serverId, holderId)),
    );
    await asAdmin(() =>
      database.delete(mcpServers).where(eq(mcpServers.id, holderId)),
    );
    await asAdmin(() =>
      database
        .delete(credentials)
        .where(eq(credentials.id, holderCredentialId)),
    );
  });

  test("re-adding without a token keeps the one the server already holds", async () => {
    // Clearing it was the first link: the row stops naming the credential, so nothing later knows
    // the credential belongs to anything, and nothing retires it.
    await asAdmin(() =>
      store.addCustomServer({
        id: holderId,
        title: "Holder",
        url: LEGITIMATE_URL,
        credentialId: holderCredentialId,
        by: "admin@example.com",
      }),
    );

    await asAdmin(() =>
      store.addCustomServer({
        id: holderId,
        title: "Holder, renamed",
        url: LEGITIMATE_URL,
        by: "admin@example.com",
      }),
    );

    const [row] = await asAdmin(() =>
      database
        .select({ credentialId: mcpServers.credentialId })
        .from(mcpServers)
        .where(eq(mcpServers.id, holderId)),
    );
    expect(row?.credentialId).toBe(holderCredentialId);
  });

  test("removing the server retires its token", async () => {
    await asAdmin(() => store.removeServer(holderId, "admin@example.com"));

    const [row] = await asAdmin(() =>
      database
        .select({ revokedAt: credentials.revokedAt })
        .from(credentials)
        .where(eq(credentials.id, holderCredentialId)),
    );
    expect(row?.revokedAt).not.toBeNull();
  });

  test("a retired token cannot be attached to a server again", async () => {
    // The end of the chain. Even with the row gone, so the address rule has nothing to compare
    // against, the credential itself is no longer spendable.
    sent = [];

    await expect(
      asAdmin(() =>
        store.addCustomServer({
          id: holderId,
          title: "Holder",
          url: CHOSEN_URL,
          credentialId: holderCredentialId,
          by: "admin@example.com",
        }),
      ),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);

    expect(sent).toEqual([]);
  });
});

/**
 * Replacing the token of a server that is already added, against a real vault (G01-E P22).
 *
 * The plugins screen used to do it in two requests: `POST /api/admin/credentials` for the new token,
 * then a re-add pointing the server at it. A key holds one live credential, so the first request
 * ROTATES — the token the server was using is revoked the moment the new one is stored — and the
 * server goes on naming that revoked row until the second request lands. When the second one failed,
 * the server was left configured on every screen and unable to make a call, with the token that
 * worked gone. `replaceServerToken` stores and re-points in one transaction, so a failure anywhere
 * in it leaves the vault and the server exactly as they were.
 *
 * No vendor is reached: `fetch` is a recorder that answers 500, so the refresh after a replacement
 * shows which token went out and to where, and nothing more.
 */

const SWAP_SERVER = `binding-swap-${tag}`;
const SWAP_BROKERED = `binding-swap-brokered-${tag}`;
const SWAP_URL = "https://swap.vendor.example/mcp";
const OLD_TOKEN = `sk-old-${tag}`;
const NEW_TOKEN = `sk-new-${tag}`;
const policy = () => ({ mode: "enforce" as const, deny: [], allow: ["true"] });

const vault = createCredentialStore(database);
const auditStore = createAuditStore(database);
/** A store over the real vault: the swap is a rotation, which a stub cannot show to be atomic. */
const swapStore = createPluginStore({
  database,
  auditStore,
  credentials: vault,
  encryptionKey: KEY,
  policy,
  // The refresh after a replacement dials `swap.vendor.example`, a reserved name that never resolves:
  // the same public-address answer as the store above, so the outbound guard stays in the path and
  // the stubbed `fetch` records what it sent (without it the guard stops at `unresolved` wherever no
  // egress proxy is configured, as in CI, and nothing is sent at all).
  outboundLookup: async () => [{ address: "93.184.216.34", family: 4 }],
});
/** The credentials screen's own service, for the token the server starts with. */
const admin = createCredentialAdminService(KEY, vault, auditStore);

async function serverRow() {
  const [row] = await asAdmin(() =>
    database
      .select({ url: mcpServers.url, credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, SWAP_SERVER)),
  );
  return row;
}

async function credentialRow(id: string | null | undefined) {
  if (!id) return undefined;
  const [row] = await asAdmin(() =>
    database
      .select({
        tenantId: credentials.tenantId,
        kind: credentials.kind,
        provider: credentials.provider,
        keyId: credentials.keyId,
        revokedAt: credentials.revokedAt,
      })
      .from(credentials)
      .where(eq(credentials.id, id)),
  );
  return row;
}

/** The server as the credentials screen and the add path leave it: at its URL, on a live token. */
async function addWithToken(token: string) {
  const stored = await asAdmin(() =>
    admin.create({
      kind: "mcp",
      provider: SWAP_SERVER,
      keyId: `mcp-${SWAP_SERVER}`,
      metadata: { server: SWAP_SERVER },
      plaintext: token,
    }),
  );
  await asAdmin(() =>
    swapStore.addCustomServer({
      id: SWAP_SERVER,
      title: "Swap",
      url: SWAP_URL,
      credentialId: stored.id,
      by: "admin@example.com",
    }),
  );
  return stored.id;
}

afterAll(async () => {
  await runAsTenant("platform", () =>
    database
      .delete(credentials)
      .where(like(credentials.provider, `binding-swap-%${tag}`)),
  );
});

describe("replacing an added server's token", () => {
  test("a replacement that fails part-way leaves the server on its old token, still live", async () => {
    const oldId = await addWithToken(OLD_TOKEN);

    // The vault swap succeeds and then something after it fails, inside the same request: the
    // position the second of the screen's two requests used to be in.
    const interrupted = createPluginStore({
      database,
      auditStore,
      credentials: {
        ...vault,
        rotate: async (...args: Parameters<typeof vault.rotate>) => {
          await vault.rotate(...args);
          throw new Error("interrupted after the vault swap");
        },
      },
      encryptionKey: KEY,
      policy,
    });
    await expect(
      asAdmin(() =>
        interrupted.replaceServerToken({
          serverId: SWAP_SERVER,
          token: NEW_TOKEN,
          by: "admin@example.com",
        }),
      ),
    ).rejects.toThrow("interrupted after the vault swap");

    const row = await serverRow();
    expect(row?.credentialId).toBe(oldId);
    expect((await credentialRow(oldId))?.revokedAt).toBeNull();
    // And no second token was left behind for the key.
    const live = await asAdmin(() =>
      database
        .select({ id: credentials.id })
        .from(credentials)
        .where(
          and(
            eq(credentials.keyId, `mcp-${SWAP_SERVER}`),
            isNull(credentials.revokedAt),
          ),
        ),
    );
    expect(live.map((credential) => credential.id)).toEqual([oldId]);
  });

  test("a replacement points the server at the new token, retires the old one, and moves nothing else", async () => {
    const before = await serverRow();
    const oldId = before?.credentialId;
    expect(oldId).toBeTruthy();
    sent = [];

    const replaced = await asAdmin(() =>
      swapStore.replaceServerToken({
        serverId: SWAP_SERVER,
        token: NEW_TOKEN,
        by: "admin@example.com",
      }),
    );

    expect(replaced.id).toBe(SWAP_SERVER);
    const row = await serverRow();
    expect(row?.url).toBe(SWAP_URL);
    expect(row?.credentialId).not.toBe(oldId);
    expect(await credentialRow(row?.credentialId)).toEqual({
      // Beside its `team` server, under the key the plugins screen mints.
      tenantId: "team",
      kind: "mcp",
      provider: SWAP_SERVER,
      keyId: `mcp-${SWAP_SERVER}`,
      revokedAt: null,
    });
    expect((await credentialRow(oldId))?.revokedAt).not.toBeNull();
    // The refresh after it spent the new token, at the server's own address.
    expect(sent[0]?.url).toContain("swap.vendor.example");
    expect(sent[0]?.authorization).toContain(NEW_TOKEN);
  });

  test("a brokered app takes no token, and nothing is stored for it", async () => {
    await runAsTenant("platform", () =>
      database.insert(mcpServers).values({
        id: SWAP_BROKERED,
        tenantId: "team",
        title: "Brokered",
        vendor: "composio",
        url: `composio://bindingswap${tag}`,
        provenance: "composio",
        authScheme: "OAUTH2",
      }),
    );

    await expect(
      asAdmin(() =>
        swapStore.replaceServerToken({
          serverId: SWAP_BROKERED,
          token: NEW_TOKEN,
          by: "admin@example.com",
        }),
      ),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);

    const stored = await asAdmin(() =>
      database
        .select({ id: credentials.id })
        .from(credentials)
        .where(eq(credentials.provider, SWAP_BROKERED)),
    );
    expect(stored).toEqual([]);
  });
});
