import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  composioConnections,
  mcpServers,
  mcpTools,
  pluginGrants,
  teamBotPublications,
  users,
} from "../src/db/schema";
import { grantedByOwner } from "../src/plugins/owner-grants";
import { createPluginStore } from "../src/plugins/store";
import { createTeamBots } from "../src/team-bots/team-bots";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 升级前写下的主人授予（D08 自助安装、分身来源）：`granted_as` 为 NULL、授予人就是员工的主人。0197 把
 * 它们回填为 `owner`（主人不是管理员时）；运行时再兜一次底：NULL 且授予人是员工主人的，一律按主人的授予
 * 处理，Team Bot 队友拿不到主人的个人账号。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `ogl-${suite}-${name}`;
const OWNER = id("owner");
const ADMIN_OWNER = id("admin-owner");
const TEAMMATE = id("teammate");
const ADMIN = id("admin");
const people = [OWNER, ADMIN_OWNER, TEAMMATE, ADMIN];
const email = (person: string) => `${person}@X.test`;
const TEAM_BOT = id("team-bot");
const ADMINS_BOT = id("admins-bot");
const bots = [TEAM_BOT, ADMINS_BOT];
const MAIL = `ogl_mail_${suite.replace(/-/g, "_")}`;
const REF = `${MAIL}/LIST`;
const OTHER_REF = `${MAIL}/READ`;
let releaseRoleWriter: (() => Promise<void>) | undefined;

const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null } as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

const grantedAs = async (botId: string, ref: string) =>
  (
    await asPlatform(() =>
      database
        .select({ grantedAs: pluginGrants.grantedAs })
        .from(pluginGrants)
        .where(
          sql`${pluginGrants.agentId} = ${botId} and ${pluginGrants.ref} = ${ref}`,
        ),
    )
  )[0]?.grantedAs;

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    await database
      .insert(users)
      .values(people.map((person) => ({ id: person, email: email(person) })));
    await setRole(database, ADMIN, "admin");
    await setRole(database, ADMIN_OWNER, "admin");
    await database.insert(mcpServers).values({
      id: MAIL,
      tenantId: "team",
      title: "Mail",
      vendor: "Composio",
      url: `composio://${MAIL}`,
      provenance: "composio",
      authScheme: "OAUTH2",
    });
    for (const name of ["LIST", "READ"])
      await database.insert(mcpTools).values({
        serverId: MAIL,
        tenantId: "team",
        name,
        description: name,
        effect: "read",
        version: "20260903_00",
      });
    for (const [bot, owner] of [
      [TEAM_BOT, OWNER],
      [ADMINS_BOT, ADMIN_OWNER],
    ] as const) {
      await database.insert(agents).values({
        id: bot,
        tenantId: "team",
        name: bot,
        type: "built_in",
        configuration: {},
      });
      await database.insert(agentProfiles).values({
        agentId: bot,
        tenantId: "team",
        ownerUserId: owner,
        title: bot,
        roleDescription: "测试员工",
        avatarSeed: bot,
        visibility: "private",
      });
      await database.insert(teamBotPublications).values({
        agentId: bot,
        tenantId: "team",
        publishedBy: owner,
        audience: "team",
      });
    }
    /*
     * 升级前的行：`granted_as` 为 NULL。员工主人自助安装的（授予人是主人的邮箱，大小写不同）、管理员授予
     * 的、以及身为管理员的主人自己装的。
     */
    await database.insert(pluginGrants).values([
      {
        tenantId: "team",
        kind: "mcp",
        ref: REF,
        agentId: TEAM_BOT,
        grantedBy: email(OWNER).toLowerCase(),
      },
      {
        tenantId: "team",
        kind: "mcp",
        ref: OTHER_REF,
        agentId: TEAM_BOT,
        grantedBy: email(ADMIN),
      },
      {
        tenantId: "team",
        kind: "mcp",
        ref: REF,
        agentId: ADMINS_BOT,
        grantedBy: email(ADMIN_OWNER),
      },
    ]);
  });
  for (const person of [OWNER, TEAMMATE])
    await runAsTenant(person, () =>
      database
        .insert(composioConnections)
        .values({ toolkit: MAIL, userId: person, verified: true }),
    );
});

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(composioConnections)
      .where(eq(composioConnections.toolkit, MAIL));
    await database.delete(agents).where(inArray(agents.id, bots));
    await database.delete(mcpServers).where(eq(mcpServers.id, MAIL));
    await database.delete(users).where(inArray(users.id, people));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

