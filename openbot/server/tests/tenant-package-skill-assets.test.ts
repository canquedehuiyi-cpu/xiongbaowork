import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  deploymentPackages,
  skillAssets,
  skills as skillTable,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import type { LoadedTenantPackage } from "../src/tenant-package";
import {
  loadTenantPackage,
  synchronizeTenantPackage,
} from "../src/tenant-package";
import type { SkillAssetFile } from "../src/tenant-package-capabilities";
import { skillAssetManifest } from "../src/tenant-package-capabilities";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A brand package's skill attachments, from `skills.yaml` to `skill_assets` (4c-C2).
 *
 * The manifest is the runtime half of the contract: a skill with files carries, at the END of its
 * instructions, a machine-generated list naming each file and the two tools that read it, so a Bot
 * that can act on the skill learns the files exist without the files spending every run's context.
 * The database half is `writeSkillAssets` inside the sync: declared files land, a redeploy that stops
 * declaring one takes the row back, and a package switch takes the whole skill — files cascading with
 * it — the way ticket 029 retires every other kind of content.
 *
 * Nothing here reads `examples/xiongbao`: the package is built in memory under this suite's own
 * tenant key, so its rows are its own and an interrupted run cannot colour another suite's outcome.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenantKey = `pkg-assets-tenant-${suite}`;
const skillSlug = `asset-shipping-${suite}`;
const skillSlugB = `asset-second-${suite}`;

const assetFile = (path: string, content: string): SkillAssetFile => ({
  path,
  mediaType: "text/markdown",
  content,
  bytes: Buffer.byteLength(content, "utf8"),
  checksum: `checksum-${path}`,
});

const files = () => [
  assetFile("references/step-1.md", "# Step 1\n\n第一步。"),
  assetFile("references/step-2.md", "# Step 2\n\n第二步。"),
];

const packageWith = (
  assets: Record<string, SkillAssetFile[]>,
  checksumSuffix: string,
): LoadedTenantPackage => ({
  tenantId: tenantKey,
  formerTenantIds: [],
  productName: "附件同步测试",
  stylesheet: null,
  agents: [],
  omittedAgentIds: [],
  channels: [],
  model: {
    provider: "openai",
    credentialSecretRef: "ASSET_TEST_KEY",
    defaultModel: "test-model",
  },
  knowledgeSources: [],
  skills: [
    {
      slug: skillSlug,
      title: "带附件的技能",
      summary: "证明附件会落库并在说明里列出来。",
      instructions: "按步执行。",
      tools: [],
      assets: Object.keys(assets[skillSlug] ?? {}),
    },
  ],
  skillAssets: assets,
  themeCss: "",
  sourcePath: `tests/fixtures/assets-${suite}`,
  checksum: `assets-${checksumSuffix}-${suite}`,
});

const applyPackage = (tenantPackage: LoadedTenantPackage) =>
  runAsTenant("platform", () =>
    synchronizeTenantPackage(database, tenantPackage),
  );

const catalogueSkill = async () =>
  await runAsTenant("platform", () =>
    database
      .select()
      .from(skillTable)
      .where(eq(skillTable.id, skillSlug))
      .limit(1),
  );

const assetPaths = async (skillId: string) =>
  await runAsTenant("platform", () =>
    database
      .select({ path: skillAssets.path })
      .from(skillAssets)
      .where(eq(skillAssets.skillId, skillId)),
  );

/** Whatever deployment rows this suite created, cleared the way tenant-package.test.ts clears its. */
let createdPackageId: string | null = null;

afterEach(async () => {
  await runAsTenant("platform", async () => {
    await database
      .delete(skillAssets)
      .where(eq(skillAssets.skillId, skillSlug));
    await database
      .delete(skillAssets)
      .where(eq(skillAssets.skillId, skillSlugB));
    await database.delete(skillTable).where(eq(skillTable.id, skillSlug));
    await database.delete(skillTable).where(eq(skillTable.id, skillSlugB));
    if (createdPackageId) {
      await database
        .delete(deploymentPackages)
        .where(eq(deploymentPackages.id, createdPackageId));
      createdPackageId = null;
    }
  });
});

afterAll(async () => {
  await database.$client.close();
});

