/**
 * The P2 assembler's tests. The fixture is three directories built on disk: a miniature pipeline
 * output (what `port:capabilities --out` emits), a miniature WorkBuddy home (where the attachments
 * live), and a miniature brand package (what gets merged into). Everything the real port relies on
 * is pinned here: the attachment threshold and its refusals, the `_porting` synthesis for the seed
 * skills, the connector auth override, manifest coverage of the WHOLE package, byte-level
 * idempotency, and the §6.4.1 mutation tests for the audit-rule stamp.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  AUTH_OVERRIDES,
  assemblePackage,
  buildAssetPlans,
  mergeSkillsYaml,
  parseAssembleArgs,
  readPipelineOutput,
  renderPackageConnectorsYaml,
  type SkillAssetPlan,
} from "./assemble-package";
import { verifyOutDir } from "./index";
import type { ManifestEntry } from "./manifest";
import { auditRulesSha256 } from "./mapping";
import { sha256Hex } from "./normalize";

const root = mkdtempSync(join(tmpdir(), "port-capabilities-assemble-"));
const pipelineDir = join(root, "pipeline");
const sourceDir = join(root, "workbuddy");
const packageDir = join(root, "package");

/** Write a file, creating parents. */
function write(base: string, relativePath: string, content: string): void {
  const absolute = join(base, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

// -------------------------------------------------------------------------------------------------
// Fixtures.

const SKILL_MD = "---\nname: alpha-skill\ndescription: d\n---\n\nAlpha body.\n";
const SKILL_CHECKSUM = sha256Hex(SKILL_MD);
const BIG_BODY = `${"x".repeat(25_000)}\n`;

/** A valid manifest row; every field the §6.4 validator requires is present. */
function manifestRow(input: {
  kind: string;
  slug: string;
  runnable?: string;
  slugSource?: string;
}): ManifestEntry {
  return {
    kind: input.kind as ManifestEntry["kind"],
    slug: input.slug,
    ...(input.slugSource
      ? { slug_source: input.slugSource as ManifestEntry["slug_source"] }
      : {}),
    source: "workbuddy fixture:demo@1.0.0",
    source_url: "workbuddy/demo",
    source_version: "1.0.0",
    fetched_at: "2026-10-18T00:00:00Z",
    checksum_sha256: SKILL_CHECKSUM,
    license: "proprietary-workbuddy-marketplace",
    redistributable: false,
    attribution: "© WorkBuddy",
    runnable: (input.runnable ?? "full") as ManifestEntry["runnable"],
    dropped: [],
  };
}

// The pipeline output: two agents, two skills (one with attachments), one team, two connectors, and
// a manifest whose row count matches exactly what verifyOutDir will cross-check.
write(
  pipelineDir,
  "agents.yaml",
  stringifyYaml({
    agents: [
      {
        id: "alpha-agent",
        name: "甲",
        title: "甲专家",
        role_description: "甲的职责",
        avatar_seed: "alpha-agent",
        type: "built-in",
        system_prompt: "甲的系统提示词，纯指令，无工具引用。",
        skills: ["alpha-skill"],
      },
      {
        id: "beta-agent",
        name: "乙",
        title: "乙专家",
        role_description: "乙的职责",
        avatar_seed: "beta-agent",
        type: "built-in",
        system_prompt: "乙的系统提示词。",
        skills: [],
      },
    ],
  }),
);
write(
  pipelineDir,
  "skills.yaml",
  stringifyYaml({
    skills: [
      {
        slug: "alpha-skill",
        title: "Alpha",
        summary: "带附件的技能",
        instructions: "先读 references/notes.md 再做。",
        tools: [],
        _porting: {
          source: "workbuddy fixture:alpha@1.0.0",
          source_url: "workbuddy/alpha",
          source_version: "1.0.0",
          fetched_at: "2026-10-18T00:00:00Z",
          checksum_sha256: SKILL_CHECKSUM,
          license: "proprietary-workbuddy-marketplace",
          redistributable: false,
          attribution: "© WorkBuddy",
          declared_tools: [],
          runnable: "full",
          dropped: ["references/"],
          refs_bytes: 40,
        },
      },
      {
        slug: "beta-skill",
        title: "Beta",
        summary: "纯指令技能",
        instructions: "直接做。",
        tools: [],
        _porting: {
          source: "workbuddy fixture:beta@1.0.0",
          source_url: "workbuddy/beta",
          source_version: "1.0.0",
          fetched_at: "2026-10-18T00:00:00Z",
          checksum_sha256: sha256Hex(
            "---\nname: beta-skill\n---\n\nBeta body.\n",
          ),
          license: "proprietary-workbuddy-marketplace",
          redistributable: false,
          attribution: "© WorkBuddy",
          declared_tools: [],
          runnable: "full",
          dropped: [],
          refs_bytes: 0,
        },
      },
    ],
  }),
);
write(
  pipelineDir,
  "teams.yaml",
  stringifyYaml({
    teams: [
      {
        id: "alpha-team",
        name: "甲团",
        description: "两个人的最小团队",
        channel: "alpha-team",
        lead: "alpha-agent",
        members: [
          { id: "alpha-agent", name: "甲", title: "甲专家", role: "lead" },
          { id: "beta-agent", name: "乙", title: "乙专家", role: "member" },
        ],
        address: [{ from: "alpha-agent", to: ["beta-agent"] }],
      },
    ],
  }),
);
write(
  pipelineDir,
  "connectors.yaml",
  stringifyYaml({
    connectors: [
      {
        id: "github",
        title: "GitHub",
        vendor: "GitHub",
        url: "https://api.githubcopilot.com/mcp/",
        host: "api.githubcopilot.com",
        auth: "user-oauth",
        credential_env: "GITHUB_MCP_CREDENTIAL_ID",
        source_url: "workbuddy/github/mcp.json",
      },
      {
        id: "tencent-docs",
        title: "腾讯文档",
        vendor: "腾讯",
        url: "https://docs.qq.com/openapi/mcp",
        host: "docs.qq.com",
        auth: "user-oauth",
        credential_env: "TENCENT_DOCS_MCP_CREDENTIAL_ID",
        source_url: "workbuddy/tencent-docs/mcp.json",
      },
    ],
  }),
);
write(
  pipelineDir,
  "capability-manifest.yaml",
  stringifyYaml([
    manifestRow({ kind: "agent", slug: "alpha-agent" }),
    manifestRow({ kind: "agent", slug: "beta-agent" }),
    manifestRow({ kind: "skill", slug: "alpha-skill", slugSource: "raw" }),
    manifestRow({ kind: "skill", slug: "beta-skill", slugSource: "raw" }),
    manifestRow({ kind: "team", slug: "alpha-team" }),
    manifestRow({ kind: "connector", slug: "github" }),
    manifestRow({ kind: "connector", slug: "tencent-docs" }),
  ]),
);
write(pipelineDir, "slug-conflicts.md", "# slug 冲突与丢弃记录\n");
write(
  pipelineDir,
  "tool-ref-audit.md",
  `# 工具引用审计\n\naudit_rules_sha256: ${auditRulesSha256()}\n`,
);

// The WorkBuddy home: the one skill that carries attachments, with every refusal shape represented.
write(sourceDir, "skills/alpha-source/SKILL.md", SKILL_MD);
write(sourceDir, "skills/alpha-source/references/notes.md", "notes\n");
write(sourceDir, "skills/alpha-source/references/nested/deep.md", "deep\n");
write(sourceDir, "skills/alpha-source/references/too-big.md", BIG_BODY);
write(
  sourceDir,
  "skills/alpha-source/references/diagram.png",
  "not really a png\n",
);

// The brand package: one seed agent, one seed skill, the files the assembler must never rewrite.
const SEED_SKILLS_RAW = `# 种子技能目录。
skills:
  - slug: legacy-skill
    title: 种子
    summary: 包自己的技能
    instructions: 按步骤做，不要假装跑过命令。
    tools: []
`;
const SEED_AGENTS = {
  agents: [
    {
      id: "seed-assistant",
      name: "种子",
      title: "Seed Assistant",
      role_description: "种子的职责",
      type: "built-in",
      system_prompt: "你是种子助手。",
      skills: [],
    },
  ],
};
write(packageDir, "skills.yaml", SEED_SKILLS_RAW);
write(packageDir, "agents.yaml", stringifyYaml(SEED_AGENTS));
write(
  packageDir,
  "brand.yaml",
  "tenant:\n  id: fixture\n  product_name: 测试品牌\n",
);

// -------------------------------------------------------------------------------------------------

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseAssembleArgs", () => {
  test("requires all three paths and rejects unknown flags", () => {
    expect(() => parseAssembleArgs(["--from", "a"])).toThrow("--source");
    expect(() =>
      parseAssembleArgs([
        "--from",
        "a",
        "--source",
        "b",
        "--package",
        "c",
        "--x",
      ]),
    ).toThrow("无法识别");
    expect(
      parseAssembleArgs(["--from", "a", "--source", "b", "--package", "c"]),
    ).toEqual({
      fromDir: "a",
      sourceRoot: "b",
      packageDir: "c",
      help: false,
    });
  });
});

