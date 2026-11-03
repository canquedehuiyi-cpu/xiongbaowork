import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  pluginGrants,
  skills,
  users,
} from "../src/db/schema";
import { pluginInstallListings } from "../src/db/schema/plugin-install-listings";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec E3 / D11 (D08-4): an administrator lists (上架) a catalogue entry, and the owner of a Waker
 * installs it on that Waker and uninstalls it again themselves, with no administrator approving each
 * one. Every install and uninstall writes a trail row that says it was self-service.
 *
 * Driven through the real routes and the real store, inside a real tenant frame, against the
 * application role: the listing table is written only by the platform frame and read by everybody,
 * and that is a property of the database, so it is asserted against the database.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    readSecret: async () => null,
    create: async () => {
      throw new Error("this suite does not write credentials");
    },
    revoke: async () => {
      throw new Error("this suite does not revoke credentials");
    },
  },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

const suite = randomUUID().slice(0, 8);
const tenant = `w-selfinstall-${suite}`;
const otherTenant = `w-selfinstall-other-${suite}`;
const alice = `user_si_alice_${suite}`;
const bob = `user_si_bob_${suite}`;
const adminUser = `user_si_admin_${suite}`;
const aliceEmail = `si-alice-${suite}@example.test`;
const bobEmail = `si-bob-${suite}@example.test`;
const adminEmail = `si-admin-${suite}@example.test`;
const aliceBot = `agent_si_alice_${suite}`;
const aliceSecondBot = `agent_si_alice2_${suite}`;
const bobBot = `agent_si_bob_${suite}`;
const sharedBot = `agent_si_shared_${suite}`;
const bots = [aliceBot, aliceSecondBot, bobBot, sharedBot];
const deploymentSkill = `si-deployment-${suite}`;
const aliceSkill = `si-alice-${suite}`;
/**
 * An app this suite adds itself, under a name nobody else uses: the listing names the app, a grant
 * names one of its tools. Not a real catalogue key, because a listing is deployment-wide: listing
 * `google-drive` here would open self-install of Drive to every other suite sharing this database,
 * and a run that died before its teardown would leave it open.
 */
const appKey = `si-app-${suite}`;
const toolName = "search_files";
const toolRef = `${appKey}/${toolName}`;

function routesAs(actor: {
  id: string;
  email: string;
  role: "admin" | "user";
}) {
  return createPluginRoutes(
    store,
    async (context, next) => {
      context.set("actor", actor as never);
      await next();
    },
    async () => true,
  );
}

const asAlice = () => routesAs({ id: alice, email: aliceEmail, role: "user" });
const asBob = () => routesAs({ id: bob, email: bobEmail, role: "user" });
const asAdmin = () =>
  routesAs({ id: adminUser, email: adminEmail, role: "admin" });

/** One request, inside the tenant frame the product would have put it in. */
function send(
  app: ReturnType<typeof routesAs>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return runAsTenant(tenant, async () => await app.request(path, init));
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const grant = (kind: "mcp" | "skill", ref: string, agentId: string) =>
  post({ kind, ref, agentId });

const revoke = (kind: "mcp" | "skill", ref: string, agentId: string) =>
  `/grants?kind=${kind}&ref=${encodeURIComponent(ref)}&agentId=${encodeURIComponent(agentId)}`;

const held = async (agentId: string) =>
  await runAsTenant(tenant, async () => await store.listForAgent(agentId));

/** The grant row itself, read in the owning tenant. */
const grantRow = async (kind: string, ref: string, agentId: string) => {
  const [row] = await runAsTenant(tenant, async () =>
    database
      .select({ grantedBy: pluginGrants.grantedBy })
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, kind),
          eq(pluginGrants.ref, ref),
          eq(pluginGrants.agentId, agentId),
        ),
      ),
  );
  return row;
};

