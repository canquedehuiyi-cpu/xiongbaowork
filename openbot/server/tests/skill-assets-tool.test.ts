import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents as agentTable,
  pluginGrants,
  skillAssets,
  skills as skillTable,
} from "../src/db/schema";
import { SYSTEM_TENANT } from "../src/db/schema/tenant";
import {
  callTool,
  listTools,
  useSkillAssetTools,
} from "../src/skills/read-tool";
import { runAsTenant } from "../src/tenant/context";
import type { SkillAssetFile } from "../src/tenant-package-capabilities";
import { writeSkillAssets } from "../src/tenant-package-capabilities";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The `skills` builtin server, end to end against the database (4c-C2).
 *
 * The two gates are the point of the suite. The offer gate (a Bot without the `mcp` grants never sees
 * the tools) is `listForAgent`'s ordinary narrowing and is not re-tested here; the gate under test is
 * the one this transport owns: being granted the TOOL is not being granted the FILES, so `callTool`
 * re-checks the skill grant per call, and the refusal must survive its own reverse proof — the same
 * call that succeeds while the grant stands has to refuse once the grant is gone.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
useSkillAssetTools({ database });

const suite = randomUUID().slice(0, 8);
const skillId = `asset-skill-${suite}`;
const escapedBot = `asset-bot-escaped-${suite}`;
const entitledBot = `asset-bot-entitled-${suite}`;

const FILES: SkillAssetFile[] = [
  {
    path: "references/step-1.md",
    mediaType: "text/markdown",
    content: "# Step 1\n\n先做这一步。",
    bytes: Buffer.byteLength("# Step 1\n\n先做这一步。", "utf8"),
    checksum: "checksum-step-1",
  },
  {
    path: "references/step-2.md",
    mediaType: "text/markdown",
    content: "# Step 2\n\n然后做这一步。",
    bytes: Buffer.byteLength("# Step 2\n\n然后做这一步。", "utf8"),
    checksum: "checksum-step-2",
  },
];

/**
 * Everything here is catalogue content, so it is written and cleared in the `system` partition — the
 * same frame the package sync writes in, and the frame whose rows every reader admits.
 */
const inCatalogue = <T>(work: () => Promise<T>) =>
  runAsTenant(SYSTEM_TENANT, work);

async function seedBot(agentId: string) {
  await inCatalogue(async () => {
    await database.insert(agentTable).values({
      id: agentId,
      name: agentId,
      type: "built_in",
      configuration: {},
    });
  });
}

async function grantSkill(agentId: string) {
  await inCatalogue(async () => {
    await database.insert(pluginGrants).values([
      { kind: "mcp", ref: "skills/list_skill_assets", agentId },
      { kind: "mcp", ref: "skills/read_skill_asset", agentId },
      { kind: "skill", ref: skillId, agentId },
    ]);
  });
}

async function revokeSkillGrant(agentId: string) {
  await inCatalogue(async () => {
    await database
      .delete(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, "skill"),
          eq(pluginGrants.ref, skillId),
          eq(pluginGrants.agentId, agentId),
        ),
      );
  });
}

const call = (botId: string, toolName: string, args: unknown) =>
  callTool({ url: "builtin://skills", botId }, toolName, args);

// The skill and its files exist for the whole suite; each test builds only the grants it needs.
await inCatalogue(async () => {
  await database.insert(skillTable).values({
    id: skillId,
    tenantId: SYSTEM_TENANT,
    ownerUserId: null,
    slug: skillId,
    title: "附件测试技能",
    summary: "只用于技能附件读工具的测试。",
    instructions: "按步执行。",
    origin: "catalogue",
  });
  await writeSkillAssets(database, skillId, FILES);
});
await seedBot(entitledBot);
await seedBot(escapedBot);

afterEach(async () => {
  await runAsTenant("platform", async () => {
    for (const agentId of [entitledBot, escapedBot]) {
      await database
        .delete(pluginGrants)
        .where(eq(pluginGrants.agentId, agentId));
    }
  });
});