describe("buildAssetPlans", () => {
  test("keeps text files up to the threshold, refuses the rest with reasons", () => {
    const pipeline = readPipelineOutput(pipelineDir);
    const plans = buildAssetPlans(pipeline.skills, sourceDir);
    const plan = plans.get("alpha-skill") as SkillAssetPlan;
    expect(plan.assets.map((asset) => asset.path)).toEqual([
      "references/nested/deep.md",
      "references/notes.md",
    ]);
    expect(plan.assets.every((asset) => asset.bytes <= 24 * 1024)).toBeTrue();
    expect(plan.dropped).toEqual([
      "references/diagram.png（非文本附件，skill_assets 无载体）",
      "references/too-big.md（24.4KB，超过单文件 24KB 入仓上限）",
    ]);
  });

  test("refuses to guess when the source skill cannot be located", () => {
    const pipeline = readPipelineOutput(pipelineDir);
    write(
      sourceDir,
      "skills/alpha-source/SKILL.md",
      "edited, checksum no longer matches\n",
    );
    try {
      expect(() => buildAssetPlans(pipeline.skills, sourceDir)).toThrow(
        "无法落位附件",
      );
    } finally {
      write(sourceDir, "skills/alpha-source/SKILL.md", SKILL_MD);
    }
  });
});