/** The trail rows with this change about this ref, in this suite's tenant. */
const trail = async (change: string, ref: string) => {
  const rows = await runAsTenant(tenant, async () =>
    database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, ref)),
  );
  return rows
    .map((row) => row.payload as Record<string, unknown>)
    .filter((payload) => payload.change === change);
};

const listingRows = async (scope: string) =>
  await runAsTenant(scope, async () =>
    database
      .select({
        tenantId: pluginInstallListings.tenantId,
        kind: pluginInstallListings.kind,
        ref: pluginInstallListings.ref,
      })
      .from(pluginInstallListings)
      .where(inArray(pluginInstallListings.ref, [appKey, deploymentSkill])),
  );

beforeAll(async () => {
  for (const [id, email] of [
    [alice, aliceEmail],
    [bob, bobEmail],
    [adminUser, adminEmail],
  ] as const) {
    await database
      .insert(users)
      .values({ id, email, name: id })
      .onConflictDoNothing();
  }

  /*
   * Written as rows rather than through `addServer`, which refreshes the app's tool list from the
   * vendor before it answers: nothing here may reach a vendor, so the tool a Waker is offered is
   * seeded beside the server. `listForAgent` offers only a tool the server advertises. Stamped as an
   * administrator's add stamps them: the team's (G01-E P10; a person's frame can no longer write
   * either, 0127), which is a deployment write, so as `platform`.
   */
  await runAsTenant("platform", async () => {
    await database
      .insert(mcpServers)
      .values({
        tenantId: "team",
        id: appKey,
        title: appKey,
        vendor: "test",
        url: "https://example.invalid/mcp",
        provenance: "custom",
        addedBy: adminEmail,
      })
      .onConflictDoNothing();
    await database
      .insert(mcpTools)
      .values({
        tenantId: "team",
        serverId: appKey,
        name: toolName,
        description: "Search.",
      })
      .onConflictDoNothing();
  });

  await runAsTenant(tenant, async () => {
    for (const [id, owner] of [
      [aliceBot, alice],
      [aliceSecondBot, alice],
      [bobBot, bob],
      // Unowned: a Waker the workspace shares. Nobody installs onto it by themselves.
      [sharedBot, null],
    ] as const) {
      await database
        .insert(agents)
        .values({ id, name: id, type: "built_in", configuration: {} })
        .onConflictDoNothing();
      await database
        .insert(agentProfiles)
        .values({
          agentId: id,
          ownerUserId: owner,
          title: id,
          roleDescription: "For a test.",
          avatarSeed: id,
          visibility: "private",
        })
        .onConflictDoNothing();
    }

    await store.installSkill({
      slug: deploymentSkill,
      title: deploymentSkill,
      summary: "",
      instructions: "Do the thing.",
      ownerUserId: null,
      by: adminEmail,
    });
    await store.installSkill({
      slug: aliceSkill,
      title: aliceSkill,
      summary: "",
      instructions: "Do my thing.",
      ownerUserId: alice,
      by: aliceEmail,
    });
  });
});

afterAll(async () => {
  // Listings are the platform's rows: only the platform frame may remove them.
  await runAsTenant("platform", async () => {
    await database
      .delete(pluginInstallListings)
      .where(
        and(
          eq(pluginInstallListings.tenantId, "system"),
          inArray(pluginInstallListings.ref, [appKey, deploymentSkill]),
        ),
      );
    // The team's server and tool, which only the platform (or a capable administrator) removes.
    await database.delete(mcpTools).where(eq(mcpTools.serverId, appKey));
    await database.delete(mcpServers).where(eq(mcpServers.id, appKey));
  });
  await runAsTenant(tenant, async () => {
    await database
      .delete(pluginGrants)
      .where(inArray(pluginGrants.agentId, bots));
    await database
      .delete(skills)
      .where(inArray(skills.slug, [deploymentSkill, aliceSkill]));
    await database.delete(agents).where(inArray(agents.id, bots));
  });
  await database
    .delete(users)
    .where(inArray(users.id, [alice, bob, adminUser]));
});