/** 0197 里给 `plugin_grants` 回填 `owner` 的那一条语句。 */
function backfillStatement(): string {
  const migration = readFileSync(
    new URL(
      "../recovery/recovery-20261018-v1/sql/0197_owner_app_grants.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const statement = migration
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .find((part) => part.startsWith('UPDATE "public"."plugin_grants"'));
  if (!statement) throw new Error("0197 has no plugin_grants backfill");
  return statement;
}

describe("0197 backfills an owner's grants written before the column", () => {
  test("an owner's own install becomes the owner's; an admin's grant, and an admin owner's own, stay as they were", async () => {
    const rollback = new Error("rollback");
    let seen: Record<string, string | null> = {};
    await expect(
      asPlatform(() =>
        database.transaction(async (tx) => {
          await tx.execute(sql.raw(backfillStatement()));
          const rows = await tx
            .select({
              agentId: pluginGrants.agentId,
              ref: pluginGrants.ref,
              grantedAs: pluginGrants.grantedAs,
            })
            .from(pluginGrants)
            .where(inArray(pluginGrants.agentId, bots));
          seen = Object.fromEntries(
            rows.map((row) => [`${row.agentId} ${row.ref}`, row.grantedAs]),
          );
          // 回滚：只看这条语句做了什么，不改别的测试的行。
          throw rollback;
        }),
      ),
    ).rejects.toBe(rollback);
    expect(seen).toEqual({
      [`${TEAM_BOT} ${REF}`]: "owner",
      [`${TEAM_BOT} ${OTHER_REF}`]: null,
      [`${ADMINS_BOT} ${REF}`]: null,
    });
    // 回滚之后行是升级前的样子，下面的运行时兜底照样有东西可测。
    expect(await grantedAs(TEAM_BOT, REF)).toBeNull();
  });
});

describe("at run time, a grant with no mark whose granter is the Bot's owner is the owner's", () => {
  test("grantedByOwner reads it as the owner's, and an admin's grant as not", async () => {
    expect(
      await runAsTenant(TEAMMATE, () =>
        grantedByOwner(database, TEAM_BOT, {
          grantedAs: null,
          grantedBy: email(OWNER).toLowerCase(),
        }),
      ),
    ).toBe(true);
    expect(
      await runAsTenant(TEAMMATE, () =>
        grantedByOwner(database, TEAM_BOT, {
          grantedAs: null,
          grantedBy: email(ADMIN),
        }),
      ),
    ).toBe(false);
    expect(
      await runAsTenant(TEAMMATE, () =>
        grantedByOwner(database, TEAM_BOT, {
          grantedAs: "admin",
          grantedBy: email(OWNER),
        }),
      ),
    ).toBe(false);
  });

  test("a teammate's call on it never goes out on the owner's account", async () => {
    const teamBots = createTeamBots({
      database,
      connectedServers: async (userId) =>
        new Set(userId === OWNER ? [MAIL] : []),
    });
    expect(
      await runAsTenant(TEAMMATE, () =>
        teamBots.credentialActorFor(TEAMMATE, TEAM_BOT)(REF),
      ),
    ).toBe(TEAMMATE);
    // 管理员的授予照旧用主人的账号。
    expect(
      await runAsTenant(TEAMMATE, () =>
        teamBots.credentialActorFor(TEAMMATE, TEAM_BOT)(OTHER_REF),
      ),
    ).toBe(OWNER);
  });

  test("the app card says it was given by the owner", async () => {
    await asPlatform(() =>
      database
        .delete(pluginGrants)
        .where(
          sql`${pluginGrants.agentId} = ${TEAM_BOT} and ${pluginGrants.ref} = ${OTHER_REF}`,
        ),
    );
    const inspected = await runAsTenant(OWNER, () =>
      plugins.inspectApp({
        app: MAIL,
        agentId: TEAM_BOT,
        userId: OWNER,
        composioConfigured: true,
      }),
    );
    expect(inspected?.access.givenByOwner).toBe(true);
  });
});