describe("mergeSkillsYaml", () => {
  test("keeps the seed text verbatim (comments included), injects _porting, appends assets", () => {
    const pipeline = readPipelineOutput(pipelineDir);
    const plans = buildAssetPlans(pipeline.skills, sourceDir);
    const packageSkills = (
      parseYaml(SEED_SKILLS_RAW) as { skills: Record<string, unknown>[] }
    ).skills;
    const connectorIds = new Set(
      pipeline.connectors.map((connector) => String(connector.id)),
    );
    const mergedText = mergeSkillsYaml({
      legacySkillsRaw: SEED_SKILLS_RAW,
      packageSkills,
      generatedSkills: pipeline.skills,
      plans,
      connectorIds,
    });
    expect(mergedText.startsWith("# 种子技能目录。")).toBeTrue();
    expect(mergedText).toContain("skills:\n  - slug: legacy-skill");
    // The seed entry keeps its position and every original line; the block arrives as new lines only.
    const merged = parseYaml(mergedText) as {
      skills: Record<string, unknown>[];
    };
    expect(merged.skills).toHaveLength(3);
    const legacy = merged.skills[0];
    expect(legacy.slug).toBe("legacy-skill");
    const porting = legacy._porting as Record<string, unknown>;
    expect(porting.source).toBe("xiongbao-package");
    expect(porting.checksum_sha256).toBe(
      sha256Hex("按步骤做，不要假装跑过命令。"),
    );
    expect(porting.runnable).toBe("full");
    const alpha = merged.skills.find(
      (skill) => skill.slug === "alpha-skill",
    ) as Record<string, unknown>;
    expect(alpha.assets).toEqual([
      "references/nested/deep.md",
      "references/notes.md",
    ]);
    expect((alpha._porting as Record<string, unknown>).dropped).toEqual([
      "references/",
      "references/diagram.png（非文本附件，skill_assets 无载体）",
      "references/too-big.md（24.4KB，超过单文件 24KB 入仓上限）",
    ]);
  });

  test("a re-run replaces only the previously generated rows and stays byte-identical", () => {
    const pipeline = readPipelineOutput(pipelineDir);
    const plans = buildAssetPlans(pipeline.skills, sourceDir);
    const connectorIds = new Set(
      pipeline.connectors.map((connector) => String(connector.id)),
    );
    const packageSkills = (
      parseYaml(SEED_SKILLS_RAW) as { skills: Record<string, unknown>[] }
    ).skills;
    const first = mergeSkillsYaml({
      legacySkillsRaw: SEED_SKILLS_RAW,
      packageSkills,
      generatedSkills: pipeline.skills,
      plans,
      connectorIds,
    });
    const second = mergeSkillsYaml({
      legacySkillsRaw: first,
      packageSkills: parseYaml(first).skills as Record<string, unknown>[],
      generatedSkills: pipeline.skills,
      plans,
      connectorIds,
    });
    expect(second).toBe(first);
  });

  test("refuses a slug that the seed package already owns", () => {
    const pipeline = readPipelineOutput(pipelineDir);
    const clashing = [{ ...pipeline.skills[0], slug: "legacy-skill" }];
    expect(() =>
      mergeSkillsYaml({
        legacySkillsRaw: SEED_SKILLS_RAW,
        packageSkills: (
          parseYaml(SEED_SKILLS_RAW) as { skills: Record<string, unknown>[] }
        ).skills,
        generatedSkills: clashing,
        plans: new Map(),
        connectorIds: new Set(),
      }),
    ).toThrow("重名");
  });
});

