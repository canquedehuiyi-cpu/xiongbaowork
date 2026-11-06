import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAuth } from "../src/auth";
import type { AppVariables } from "../src/auth/guards";
import {
  createChannelRoutes,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import type { DeploymentConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  sessions,
  subscriptions,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { avatarAgentId, provisionTenant } from "../src/tenant/provisioning";
import {
  loadTenantPackage,
  synchronizeTenantPackage,
} from "../src/tenant-package";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * A deployment WITH sign-in gives every person a conversation with their own 分身.
 *
 * Found on a real deployment (2026-11-06: `OPENBOT_SINGLE_USER=false`, email and password sign-up,
 * `TENANT_PACKAGE_DIR=../examples/qoderwake`, `TENANT_RUNTIME=device`). A brand package's
 * conversations are written per person only in single-user mode, so nothing gave a signed-up person a
 * conversation with their 分身. Their first one came from the home composer's default, the first
 * shared coworker -- the catalogue `general-assistant`, then also called 我的分身, which belongs to
 * nobody and so could never use their paired machine.
 *
 * This runs the real sign-up (Better Auth's handler and its `user.create` hooks), the real package
 * sync as that deployment runs it (no members), and the real channel list route over the real store.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
let releaseRoleWriter: (() => Promise<void>) | undefined;
beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
});

const suite = randomUUID().slice(0, 8);
const PASSWORD = "a-passphrase-long-enough";
const people: string[] = [];

const auth = createAuth(
  {
    auth: {
      baseUrl: "http://127.0.0.1:3000",
      secret: "x".repeat(40),
      trustedOrigins: [],
      initialAdminEmails: [],
      allowedEmailDomains: [],
    },
    keyEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  } as unknown as DeploymentConfig,
  database,
  async () => false,
);

/** Sign up through Better Auth's own endpoint, run as `app.ts` runs it: as the identity layer. */
async function signUp(label: string): Promise<string> {
  const response = await runAsTenant("platform", () =>
    auth.handler(
      new Request("http://127.0.0.1:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:3000",
        },
        body: JSON.stringify({
          name: `${label} ${suite}`,
          email: `${label}-${suite}@acme.test`,
          password: PASSWORD,
        }),
      }),
    ),
  );
  const body = (await response.json()) as { user?: { id?: string } };
  expect(response.status, JSON.stringify(body)).toBe(200);
  const id = body.user?.id ?? "";
  people.push(id);
  return id;
}

const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const storeFor = () =>
  createChannelStore(
    database,
    profileStore,
    createThreadIdentity("test-deployment"),
  );
let store = storeFor();

const actorOf = (id: string) => ({ id, role: "user" as const });

/** `GET /api/channels` as the signed-in person: `requireUser` runs the request in their own frame. */
async function listAs(id: string) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actorOf(id));
    await runAsTenant(id, next);
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createChannelRoutes(store, requireUser));
  const response = await app.request("/");
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      channels: { id: string; name: string; agentIds: string[] }[];
    }
  ).channels;
}

const withAvatarOnly = (
  rows: { agentIds: string[] }[],
  id: string,
): unknown[] =>
  rows.filter(
    (row) => row.agentIds.length === 1 && row.agentIds[0] === avatarAgentId(id),
  );

// The deployment's start-up: the package applied for nobody, as it is wherever people sign in.
const loaded = await loadTenantPackage("../examples/qoderwake");
await runAsTenant("platform", () =>
  synchronizeTenantPackage(database, loaded, []),
);

afterAll(async () => {
  for (const id of people) {
    await runAsTenant(id, async () => {
      await database
        .delete(channelMemberships)
        .where(eq(channelMemberships.userId, id));
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.userId, id));
      await database.delete(channels).where(eq(channels.tenantId, id));
      await database
        .delete(agentProfiles)
        .where(eq(agentProfiles.tenantId, id));
      await database.delete(agents).where(eq(agents.tenantId, id));
      await database
        .delete(subscriptions)
        .where(eq(subscriptions.tenantId, id));
    });
    await runAsTenant("platform", async () => {
      await database.delete(accounts).where(eq(accounts.userId, id));
      await database.delete(sessions).where(eq(sessions.userId, id));
      await database.delete(users).where(eq(users.id, id));
    });
  }
  await releaseRoleWriter?.();
  await database.$client.close();
});

describe("a person who signs up", () => {
  let newcomer = "";

  test("finds a conversation with their own 分身 the first time they open the app", async () => {
    newcomer = await signUp("newcomer");

    const listed = await listAs(newcomer);
    const mine = withAvatarOnly(listed, newcomer);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      name: "我的分身",
      agentIds: [avatarAgentId(newcomer)],
    });
    // Not the catalogue Bot: the conversation that used to be "theirs" belonged to nobody.
    expect(
      listed.some((row) => row.agentIds.includes("general-assistant")),
    ).toBe(false);
  });

  test("opening the app again, or after a restart, does not make a second one", async () => {
    await listAs(newcomer);
    store = storeFor();
    const listed = await listAs(newcomer);
    expect(withAvatarOnly(listed, newcomer)).toHaveLength(1);
  });

  test("one they deleted stays deleted, even after a restart", async () => {
    const [mine] = withAvatarOnly(await listAs(newcomer), newcomer) as {
      id: string;
    }[];
    await runAsTenant(newcomer, () =>
      store.softDelete(actorOf(newcomer), mine?.id as string),
    );
    store = storeFor();
    expect(withAvatarOnly(await listAs(newcomer), newcomer)).toHaveLength(0);
  });
});

describe("a person who signed up before this existed", () => {
  test("gets their 分身 conversation on their next visit, and the old one stops claiming its name", async () => {
    const existing = `avatar-conv-old-${suite}`;
    await runAsTenant(existing, () =>
      database.insert(users).values({
        id: existing,
        email: `${existing}@acme.test`,
        name: existing,
      }),
    );
    people.push(existing);
    await provisionTenant(database, {
      id: existing,
      email: `${existing}@acme.test`,
    });

    /*
     * What the real deployment held: a 1:1 conversation with the catalogue Bot and a group with it,
     * both named while that Bot was still called 我的分身. A name is a snapshot, so the rename alone
     * left both saying 我的分身.
     */
    const [solo, group] = await runAsTenant(existing, async () => [
      await store.create(actorOf(existing), ["general-assistant"]),
      await store.create(actorOf(existing), [
        "backend-engineer",
        "general-assistant",
      ]),
    ]);
    await runAsTenant(existing, async () => {
      await database
        .update(channels)
        .set({ name: "我的分身" })
        .where(eq(channels.id, solo?.id as string));
      await database
        .update(channels)
        .set({ name: "我的分身, 后端工程师" })
        .where(eq(channels.id, group?.id as string));
    });
    store = storeFor();

    const listed = await listAs(existing);
    const mine = withAvatarOnly(listed, existing);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: "我的分身" });

    // The old conversations keep their Bots and their threads, and take their Bots' current names.
    const byId = new Map(listed.map((row) => [row.id, row]));
    expect(byId.get(solo?.id as string)).toMatchObject({
      name: "通用助手",
      agentIds: ["general-assistant"],
    });
    expect(byId.get(group?.id as string)?.name).toBe("后端工程师, 通用助手");
    // Exactly one conversation is called 我的分身 now, and it is the person's own 分身.
    expect(listed.filter((row) => row.name === "我的分身")).toEqual(
      mine as never,
    );
  });
});