describe("before anything is listed", () => {
  test("an owner cannot install an app's tool or a deployment skill on their own Waker", async () => {
    const app = await send(
      asAlice(),
      "/grants",
      grant("mcp", toolRef, aliceBot),
    );
    expect(app.status).toBe(403);
    expect((await app.json()).error).toBe(
      "An administrator decides which Bots may reach a tool.",
    );

    const skill = await send(
      asAlice(),
      "/grants",
      grant("skill", deploymentSkill, aliceBot),
    );
    expect(skill.status).toBe(403);

    const now = await held(aliceBot);
    expect(now.tools).toEqual([]);
    expect(now.skills).toEqual([]);
  });
});

describe("listing (上架) is an administrator's", () => {
  test("somebody who is not an administrator cannot list or unlist", async () => {
    const listed = await send(
      asAlice(),
      "/listings",
      post({ kind: "mcp", ref: appKey }),
    );
    expect(listed.status).toBe(403);
    const unlisted = await send(asAlice(), `/listings?kind=mcp&ref=${appKey}`, {
      method: "DELETE",
    });
    expect(unlisted.status).toBe(403);
    expect(await listingRows("platform")).toEqual([]);
  });

  test("a listing names an app or a deployment skill, and nothing else", async () => {
    for (const body of [
      { kind: "mcp", ref: toolRef },
      { kind: "mcp", ref: `no-such-app-${suite}` },
      { kind: "skill", ref: aliceSkill },
      { kind: "skill", ref: `no-such-skill-${suite}` },
      { kind: "bot", ref: aliceBot },
      { kind: "mcp", ref: "   " },
    ]) {
      const response = await send(asAdmin(), "/listings", post(body));
      expect(response.status).toBe(400);
    }
    expect(await listingRows("platform")).toEqual([]);
  });

  test("an administrator lists an app and a deployment skill, stamped as the platform's", async () => {
    for (const body of [
      { kind: "mcp", ref: appKey },
      { kind: "skill", ref: deploymentSkill },
      // Twice: one row and one trail entry, not two.
      { kind: "mcp", ref: appKey },
    ]) {
      const response = await send(asAdmin(), "/listings", post(body));
      expect(response.status).toBe(200);
    }

    const rows = await listingRows("platform");
    expect(rows.sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { tenantId: "system", kind: "mcp", ref: appKey },
      { tenantId: "system", kind: "skill", ref: deploymentSkill },
    ]);
    // Every workspace reads the catalogue, including one that had nothing to do with it.
    expect(await listingRows(otherTenant)).toHaveLength(2);

    expect(await trail("plugin_listed", appKey)).toEqual([
      { actor: adminEmail, change: "plugin_listed", kind: "mcp", ref: appKey },
    ]);
    expect(await trail("plugin_listed", deploymentSkill)).toHaveLength(1);

    // The 装配页 reads the same thing as any signed-in person.
    const read = await send(asAlice(), "/listings");
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      listings: { kind: string; ref: string; listedBy?: string }[];
    };
    expect(body.listings.map((row) => `${row.kind}:${row.ref}`)).toEqual(
      expect.arrayContaining([`mcp:${appKey}`, `skill:${deploymentSkill}`]),
    );
    // Every workspace reads the listing; none of them is told which operator made it.
    expect(body.listings.every((row) => row.listedBy === undefined)).toBe(true);
    const asOperator = (await (await send(asAdmin(), "/listings")).json()) as {
      listings: { ref: string; listedBy?: string }[];
    };
    expect(
      asOperator.listings.find((row) => row.ref === appKey)?.listedBy,
    ).toBe(adminEmail);
  });
});