describe("renderPackageConnectorsYaml", () => {
  test("downgrades only the overridden connector and states the reason beside it", () => {
    const pipeline = readPipelineOutput(pipelineDir);
    const text = renderPackageConnectorsYaml(pipeline.connectors);
    const doc = parseYaml(text) as { connectors: Record<string, unknown>[] };
    expect(doc.connectors.find((row) => row.id === "github")?.auth).toBe(
      "user-oauth",
    );
    const docs = doc.connectors.find((row) => row.id === "tencent-docs");
    expect(docs?.auth).toBe(AUTH_OVERRIDES["tencent-docs"]);
    expect(text).toContain("降级为 deployment-bearer");
  });
});

describe("assemblePackage", () => {
  const result = assemblePackage({
    fromDir: pipelineDir,
    sourceRoot: sourceDir,
    packageDir,
  });

  test("places one file per generated agent and never touches the brand facts", () => {
    expect(result.agentFiles.sort()).toEqual(["alpha-agent", "beta-agent"]);
    for (const id of result.agentFiles) {
      const document = parseYaml(
        readFileSync(join(packageDir, "agents", `${id}.yaml`), "utf8"),
      ) as Record<string, unknown>;
      expect(document.id).toBe(id);
      expect(document.agents).toBeUndefined();
    }
    expect(readFileSync(join(packageDir, "brand.yaml"), "utf8")).toBe(
      "tenant:\n  id: fixture\n  product_name: 测试品牌\n",
    );
    expect(existsSync(join(packageDir, "channels.yaml"))).toBeFalse();
    expect(result.mergedSkills).toBe(3);
    expect(result.manifestRows).toBe(9);
    expect(result.assetFiles).toBe(2);
  });

  test("is byte-identical when run twice", () => {
    const before = result.files.map((file) =>
      readFileSync(join(packageDir, file), "utf8"),
    );
    const again = assemblePackage({
      fromDir: pipelineDir,
      sourceRoot: sourceDir,
      packageDir,
    });
    expect(again.files).toEqual(result.files);
    expect(
      again.files.map((file) => readFileSync(join(packageDir, file), "utf8")),
    ).toEqual(before);
  });

  test("a re-run keeps an existing agent file's portrait and persona unchanged", () => {
    const file = join(packageDir, "agents", "alpha-agent.yaml");
    const generated = readFileSync(file, "utf8");
    const authored = parseYaml(generated) as Record<string, unknown>;
    authored.portrait = "doctor";
    authored.persona = { tone: "冷静。", principles: "讲证据。", habits: "" };
    const ordered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(authored)) {
      if (key === "portrait" || key === "persona") continue;
      ordered[key] = value;
      if (key === "avatar_seed") ordered.portrait = authored.portrait;
      if (key === "system_prompt") ordered.persona = authored.persona;
    }
    const withFields = `${generated.split("\n")[0]}\n${stringifyYaml(ordered, { lineWidth: 0 })}`;
    writeFileSync(file, withFields, "utf8");
    assemblePackage({
      fromDir: pipelineDir,
      sourceRoot: sourceDir,
      packageDir,
    });
    expect(readFileSync(file, "utf8")).toBe(withFields);
    const kept = parseYaml(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    expect(kept.portrait).toBe("doctor");
    expect(kept.persona).toEqual({
      tone: "冷静。",
      principles: "讲证据。",
      habits: "",
    });
    // Leave the fixture as the other tests expect it.
    writeFileSync(file, generated, "utf8");
    assemblePackage({
      fromDir: pipelineDir,
      sourceRoot: sourceDir,
      packageDir,
    });
  });

  test("passes --verify on the assembled package (agents/ counted, stamps present)", () => {
    expect(verifyOutDir(packageDir)).toEqual([]);
  });
});