afterAll(async () => {
  await runAsTenant("platform", async () => {
    // The skill rows take their files with them (cascade); the assets delete is only belt and braces.
    await database.delete(skillAssets).where(eq(skillAssets.skillId, skillId));
    await database.delete(skillTable).where(eq(skillTable.id, skillId));
    for (const agentId of [entitledBot, escapedBot]) {
      await database
        .delete(pluginGrants)
        .where(eq(pluginGrants.agentId, agentId));
      await database.delete(agentTable).where(eq(agentTable.id, agentId));
    }
  });
  await database.$client.close();
});

describe("the skills asset read tools", () => {
  test("advertises exactly the two read tools", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "list_skill_assets",
      "read_skill_asset",
    ]);
  });

  test("lists a granted skill's attachments without their contents", async () => {
    await grantSkill(entitledBot);
    const result = await call(entitledBot, "list_skill_assets", {
      skillId,
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("references/step-1.md");
    expect(result.text).toContain("references/step-2.md");
    expect(result.text).not.toContain("先做这一步");
  });

  test("reads one granted skill attachment whole", async () => {
    await grantSkill(entitledBot);
    const result = await call(entitledBot, "read_skill_asset", {
      skillId,
      path: "references/step-1.md",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toBe(FILES[0]?.content);
  });

  test("refuses a bot that holds the tool but not the skill", async () => {
    // The mcp grants are present (the tool is "installed" on the Bot); the skill grant is not.
    await inCatalogue(async () => {
      await database.insert(pluginGrants).values([
        { kind: "mcp", ref: "skills/list_skill_assets", agentId: escapedBot },
        { kind: "mcp", ref: "skills/read_skill_asset", agentId: escapedBot },
      ]);
    });
    const listed = await call(escapedBot, "list_skill_assets", { skillId });
    expect(listed.isError).toBe(true);
    expect(listed.text).toContain(skillId);
    const read = await call(escapedBot, "read_skill_asset", {
      skillId,
      path: "references/step-1.md",
    });
    expect(read.isError).toBe(true);
    expect(read.text).toContain(skillId);
  });

  test("revoking the skill grant turns a working call into a refusal", async () => {
    await grantSkill(entitledBot);
    const allowed = await call(entitledBot, "read_skill_asset", {
      skillId,
      path: "references/step-2.md",
    });
    expect(allowed.isError).toBe(false);
    await revokeSkillGrant(entitledBot);
    const refused = await call(entitledBot, "read_skill_asset", {
      skillId,
      path: "references/step-2.md",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(skillId);
  });

  test("refuses a read whose path escapes the skill", async () => {
    await grantSkill(entitledBot);
    const result = await call(entitledBot, "read_skill_asset", {
      skillId,
      path: "../other-skill/secrets.md",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("../other-skill/secrets.md");
  });

  test("deleting the skill takes its attachments with it", async () => {
    // A throwaway skill so the suite's shared rows are untouched.
    const throwaway = `asset-gone-${suite}`;
    await inCatalogue(async () => {
      await database.insert(skillTable).values({
        id: throwaway,
        tenantId: SYSTEM_TENANT,
        ownerUserId: null,
        slug: throwaway,
        title: "会被删除的技能",
        summary: "证明附件随技能删除。",
        instructions: "无关。",
        origin: "catalogue",
      });
      await writeSkillAssets(database, throwaway, [FILES[0]!]);
    });
    const before = await inCatalogue(() =>
      database
        .select({ path: skillAssets.path })
        .from(skillAssets)
        .where(eq(skillAssets.skillId, throwaway)),
    );
    expect(before).toHaveLength(1);
    await inCatalogue(async () => {
      await database.delete(skillTable).where(eq(skillTable.id, throwaway));
    });
    const after = await inCatalogue(() =>
      database
        .select({ path: skillAssets.path })
        .from(skillAssets)
        .where(eq(skillAssets.skillId, throwaway)),
    );
    expect(after).toHaveLength(0);
  });
});