describe("an owner installs and uninstalls a listed entry on their own Waker", () => {
  test("installs a listed app's tool, and the Waker is offered it", async () => {
    const response = await send(
      asAlice(),
      "/grants",
      grant("mcp", toolRef, aliceBot),
    );
    expect(response.status).toBe(200);

    expect((await held(aliceBot)).tools.map((tool) => tool.ref)).toContain(
      toolRef,
    );
    expect((await grantRow("mcp", toolRef, aliceBot))?.grantedBy).toBe(
      aliceEmail,
    );
    expect(await trail("plugin_granted", toolRef)).toContainEqual({
      actor: aliceEmail,
      change: "plugin_granted",
      kind: "mcp",
      ref: toolRef,
      bot: aliceBot,
      selfService: true,
    });
  });

  test("installs a listed deployment skill", async () => {
    const response = await send(
      asAlice(),
      "/grants",
      grant("skill", deploymentSkill, aliceBot),
    );
    expect(response.status).toBe(200);
    expect((await held(aliceBot)).skills.map((skill) => skill.slug)).toContain(
      deploymentSkill,
    );
    expect(await trail("plugin_granted", deploymentSkill)).toContainEqual({
      actor: aliceEmail,
      change: "plugin_granted",
      kind: "skill",
      ref: deploymentSkill,
      bot: aliceBot,
      selfService: true,
    });
  });

  test("cannot install it on somebody else's Waker or on one the workspace shares", async () => {
    for (const agentId of [bobBot, sharedBot, `agent_nobody_${suite}`]) {
      const response = await send(
        asAlice(),
        "/grants",
        grant("mcp", toolRef, agentId),
      );
      expect(response.status).toBe(403);
      // One sentence for all three, so the refusal says nothing about other people's Wakers.
      expect((await response.json()).error).toBe(
        "You can only install listed entries on Bots you own.",
      );
    }
    expect((await held(bobBot)).tools).toEqual([]);
    expect((await held(sharedBot)).tools).toEqual([]);

    const skill = await send(
      asAlice(),
      "/grants",
      grant("skill", deploymentSkill, bobBot),
    );
    expect(skill.status).toBe(403);
    expect((await held(bobBot)).skills).toEqual([]);
  });

  test("a listing is not a licence for another app, or for an app's name without a tool", async () => {
    const other = await send(
      asAlice(),
      "/grants",
      grant("mcp", "slack/slack_search_public", aliceBot),
    );
    expect(other.status).toBe(403);
    const bare = await send(
      asAlice(),
      "/grants",
      grant("mcp", appKey, aliceBot),
    );
    expect(bare.status).toBe(403);
    expect(await grantRow("mcp", appKey, aliceBot)).toBeUndefined();
  });

  test("uninstalls it again, and the trail says it was self-service", async () => {
    const response = await send(asAlice(), revoke("mcp", toolRef, aliceBot), {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect((await held(aliceBot)).tools).toEqual([]);
    expect(await trail("plugin_revoked", toolRef)).toContainEqual({
      actor: aliceEmail,
      change: "plugin_revoked",
      kind: "mcp",
      ref: toolRef,
      bot: aliceBot,
      selfService: true,
    });

    // Installed again, for the unlisting below to leave standing.
    const again = await send(
      asAlice(),
      "/grants",
      grant("mcp", toolRef, aliceBot),
    );
    expect(again.status).toBe(200);
  });

  test("somebody else cannot uninstall it from her Waker", async () => {
    const response = await send(asBob(), revoke("mcp", toolRef, aliceBot), {
      method: "DELETE",
    });
    expect(response.status).toBe(403);
    expect((await held(aliceBot)).tools.map((tool) => tool.ref)).toContain(
      toolRef,
    );
  });

  test("an administrator's own grant still says it was not self-service", async () => {
    const response = await send(
      asAdmin(),
      "/grants",
      grant("mcp", toolRef, bobBot),
    );
    expect(response.status).toBe(200);
    expect(await trail("plugin_granted", toolRef)).toContainEqual({
      actor: adminEmail,
      change: "plugin_granted",
      kind: "mcp",
      ref: toolRef,
      bot: bobBot,
      selfService: false,
    });
  });
});

describe("after an entry is unlisted (下架)", () => {
  test("an administrator unlists it, with a trail row, and nothing installed is taken away", async () => {
    const response = await send(asAdmin(), `/listings?kind=mcp&ref=${appKey}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect((await listingRows("platform")).map((row) => row.kind)).toEqual([
      "skill",
    ]);
    expect(await trail("plugin_unlisted", appKey)).toEqual([
      {
        actor: adminEmail,
        change: "plugin_unlisted",
        kind: "mcp",
        ref: appKey,
      },
    ]);

    // Unlisting what is not listed says so rather than writing a second trail row.
    const twice = await send(asAdmin(), `/listings?kind=mcp&ref=${appKey}`, {
      method: "DELETE",
    });
    expect(twice.status).toBe(404);
    expect(await trail("plugin_unlisted", appKey)).toHaveLength(1);

    expect((await held(aliceBot)).tools.map((tool) => tool.ref)).toContain(
      toolRef,
    );
  });

  test("an owner can no longer install it", async () => {
    const response = await send(
      asAlice(),
      "/grants",
      grant("mcp", toolRef, aliceSecondBot),
    );
    expect(response.status).toBe(403);
    expect(await grantRow("mcp", toolRef, aliceSecondBot)).toBeUndefined();
  });

  test("an owner can still uninstall what they installed themselves", async () => {
    const response = await send(asAlice(), revoke("mcp", toolRef, aliceBot), {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(await grantRow("mcp", toolRef, aliceBot)).toBeUndefined();
  });

  test("an owner cannot remove what an administrator granted on an unlisted entry", async () => {
    // Bob owns this Waker; the grant on it is the administrator's, made above.
    const response = await send(asBob(), revoke("mcp", toolRef, bobBot), {
      method: "DELETE",
    });
    expect(response.status).toBe(403);
    expect((await grantRow("mcp", toolRef, bobBot))?.grantedBy).toBe(
      adminEmail,
    );
  });
});

describe("only the platform frame writes the listing table", () => {
  const probe = `si-probe-${suite}`;

  test("a tenant cannot create, rewrite or delete a listing", async () => {
    await expect(
      runAsTenant(tenant, async () => {
        await database.insert(pluginInstallListings).values({
          tenantId: "system",
          kind: "skill",
          ref: probe,
          listedBy: aliceEmail,
        });
      }),
    ).rejects.toThrow();

    // Refused, which for UPDATE and DELETE means untouched rather than an error.
    await runAsTenant(tenant, async () => {
      await database
        .update(pluginInstallListings)
        .set({ listedBy: aliceEmail })
        .where(eq(pluginInstallListings.ref, deploymentSkill));
      await database
        .delete(pluginInstallListings)
        .where(eq(pluginInstallListings.ref, deploymentSkill));
    });
    const [row] = await runAsTenant("platform", async () =>
      database
        .select({ listedBy: pluginInstallListings.listedBy })
        .from(pluginInstallListings)
        .where(eq(pluginInstallListings.ref, deploymentSkill)),
    );
    expect(row?.listedBy).toBe(adminEmail);
  });

  test("an unscoped connection, which runs as system, cannot write one either", async () => {
    await expect(
      runAsTenant("system", async () => {
        await database.insert(pluginInstallListings).values({
          tenantId: "system",
          kind: "skill",
          ref: probe,
          listedBy: "boot",
        });
      }),
    ).rejects.toThrow();
  });

  test("even the platform frame cannot stamp a listing with a tenant", async () => {
    await expect(
      runAsTenant("platform", async () => {
        await database.insert(pluginInstallListings).values({
          tenantId: tenant,
          kind: "skill",
          ref: probe,
          listedBy: adminEmail,
        });
      }),
    ).rejects.toThrow();
    expect(
      await runAsTenant("platform", async () =>
        database
          .select({ ref: pluginInstallListings.ref })
          .from(pluginInstallListings)
          .where(eq(pluginInstallListings.ref, probe)),
      ),
    ).toEqual([]);
  });
});