describe("verifyOutDir audit-rule stamps (§6.4.1 mutations 3 and 4)", () => {
  test("deleting the manifest's first line fails the check", () => {
    const path = join(packageDir, "capability-manifest.yaml");
    const original = readFileSync(path, "utf8");
    try {
      writeFileSync(path, original.split("\n").slice(1).join("\n"), "utf8");
      const problems = verifyOutDir(packageDir);
      expect(
        problems.some(
          (problem) =>
            problem.file === "capability-manifest.yaml" &&
            problem.detail.includes("audit_rules_sha256"),
        ),
      ).toBeTrue();
    } finally {
      writeFileSync(path, original, "utf8");
    }
  });

  test("deleting the report's hash line fails the check", () => {
    const path = join(packageDir, "tool-ref-audit.md");
    const original = readFileSync(path, "utf8");
    try {
      writeFileSync(
        path,
        original.replace(`audit_rules_sha256: ${auditRulesSha256()}\n`, ""),
        "utf8",
      );
      const problems = verifyOutDir(packageDir);
      expect(
        problems.some(
          (problem) =>
            problem.file === "tool-ref-audit.md" &&
            problem.detail.includes("audit_rules_sha256"),
        ),
      ).toBeTrue();
    } finally {
      writeFileSync(path, original, "utf8");
    }
  });

  test("a stale hash fails the check in both files", () => {
    const manifestPath = join(packageDir, "capability-manifest.yaml");
    const auditPath = join(packageDir, "tool-ref-audit.md");
    const manifestOriginal = readFileSync(manifestPath, "utf8");
    const auditOriginal = readFileSync(auditPath, "utf8");
    const stale = "0".repeat(64);
    try {
      writeFileSync(
        manifestPath,
        manifestOriginal.replace(auditRulesSha256(), stale),
        "utf8",
      );
      writeFileSync(
        auditPath,
        auditOriginal.replace(auditRulesSha256(), stale),
        "utf8",
      );
      const problems = verifyOutDir(packageDir);
      expect(
        problems.filter((problem) => problem.detail.includes("不一致")),
      ).toHaveLength(2);
    } finally {
      writeFileSync(manifestPath, manifestOriginal, "utf8");
      writeFileSync(auditPath, auditOriginal, "utf8");
    }
  });
});
