import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents as agentTable,
  mcpServers,
  pluginGrants,
  skills as skillTable,
  skillTools,
} from "../src/db/schema";
import { SYSTEM_TENANT } from "../src/db/schema/tenant";
import { runAsTenant } from "../src/tenant/context";
import type { LoadedTenantPackage } from "../src/tenant-package";
import { synchronizeTenantPackage } from "../src/tenant-package";
import type { PackageConnector } from "../src/tenant-package-capabilities";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A brand package's connectors, from `connectors.yaml` to `mcp_servers` (4a-A1).
 *
 * The load-bearing rules, each with a test below: a package writes SERVER ROWS and never a grant (a
 * grant on a connector reaches the account the deployment holds for it, so it stays an
 * administrator's decision); a redeploy takes back only rows with the package's own mark, so a server
 * an administrator added by hand outlives every resync; the plain-text refs the recycled servers
 * leave behind are cleared by the sync itself, because a ref with no server is a dead name in a
 * picker; and a declared connector whose `host` disagrees with its own URL refuses to load — a
 * lookalike host is the one mistake that must never pass quietly.
 *
 * The package is synthetic, under this suite's own tenant key, for the same reason
 * `tenant-package-switch-retires.test.ts` builds its own: sharing the real package's ids would put
 * this suite's outcome in the hands of whichever test file synchronized it first.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenantKey = `pkg-connectors-tenant-${suite}`;
const adminId = `connector-admin-${suite}`;

const connector = (
  overrides: Partial<PackageConnector> = {},
): PackageConnector => ({
  id: `pkg-connector-${suite}`,
  title: "包声明的连接器",
  vendor: "测试厂商",
  url: "https://pkg-connector.example.test/mcp/",
  host: "pkg-connector.example.test",
  auth: "none",
  credentialEnv: null,
  docsUrl: null,
  ...overrides,
});

const packageWith = (
  connectors: PackageConnector[],
  checksumSuffix: string,
): LoadedTenantPackage => ({
  tenantId: tenantKey,
  formerTenantIds: [],
  productName: "连接器同步测试",
  stylesheet: null,
  agents: [],
  omittedAgentIds: [],
  channels: [],
  model: {
    provider: "openai",
    credentialSecretRef: "CONNECTOR_TEST_KEY",
    defaultModel: "test-model",
  },
  knowledgeSources: [],
  skills: [],
  connectors,
  themeCss: "",
  sourcePath: `tests/fixtures/connectors-${suite}`,
  checksum: `connectors-${checksumSuffix}-${suite}`,
});

const applyPackage = (tenantPackage: LoadedTenantPackage) =>
  runAsTenant("platform", () =>
    synchronizeTenantPackage(database, tenantPackage),
  );

const serverRow = async (id: string) =>
  await runAsTenant("platform", () =>
    database.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1),
  );

/** Rows this package wrote; the mark is what makes the sweep theirs to take back. */
const packageRows = async () =>
  await runAsTenant("platform", () =>
    database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(
        and(
          eq(mcpServers.tenantId, SYSTEM_TENANT),
          eq(mcpServers.addedBy, "tenant-package"),
          // Suite-scoped: another suite's package rows are none of this file's business.
          like(mcpServers.id, `%${suite}`),
        ),
      ),
  );

const grantCount = async (refPrefix: string) =>
  await runAsTenant("platform", () =>
    database
      .select({ ref: pluginGrants.ref })
      .from(pluginGrants)
      .where(like(pluginGrants.ref, `%${suite}/%`)),
  ).then((rows) => rows.filter(({ ref }) => ref.startsWith(refPrefix)).length);

const skillToolCount = async (refPrefix: string) =>
  await runAsTenant("platform", () =>
    database
      .select({ ref: skillTools.ref })
      .from(skillTools)
      .where(like(skillTools.ref, `%${suite}/%`)),
  ).then((rows) => rows.filter(({ ref }) => ref.startsWith(refPrefix)).length);

/** The Bot the dangling grant is written against; plugin_grants.agent_id is a real foreign key. */
const grantBot = `pkg-grant-bot-${suite}`;
await runAsTenant("platform", () =>
  database.insert(agentTable).values({
    id: grantBot,
    tenantId: SYSTEM_TENANT,
    name: grantBot,
    type: "built_in",
    configuration: {},
  }),
);

