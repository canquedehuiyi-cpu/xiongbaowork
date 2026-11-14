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
  cpSync,
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
  AGENT_NAME_OVERRIDES,
  AssembleError,
  AUTH_OVERRIDES,
  applyVerdictDowngrades,
  assemblePackage,
  buildAssetPlans,
  computeAssetDowngrades,
  mergeSkillsYaml,
  parseAssembleArgs,
  readLegacyPackage,
  readPipelineOutput,
  renderGeneratedSkillEntry,
  renderPackageConnectorsYaml,
  type AssetDowngrade,
  type SkillAssetPlan,
  withDisplayName,
} from "./assemble-package";
import { verifyOutDir } from "./verify-out-dir";
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

describe("withDisplayName", () => {
  test("a coworker its source names by the author's handle gets its display name, heading included", () => {
    expect(AGENT_NAME_OVERRIDES["xtgxiso-windows-pc-care"]).toBe("电脑管家");
    const named = withDisplayName({
      id: "xtgxiso-windows-pc-care",
      name: "xtgxiso",
      title: "电脑运维专家",
      system_prompt: "# xtgxiso\n\n你是本团队的成员之一。",
    });
    expect(named.name).toBe("电脑管家");
    expect(named.system_prompt).toBe("# 电脑管家\n\n你是本团队的成员之一。");
    expect(named.title).toBe("电脑运维专家");
  });

  test("every other coworker is left exactly as the pipeline made it", () => {
    const agent = {
      id: "frontend-developer",
      name: "像素匠",
      system_prompt: "# 像素匠",
    };
    expect(withDisplayName(agent)).toBe(agent);
  });
});

// -------------------------------------------------------------------------------------------------
// Attachment reachability.