describe("skill attachments in a tenant package", () => {
  test("lands declared files and appends the manifest to the instructions", async () => {
    const deploymentPackage = await applyPackage(
      packageWith({ [skillSlug]: files() }, "v1"),
    );
    createdPackageId = deploymentPackage.id;

    const [row] = await catalogueSkill();
    expect(row).toBeDefined();
    expect(row?.instructions).toContain("按步执行。");
    // The manifest is APPENDED: the author's text first, the machine-generated list after.
    expect(row?.instructions).toContain("---");
    expect(row?.instructions).toContain("skills/list_skill_assets");
    expect(row?.instructions).toContain("skills/read_skill_asset");
    expect(row?.instructions).toContain("references/step-1.md");
    expect(row?.instructions).toContain("references/step-2.md");
    // And the manifest sits at the end, not the middle: the whole machine-generated
    // block is the last thing in the instructions. The manifest's own lines end with
    // `（大小，类型）`, so the assertion anchors on the manifest itself rather than on a
    // bare path that never terminates a line (CI run 43328257829: endsWith(path) was
    // false by construction, not by any product fault).
    expect(
      row?.instructions.trimEnd().endsWith(skillAssetManifest(files())),
    ).toBe(true);

    const rows = await assetPaths(skillSlug);
    expect(rows.map(({ path }) => path).sort()).toEqual([
      "references/step-1.md",
      "references/step-2.md",
    ]);
  });

  test("a skill without attachments keeps its instructions byte-identical", async () => {
    const deploymentPackage = await applyPackage(packageWith({}, "bare"));
    createdPackageId = deploymentPackage.id;
    const [row] = await catalogueSkill();
    expect(row?.instructions).toBe("按步执行。");
    expect(await assetPaths(skillSlug)).toHaveLength(0);
  });

  test("a resync takes back attachments the package stopped declaring", async () => {
    await applyPackage(packageWith({ [skillSlug]: files() }, "v1"));
    const second = packageWith({ [skillSlug]: [files()[0]!] }, "v2");
    const deploymentPackage = await applyPackage(second);
    createdPackageId = deploymentPackage.id;

    const rows = await assetPaths(skillSlug);
    expect(rows.map(({ path }) => path)).toEqual(["references/step-1.md"]);
    // The manifest follows the declaration, so the retired file stops being advertised too.
    const [row] = await catalogueSkill();
    expect(row?.instructions).toContain("references/step-1.md");
    expect(row?.instructions).not.toContain("references/step-2.md");
  });

  test("switching packages takes the skill's files back with it", async () => {
    await applyPackage(packageWith({ [skillSlug]: files() }, "v1"));
    expect((await catalogueSkill()).length).toBe(1);

    // The same tenant, now declaring nothing: the retire sweep deletes the skill row and the files
    // cascade away with it — no attachment-specific sweep, by design (see `writeSkillAssets`).
    const without: LoadedTenantPackage = {
      ...packageWith({}, "none"),
      skills: [],
    };
    const deploymentPackage = await applyPackage(without);
    createdPackageId = deploymentPackage.id;

    expect(await catalogueSkill()).toHaveLength(0);
    expect(await assetPaths(skillSlug)).toHaveLength(0);
  });

  test("loading refuses a declared asset path that escapes its skill", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-assets-escape-"));
    try {
      const write = async (filename: string, contents: string) => {
        await writeFile(join(directory, filename), contents, "utf8");
      };
      await mkdir(join(directory, "skills", skillSlugB), { recursive: true });
      await write(
        "brand.yaml",
        `tenant:\n  id: asset-escape\n  product_name: Attachment Escape\n`,
      );
      await write("agents.yaml", "agents: []\n");
      await write("channels.yaml", "channels: []\n");
      await write(
        "model.yaml",
        "model:\n  provider: openai\n  credential_secret_ref: key\n  default_model: test-model\n",
      );
      await write("knowledge.yaml", "sources: []\n");
      await write(
        "skills.yaml",
        `skills:\n  - slug: ${skillSlugB}\n    title: 逃跑的附件\n    summary: 路径逃逸要被拒绝。\n    instructions: 无关。\n    tools: []\n    assets:\n      - ../../outside.md\n`,
      );
      await writeFile(
        join(directory, "skills", skillSlugB, "..", "outside.md"),
        "不属于这个技能。",
        "utf8",
      );

      let message = "";
      try {
        await loadTenantPackage(directory);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(skillSlugB);
      expect(message).toContain("../../outside.md");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