afterEach(async () => {
  await runAsTenant("platform", async () => {
    // Suite-scoped deletes only: every id this file writes ends with the suite key.
    await database.delete(mcpServers).where(like(mcpServers.id, `%${suite}`));
    await database
      .delete(pluginGrants)
      .where(like(pluginGrants.ref, `%${suite}/%`));
    await database
      .delete(skillTools)
      .where(like(skillTools.ref, `%${suite}/%`));
    await database
      .delete(skillTable)
      .where(eq(skillTable.id, `pkg-skill-${suite}`));
    // grantBot 不在这里删：后续用例还要往 plugin_grants 里写它的授权，afterEach 删掉它会让
    // 下一个用例的 INSERT 撞外键。清理归 afterAll（见下）。
  });
});

afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database.delete(mcpServers).where(like(mcpServers.id, `%${suite}`));
    await database
      .delete(pluginGrants)
      .where(like(pluginGrants.ref, `%${suite}/%`));
    await database
      .delete(skillTools)
      .where(like(skillTools.ref, `%${suite}/%`));
    await database
      .delete(skillTable)
      .where(eq(skillTable.id, `pkg-skill-${suite}`));
    await database.delete(agentTable).where(eq(agentTable.id, grantBot));
  });
  await database.$client.close();
});

describe("connectors in a tenant package", () => {
  test("writes a custom server row with the package's mark, and no grant", async () => {
    const declared = connector();
    await applyPackage(packageWith([declared], "v1"));

    const [row] = await serverRow(declared.id);
    expect(row).toBeDefined();
    expect(row?.provenance).toBe("custom");
    expect(row?.addedBy).toBe("tenant-package");
    expect(row?.url).toBe(declared.url);
    expect(row?.vendor).toBe(declared.vendor);
    // 没有凭据可绑（无 credential_env），待绑定。
    expect(row?.credentialId).toBeNull();

    // A package does not seed MCP grants: reaching the deployment's account is an administrator's call.
    expect(await grantCount(`${declared.id}/`)).toBe(0);
    expect(await packageRows()).toHaveLength(1);
  });

  test("is idempotent: a second sync leaves the same rows and values", async () => {
    const declared = connector({ id: `pkg-idem-${suite}` });
    await applyPackage(packageWith([declared], "v1"));
    const before = await serverRow(declared.id);
    await applyPackage(packageWith([declared], "v1"));
    const after = await serverRow(declared.id);
    expect(after).toHaveLength(1);
    expect(after[0]?.url).toBe(before[0]?.url);
    expect(after[0]?.title).toBe(before[0]?.title);
    expect(after[0]?.addedBy).toBe(before[0]?.addedBy);
    expect(await packageRows()).toHaveLength(1);
  });

  test("refuses to load when the declared id is already an administrator's server", async () => {
    const handAdded = connector({
      id: `pkg-admin-${suite}`,
      url: "https://pkg-admin.example.test/mcp/",
      host: "pkg-admin.example.test",
    });
    await runAsTenant("platform", async () => {
      await database.insert(mcpServers).values({
        tenantId: SYSTEM_TENANT,
        id: handAdded.id,
        title: "管理员手加的服务器",
        vendor: "别的来源",
        url: handAdded.url,
        provenance: "custom",
        addedBy: adminId,
      });
    });

    let message = "";
    try {
      await applyPackage(packageWith([handAdded], "conflict"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(handAdded.id);
    expect(message).toContain("connectors.yaml");
    // The administrator's row is untouched, and nothing of the package's was written either.
    const [row] = await serverRow(handAdded.id);
    expect(row?.addedBy).toBe(adminId);
    expect(await packageRows()).toHaveLength(0);
  });

  test("a resync recycles only rows marked tenant-package, and clears the dangling refs", async () => {
    const declared = connector({ id: `pkg-recycle-${suite}` });
    // An administrator's server with an id of its own: no package may ever recycle it.
    const handAddedId = `pkg-hand-${suite}`;
    await runAsTenant("platform", async () => {
      await database.insert(mcpServers).values({
        tenantId: SYSTEM_TENANT,
        id: handAddedId,
        title: "管理员手加的服务器",
        vendor: "别的来源",
        url: `https://${handAddedId}.example.test/mcp/`,
        provenance: "custom",
        addedBy: adminId,
      });
      // Dangling refs against the connector the package is about to stop declaring.
      await database.insert(pluginGrants).values({
        kind: "mcp",
        ref: `${declared.id}/search`,
        agentId: grantBot,
        tenantId: SYSTEM_TENANT,
      });
      // The skill row must exist before the tool declarations that reference it:
      // `skill_tools.skill_id` is a real foreign key, so this order is the only one
      // that loads. CI (run 43328257829) failed here with
      // `skill_tools_skill_id_skills_id_fk` when the declaration was written first.
      await database.insert(skillTable).values({
        id: `pkg-skill-${suite}`,
        tenantId: SYSTEM_TENANT,
        ownerUserId: null,
        slug: `pkg-skill-${suite}`,
        title: "引用连接器的技能",
        summary: "为悬空 ref 清理而设。",
        instructions: "无关。",
        origin: "catalogue",
      });
      await database.insert(skillTools).values({
        skillId: `pkg-skill-${suite}`,
        tenantId: SYSTEM_TENANT,
        ref: `${declared.id}/search`,
        declaredBy: null,
      });
    });

    await applyPackage(packageWith([declared], "v1"));
    expect(await grantCount(`${declared.id}/`)).toBe(1);
    expect(await skillToolCount(`${declared.id}/`)).toBe(1);

    // The package stops declaring the connector; the hand-added server stays.
    await applyPackage(packageWith([], "v2"));
    expect(await serverRow(declared.id)).toHaveLength(0);
    const [handRow] = await serverRow(handAddedId);
    expect(handRow).toBeDefined();
    expect(handRow?.addedBy).toBe(adminId);
    // The refs did not survive the recycle: no dead name in a picker.
    expect(await grantCount(`${declared.id}/`)).toBe(0);
    expect(await skillToolCount(`${declared.id}/`)).toBe(0);
  });

  test("带下划线的连接器 id 只清自己的悬空 ref，不误删同形异写 id 的授权", async () => {
    // `pkg_wild_<suite>` 用下划线：未转义时 LIKE 模式里的 `_` 是单字符通配符，
    // `pkg-wild-<suite>`（连字符版，形近的另一个连接器）的 ref 会被一并删掉——跨租户的整表删除。
    const declared = connector({ id: `pkg_wild_${suite}` });
    const lookalikeRef = `pkg-wild-${suite}/search`;

    await runAsTenant("platform", async () => {
      await database.insert(skillTable).values({
        id: `pkg-skill-${suite}`,
        tenantId: SYSTEM_TENANT,
        ownerUserId: null,
        slug: `pkg-skill-${suite}`,
        title: "通配符清理测试技能",
        summary: "为下划线 id 的悬空 ref 清理而设。",
        instructions: "无关。",
        origin: "catalogue",
      });
      await database.insert(pluginGrants).values([
        // 声明连接器自己的悬空 ref：回收后应当被清掉。
        { kind: "mcp", ref: `${declared.id}/search`, agentId: grantBot, tenantId: SYSTEM_TENANT },
        // 形近连接器的 ref：无论何时都不是这次回收的对象。
        { kind: "mcp", ref: lookalikeRef, agentId: grantBot, tenantId: SYSTEM_TENANT },
      ]);
      await database.insert(skillTools).values({
        skillId: `pkg-skill-${suite}`,
        tenantId: SYSTEM_TENANT,
        ref: `${declared.id}/search`,
        declaredBy: null,
      });
    });

    await applyPackage(packageWith([declared], "v1"));
    expect(await grantCount(`${declared.id}/`)).toBe(1);
    expect(await grantCount(`pkg-wild-${suite}/`)).toBe(1);

    // 包停止声明该连接器：只回收自己的行与自己的 ref。
    await applyPackage(packageWith([], "v2"));
    expect(await serverRow(declared.id)).toHaveLength(0);
    expect(await grantCount(`${declared.id}/`)).toBe(0);
    expect(await skillToolCount(`${declared.id}/`)).toBe(0);
    // 形近 id 的授权原样保留：这是本条意见的核心断言。
    expect(await grantCount(`pkg-wild-${suite}/`)).toBe(1);
  });

  test("拒绝加载声明了无目录项 user-oauth 连接器的包：不静默降级成共享凭据", async () => {
    // user-oauth 声明的是逐用户授权；本构建目录里没有这个连接器的条目，平台给不了逐用户
    // OAuth。原样写入的结果是共享凭据上所有人打到同一个账号——所以同步必须拒绝，
    // 而不是像修复前那样把声明丢在一边、注册一个普通的 custom 服务器。
    const declared = connector({ id: `pkg-useroauth-${suite}`, auth: "user-oauth" });
    let message = "";
    try {
      await applyPackage(packageWith([declared], "useroauth"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(declared.id);
    expect(message).toContain("user-oauth");
    // 整包拒绝：什么都没写进来，也没有回收任何行。
    expect(await serverRow(declared.id)).toHaveLength(0);
    expect(await packageRows()).toHaveLength(0);
  });

  test("credential_id stays null while the named environment variable is unset", async () => {
    const declared = connector({
      id: `pkg-cred-${suite}`,
      auth: "deployment-bearer",
      credentialEnv: `PKG_CONNECTOR_UNSET_${suite.replace(/-/g, "_").toUpperCase()}`,
    });
    await applyPackage(packageWith([declared], "cred"));
    const [row] = await serverRow(declared.id);
    expect(row?.credentialId).toBeNull();
  });
});