describe("asset downgrades — full must not promise files that did not ship", () => {
  /** A generated skill row as the pipeline emits it (only the fields these functions read). */
  function generatedSkill(input: {
    slug: string;
    instructions: string;
    runnable?: string;
    dropped?: string[];
  }): Record<string, unknown> {
    return {
      slug: input.slug,
      title: input.slug,
      summary: "s",
      instructions: input.instructions,
      tools: [],
      _porting: {
        source: "workbuddy fixture:demo@1.0.0",
        runnable: input.runnable ?? "full",
        dropped: input.dropped ?? [],
      },
    };
  }

  function planOf(input: {
    slug: string;
    assets?: string[];
    dropped?: string[];
  }): SkillAssetPlan {
    return {
      slug: input.slug,
      assets: (input.assets ?? []).map((path) => ({
        path,
        content: "",
        bytes: 0,
        checksum: sha256Hex(""),
      })),
      dropped: input.dropped ?? [],
    };
  }

  const REFUSAL = "references/too-big.md（24.4KB，超过单文件 24KB 入仓上限）";
  const CITING_BODY = "Read `references/too-big.md` before you start.\n";

  test("a full skill citing a refused file is lowered to degraded", () => {
    const downgrades = computeAssetDowngrades({
      skills: [generatedSkill({ slug: "alpha", instructions: CITING_BODY })],
      plans: new Map([["alpha", planOf({ slug: "alpha", dropped: [REFUSAL] })]]),
    });
    const downgrade = downgrades.get("alpha");
    expect(downgrade?.runnable).toBe("degraded");
    expect(downgrade?.reason).toBe("missing-asset-references");
    expect(downgrade?.reasonRef).toContain("references/too-big.md");
  });

  test("a body that cites nothing absent is left alone", () => {
    const downgrades = computeAssetDowngrades({
      skills: [generatedSkill({ slug: "alpha", instructions: "Read `references/kept.md`.\n" })],
      plans: new Map([
        ["alpha", planOf({ slug: "alpha", assets: ["references/kept.md"], dropped: [REFUSAL] })],
      ]),
    });
    expect(downgrades.size).toBe(0);
  });

  test("with no plan in hand it reads the row's own assets, so an assembled package judges the same way", () => {
    // Re-reading an already-assembled package supplies no plan; the row's `assets:` carries the fact
    // that P1 shipped references/. Without this fallback every references/ entry would look missing.
    const skills = [
      {
        ...generatedSkill({ slug: "alpha", instructions: "Read `references/kept.md`.\n" }),
        _porting: {
          source: "workbuddy fixture:demo@1.0.0",
          runnable: "full",
          dropped: ["references/"],
        },
        assets: ["references/kept.md"],
      },
    ];
    const downgrades = computeAssetDowngrades({ skills, plans: new Map() });
    expect(downgrades.size).toBe(0);
  });

  test("a blocked skill is never rewritten — its licence reason outranks this one", () => {
    const downgrades = computeAssetDowngrades({
      skills: [
        generatedSkill({ slug: "alpha", instructions: CITING_BODY, runnable: "blocked" }),
      ],
      plans: new Map([["alpha", planOf({ slug: "alpha", dropped: [REFUSAL] })]]),
    });
    expect(downgrades.size).toBe(0);
  });

  test("renderGeneratedSkillEntry writes the new verdict with its reason beside it", () => {
    const text = renderGeneratedSkillEntry(
      generatedSkill({ slug: "alpha", instructions: CITING_BODY }),
      planOf({ slug: "alpha", dropped: [REFUSAL] }),
      {
        slug: "alpha",
        runnable: "degraded",
        reason: "missing-asset-references",
        reasonRef: "文件 references/too-big.md 未入包",
      },
    );
    // The entry is a YAML list item, so the document parses to a one-element array.
    const parsed = (parseYaml(text) as Record<string, unknown>[])[0];
    const porting = parsed._porting as Record<string, unknown>;
    expect(porting.runnable).toBe("degraded");
    expect(porting.reason).toBe("missing-asset-references");
    expect(porting.reason_ref).toContain("references/too-big.md");
    // Position, not just presence: the reason must be readable right under the verdict.
    const lines = text.split("\n").map((line) => line.trim());
    const runnableAt = lines.findIndex((line) => line === "runnable: degraded");
    expect(lines[runnableAt + 1]).toBe("reason: missing-asset-references");
    expect(lines[runnableAt + 2]).toStartWith("reason_ref:");
  });

  test("an existing reason is kept and this rule is appended, not substituted", () => {
    const text = renderGeneratedSkillEntry(
      generatedSkill({ slug: "alpha", instructions: CITING_BODY, runnable: "degraded" }),
      planOf({ slug: "alpha", dropped: [REFUSAL] }),
      {
        slug: "alpha",
        runnable: "degraded",
        reason: "missing-asset-references",
        reasonRef: "文件 references/too-big.md 未入包",
      },
    );
    const parsed = (parseYaml(text) as Record<string, unknown>[])[0];
    const porting = parsed._porting as Record<string, unknown>;
    expect(porting.runnable).toBe("degraded");
    expect(porting.reason).toBe("missing-asset-references");
  });

  test("without a downgrade the entry is byte-identical to before", () => {
    const skill = generatedSkill({ slug: "alpha", instructions: CITING_BODY });
    const plan = planOf({ slug: "alpha", dropped: [REFUSAL] });
    expect(renderGeneratedSkillEntry(skill, plan, undefined)).toBe(
      renderGeneratedSkillEntry(skill, plan),
    );
  });

  test("the manifest row follows the verdict instead of disagreeing with skills.yaml", () => {
    const rows: ManifestEntry[] = [
      manifestRow({ kind: "skill", slug: "alpha", runnable: "full", slugSource: "raw" }),
      manifestRow({ kind: "skill", slug: "beta", runnable: "full", slugSource: "raw" }),
      manifestRow({ kind: "agent", slug: "alpha", runnable: "full" }),
    ];
    const downgrades = new Map<string, AssetDowngrade>([
      [
        "alpha",
        {
          slug: "alpha",
          runnable: "degraded",
          reason: "missing-asset-references",
          reasonRef: "文件 references/too-big.md 未入包",
        },
      ],
    ]);
    const applied = applyVerdictDowngrades(rows, downgrades);
    expect(applied.find((row) => row.kind === "skill" && row.slug === "alpha")?.runnable).toBe(
      "degraded",
    );
    // Untouched rows keep their verdict, including an agent that happens to share the slug.
    expect(applied.find((row) => row.kind === "skill" && row.slug === "beta")?.runnable).toBe(
      "full",
    );
    expect(applied.find((row) => row.kind === "agent" && row.slug === "alpha")?.runnable).toBe(
      "full",
    );
  });

  test("an empty downgrade map returns the rows unchanged", () => {
    const rows = [manifestRow({ kind: "skill", slug: "alpha", runnable: "full", slugSource: "raw" })];
    expect(applyVerdictDowngrades(rows, new Map())).toEqual(rows);
  });

  test("a real assembler run lowers both files at once, and a second run is byte-identical", () => {
    // End to end, on a private copy: the shared fixture's `alpha-skill` cites a file that P1 refuses
    // only after the body is rewritten to point at it, so the downgrade cannot be pre-computed.
    const copyRoot = mkdtempSync(join(tmpdir(), "port-capabilities-downgrade-"));
    const fromDir = join(copyRoot, "pipeline");
    const copySource = join(copyRoot, "source");
    const copyPackage = join(copyRoot, "package");
    cpSync(pipelineDir, fromDir, { recursive: true });
    cpSync(sourceDir, copySource, { recursive: true });
    cpSync(packageDir, copyPackage, { recursive: true });

    const skillsPath = join(fromDir, "skills.yaml");
    const doc = parseYaml(readFileSync(skillsPath, "utf8")) as {
      skills: Record<string, unknown>[];
    };
    const alpha = doc.skills.find((skill) => skill.slug === "alpha-skill");
    expect(alpha).toBeDefined();
    if (alpha !== undefined) {
      alpha.instructions = "先读 references/too-big.md 再做。";
    }
    writeFileSync(skillsPath, stringifyYaml(doc), "utf8");

    const result = assemblePackage({
      fromDir,
      sourceRoot: copySource,
      packageDir: copyPackage,
    });
    expect(result.assetDowngraded).toBe(1);

    const shipped = parseYaml(
      readFileSync(join(copyPackage, "skills.yaml"), "utf8"),
    ) as { skills: Record<string, unknown>[] };
    const shippedAlpha = shipped.skills.find((skill) => skill.slug === "alpha-skill");
    const porting = shippedAlpha?._porting as Record<string, unknown> | undefined;
    expect(porting?.runnable).toBe("degraded");
    expect(porting?.reason).toBe("missing-asset-references");
    // The sibling that cites only a file that did ship keeps its verdict.
    const shippedBeta = shipped.skills.find((skill) => skill.slug === "beta-skill");
    const betaPorting = shippedBeta?._porting as Record<string, unknown> | undefined;
    expect(betaPorting?.runnable).toBe("full");

    const manifest = parseYaml(
      readFileSync(join(copyPackage, "capability-manifest.yaml"), "utf8"),
    ) as ManifestEntry[];
    const manifestAlpha = manifest.find(
      (row) => row.kind === "skill" && row.slug === "alpha-skill",
    );
    expect(manifestAlpha?.runnable).toBe("degraded");

    // Idempotency: re-running must not drift, or the package diff becomes noise.
    const firstRun = readFileSync(join(copyPackage, "skills.yaml"), "utf8");
    assemblePackage({ fromDir, sourceRoot: copySource, packageDir: copyPackage });
    expect(readFileSync(join(copyPackage, "skills.yaml"), "utf8")).toBe(firstRun);

    rmSync(copyRoot, { recursive: true, force: true });
  });
});

/**
 * A `--package` that is not a package yet.
 *
 * The assembler merges the pipeline's output INTO a brand package; it does not create one, because the
 * brand, the channels, the model and the knowledge sources are facts somebody has to write. Handed an
 * empty directory it used to fail with `ENOENT: no such file or directory, open '…/skills.yaml'` —
 * accurate, and useless to the person who ran it: nothing in that sentence says the command will never
 * be able to build a package from nothing, so re-running it is the obvious and wrong next move.
 */
describe("a --package directory that is not a package yet", () => {
  test("says what the command does instead of quoting ENOENT", () => {
    const empty = mkdtempSync(join(tmpdir(), "port-assemble-empty-"));
    try {
      expect(() => readLegacyPackage(empty)).toThrow(AssembleError);
      expect(() => readLegacyPackage(empty)).toThrow(/只把管道产出并入/);
      // The two things the caller can do next, named: prepare the files, or point at a real package.
      expect(() => readLegacyPackage(empty)).toThrow(/skills\.yaml/);
      expect(() => readLegacyPackage(empty)).toThrow(/--package/);
      expect(() => readLegacyPackage(empty)).not.toThrow(/ENOENT/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("a present skills.yaml but a missing agents.yaml is named the same way", () => {
    const half = mkdtempSync(join(tmpdir(), "port-assemble-half-"));
    try {
      writeFileSync(join(half, "skills.yaml"), "skills: []\n", "utf8");
      expect(() => readLegacyPackage(half)).toThrow(/agents\.yaml/);
      expect(() => readLegacyPackage(half)).not.toThrow(/ENOENT/);
    } finally {
      rmSync(half, { recursive: true, force: true });
    }
  });
});
