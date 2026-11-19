/**
 * The normaliser is where three rules from §3.2 of the plan become code, so each gets its own test with
 * the exact case that motivated it:
 *
 *   - three `dev-expert` builds installed at user level, all of which must survive;
 *   - `engineering-workflow-skills` and `ex_eqoqYRT1NIwb`, identical apart from line endings;
 *   - Chinese display names preferred over English everywhere a person reads.
 *
 * The `normalizeCapabilities` cases build literal snapshots rather than fixture trees, because the
 * behaviour under test is text and identity, not filesystem layout.
 */
import { describe, expect, test } from "bun:test";

import {
  directorySlug,
  ensureTenantSlug,
  kebab,
  localizedText,
  normalizeCapabilities,
  normalizeText,
  oneLine,
  packageFingerprint,
  readDeclaredTools,
  sanitizeLocalUserPaths,
  sanitizeWorkbuddyRefs,
  sha256Hex,
  shortenSlug,
  splitDirectoryName,
  splitFrontmatter,
} from "./normalize";
import { TENANT_SLUG_MAX, TENANT_SLUG_PATTERN } from "./mapping";
import { SourceLayoutError } from "./read-workbuddy";
import type {
  PluginJson,
  RawConnector,
  RawExpertPackage,
  RawSkill,
  SourceFile,
  WorkBuddySnapshot,
} from "./read-workbuddy";

/** Build a `SourceFile` with a plausible relative path. */
function sourceFile(relativePath: string, text: string, modifiedAt = "2026-09-01T00:00:00.000Z"): SourceFile {
  return { relativePath, absolutePath: `/abs/${relativePath}`, text, modifiedAt };
}

/** Build a user-level skill. */
function userSkill(
  dirName: string,
  text: string,
  attachments: string[] = [],
  referencesBytes = 0,
): RawSkill {
  return {
    dirName,
    skillMd: sourceFile(`skills/${dirName}/SKILL.md`, text),
    attachments,
    hasReferencesDir: attachments.includes("references"),
    referencesBytes,
    fetchedAt: "2026-09-01T00:00:00.000Z",
    tier: "user",
    packageDirName: null,
  };
}

/** Build a package-bundled skill. */
function packageSkill(packageDirName: string, dirName: string, text: string): RawSkill {
  return {
    dirName,
    skillMd: sourceFile(`plugins/${packageDirName}/skills/${dirName}/SKILL.md`, text),
    attachments: [],
    hasReferencesDir: false,
    referencesBytes: 0,
    fetchedAt: "2026-09-01T00:00:00.000Z",
    tier: "package",
    packageDirName,
  };
}

/** Build an expert package. */
function expertPackage(input: {
  dirName: string;
  plugin: PluginJson;
  agents: { id: string; text: string }[];
  skills?: RawSkill[];
  attachments?: string[];
  pluginText?: string;
}): RawExpertPackage {
  return {
    dirName: input.dirName,
    pluginJson: sourceFile(
      `plugins/marketplaces/experts/plugins/${input.dirName}/.codebuddy-plugin/plugin.json`,
      input.pluginText ?? JSON.stringify(input.plugin),
    ),
    plugin: input.plugin,
    agents: input.agents.map((agent) => ({
      id: agent.id,
      file: sourceFile(`plugins/marketplaces/experts/plugins/${input.dirName}/agents/${agent.id}.md`, agent.text),
    })),
    skills: input.skills ?? [],
    attachments: input.attachments ?? [],
    fetchedAt: "2026-09-16T14:54:10.596Z",
  };
}

/** Build a snapshot from its three parts. */
function snapshot(input: {
  packages?: RawExpertPackage[];
  userSkills?: RawSkill[];
  connectors?: RawConnector[];
}): WorkBuddySnapshot {
  return {
    sourceRoot: "/home/test/.workbuddy",
    packages: input.packages ?? [],
    userSkills: input.userSkills ?? [],
    connectors: input.connectors ?? [],
  };
}

describe("text helpers", () => {
  test("normalizeText strips the BOM and collapses CRLF, which is what makes duplicates compare equal", () => {
    expect(normalizeText("\uFEFFa\r\nb\rc")).toBe("a\nb\nc");
  });

  test("sha256Hex ignores line endings and the BOM but not content", () => {
    expect(sha256Hex("a\r\nb")).toBe(sha256Hex("a\nb"));
    expect(sha256Hex("\uFEFF# x")).toBe(sha256Hex("# x"));
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
    expect(sha256Hex("a")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("splitFrontmatter returns YAML data plus the body", () => {
    const parsed = splitFrontmatter("---\nname: demo\ndescription: |\n  two\n  lines\n---\n\n# Body\n");
    expect(parsed.data.name).toBe("demo");
    expect(parsed.data.description).toBe("two\nlines\n");
    expect(parsed.body).toBe("# Body");
  });

  test("splitFrontmatter keeps the instructions when the front matter is unparsable", () => {
    const parsed = splitFrontmatter("---\nname: [unclosed\n---\n\n# Body\n");
    expect(parsed.body).toBe("# Body");
  });

  test("splitFrontmatter on a document with no front matter keeps the whole body", () => {
    const parsed = splitFrontmatter("# Just a body\n");
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe("# Just a body");
  });

  test("localizedText prefers Chinese, then English, then nothing", () => {
    expect(localizedText({ en: "Forge", zh: "锻码师" })).toBe("锻码师");
    expect(localizedText({ en: "Forge" })).toBe("Forge");
    expect(localizedText({ zh: "   " })).toBeUndefined();
    expect(localizedText("plain")).toBe("plain");
    expect(localizedText(undefined)).toBeUndefined();
  });

  test("oneLine collapses whitespace and cuts at 120 characters, ellipsis included", () => {
    expect(oneLine("a\n\n  b\tc ")).toBe("a b c");
    const long = "字".repeat(200);
    const cut = oneLine(long);
    expect(cut.length).toBe(120);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("slug rules", () => {
  test("kebab lowercases and separates on punctuation, underscores and spaces", () => {
    expect(kebab("Dev Expert")).toBe("dev-expert");
    expect(kebab("user_814dbe54")).toBe("user-814dbe54");
    expect(kebab("./skills/frontend-dev")).toBe("skills-frontend-dev");
    expect(kebab("  ")).toBe("");
  });

  test("splitDirectoryName drops the channel suffix but keeps the author namespace", () => {
    expect(splitDirectoryName("dev-expert__skillhub")).toEqual({ base: "dev-expert", sourceLabel: "skillhub" });
    expect(splitDirectoryName("dev-expert__indiv-weishui__skillhub")).toEqual({
      base: "dev-expert",
      sourceLabel: "indiv-weishui",
    });
    expect(splitDirectoryName("dev-expert__user_814dbe54__skillhub")).toEqual({
      base: "dev-expert",
      sourceLabel: "user_814dbe54",
    });
    expect(splitDirectoryName("fullstack-dev")).toEqual({ base: "fullstack-dev", sourceLabel: "" });
  });

  test("three dev-expert builds all survive, each with its provenance suffix", () => {
    const skills = [
      userSkill("dev-expert__skillhub", "---\nname: dev-expert\nversion: 2.2.0\n---\n\nA\n"),
      userSkill("dev-expert__indiv-weishui__skillhub", "---\nname: dev-expert\nversion: 2.2.3\n---\n\nB\n"),
      userSkill("dev-expert__user_814dbe54__skillhub", "---\nname: dev-expert\nversion: 2.2.0\n---\n\nC\n"),
    ];
    const result = normalizeCapabilities(snapshot({ userSkills: skills }));
    expect(result.skills.map((skill) => skill.slug).sort()).toEqual([
      "dev-expert--indiv-weishui",
      "dev-expert--skillhub",
      "dev-expert--user-814dbe54",
    ]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].baseSlug).toBe("dev-expert");
    expect(result.conflicts[0].resolution).toHaveLength(3);
  });

  test("a user-level skill keeps the bare slug when it collides with a package-bundled one", () => {    const result = normalizeCapabilities(
      snapshot({
        userSkills: [userSkill("github", "---\nname: github\n---\n\nuser body\n")],
        packages: [
          expertPackage({
            dirName: "frontend-developer",
            plugin: { name: "frontend-developer", expertType: "agent", agentName: "frontend-developer", skills: ["./skills/github"] },
            agents: [{ id: "frontend-developer", text: "# persona\n" }],
            skills: [packageSkill("frontend-developer", "github", "---\nname: github\n---\n\npackage body\n")],
          }),
        ],
      }),
    );
    expect(result.skills.map((skill) => skill.slug).sort()).toEqual(["frontend-developer--github", "github"]);
    expect(result.agents[0].skills).toEqual(["frontend-developer--github"]);
  });

  test("content-identical skills collapse, and the drop is recorded against the survivor", () => {
    const text = "---\nname: browser-use\n---\n\nsame\n";
    const result = normalizeCapabilities(
      snapshot({
        packages: [
          expertPackage({
            dirName: "frontend-developer",
            plugin: { name: "frontend-developer", expertType: "agent", agentName: "frontend-developer", skills: ["./skills/browser-use"] },
            agents: [{ id: "frontend-developer", text: "# persona\n" }],
            skills: [packageSkill("frontend-developer", "browser-use", text)],
          }),
          expertPackage({
            dirName: "senior-developer",
            plugin: { name: "senior-developer", expertType: "agent", agentName: "senior-developer", skills: ["./skills/browser-use"] },
            agents: [{ id: "senior-developer", text: "# persona\n" }],
            skills: [packageSkill("senior-developer", "browser-use", text)],
          }),
        ],
      }),
    );
    expect(result.skills.map((skill) => skill.slug)).toEqual(["frontend-developer--browser-use"]);
    expect(result.dropped.some((item) => item.origin.includes("senior-developer"))).toBe(true);
  });
});

describe("package deduplication", () => {
  const plugin: PluginJson = {
    name: "engineering-workflow-skills",
    version: "2.0.1",
    expertType: "agent",
    agentName: "engineering-workflow-coach",
    skills: ["./skills/engineering-workflow"],
  };
  const agentText = "---\nname: engineering-workflow-coach\n---\n\nCoach body.\n";
  const skillText = "---\nname: engineering-workflow\n---\n\nWorkflow body.\n";

  /** Two packages that differ only by line endings, the way the real duplicate pair does. */
  function duplicatePair(): RawExpertPackage[] {
    const readable = expertPackage({
      dirName: "engineering-workflow-skills",
      plugin,
      agents: [{ id: "engineering-workflow-coach", text: agentText }],
      skills: [packageSkill("engineering-workflow-skills", "engineering-workflow", skillText)],
    });
    const opaque = expertPackage({
      dirName: "ex_eqoqYRT1NIwb",
      plugin,
      pluginText: JSON.stringify(plugin).replace(/\n/g, "\r\n"),
      agents: [{ id: "engineering-workflow-coach", text: agentText.replace(/\n/g, "\r\n") }],
      skills: [packageSkill("ex_eqoqYRT1NIwb", "engineering-workflow", skillText.replace(/\n/g, "\r\n"))],
    });
    return [opaque, readable];
  }

  test("fingerprints match across line endings", () => {
    const [opaque, readable] = duplicatePair();
    expect(packageFingerprint(opaque)).toBe(packageFingerprint(readable));
  });

  test("the readable directory name survives and the opaque one is recorded as dropped", () => {
    const result = normalizeCapabilities(snapshot({ packages: duplicatePair() }));
    expect(result.agents.map((agent) => agent.id)).toEqual(["engineering-workflow-coach"]);
    expect(result.skills.map((skill) => skill.slug)).toEqual(["engineering-workflow"]);
    expect(result.agents[0].provenance.sourceUrl).toContain("engineering-workflow-skills");
    expect(result.dropped.some((item) => item.origin.includes("ex_eqoqYRT1NIwb"))).toBe(true);
  });
});

describe("slug provenance", () => {
  /** One package shipping one skill, with a distinguishable agent body so packages never dedupe. */
  function onePackage(packageDirName: string, skillDir: string, body: string): RawExpertPackage {
    return expertPackage({
      dirName: packageDirName,
      plugin: {
        name: packageDirName,
        expertType: "agent",
        agentName: `${packageDirName}-agent`,
        skills: [`./skills/${skillDir}`],
      },
      agents: [{ id: `${packageDirName}-agent`, text: `# ${packageDirName}\n` }],
      skills: [packageSkill(packageDirName, skillDir, `---\nname: ${skillDir}\n---\n\n${body}\n`)],
    });
  }

  test("each of the first four rules labels the row it produced", () => {
    const result = normalizeCapabilities(
      snapshot({
        userSkills: [
          userSkill("unique-name", "---\nname: unique-name\n---\n\nbody\n"),
          userSkill("dev-expert__skillhub", "---\nname: dev-expert\n---\n\nA\n"),
          userSkill("dev-expert__indiv-weishui__skillhub", "---\nname: dev-expert\n---\n\nB\n"),
        ],
        // 49 characters with the prefix, so this one has to fall back to its bare directory name.
        packages: [onePackage("engineering-workflow-skills", "engineering-workflow", "C")],
      }),
    );
    const sourceOf = (slug: string) => result.skills.find((skill) => skill.slug === slug)?.slugSource;
    expect(sourceOf("unique-name")).toBe("raw");
    expect(sourceOf("dev-expert--skillhub")).toBe("dechannel");
    expect(sourceOf("engineering-workflow")).toBe("bare");
    // The package prefix fits, so the ordinary rule applies.
    const withPrefix = normalizeCapabilities(
      snapshot({ packages: [onePackage("demo-expert", "design-html", "D")] }),
    );
    expect(withPrefix.skills[0].slug).toBe("demo-expert--design-html");
    expect(withPrefix.skills[0].slugSource).toBe("package_prefix");
  });

  test("a hash is the last resort, and only when the bare name is already taken", () => {
    // Two packages whose prefixes both overflow, shipping a skill with the same directory name: the first
    // gets the bare name, the second has nowhere left to go.
    const result = normalizeCapabilities(
      snapshot({
        packages: [
          onePackage("a".repeat(40), "shared-skill-dir", "one"),
          onePackage("b".repeat(40), "shared-skill-dir", "two"),
        ],
      }),
    );
    const [first, second] = [...result.skills].sort((a, b) => a.slug.localeCompare(b.slug));
    expect(first.slug).toBe("shared-skill-dir");
    expect(first.slugSource).toBe("bare");
    expect(second.slugSource).toBe("hashed");
    expect(second.slug).not.toBe(first.slug);
    expect(result.skills.every((skill) => TENANT_SLUG_PATTERN.test(skill.slug))).toBe(true);
  });

  test("an over-long user-level name is shortened, not fatal, and still says how", () => {
    // A 41-character directory name used to fail validation and take the whole package with it. Length is
    // mechanically solvable, so it becomes a hash suffix; illegal characters would still be a hard error,
    // but `kebab()` cannot produce one.
    const longName = "a".repeat(41);
    const result = normalizeCapabilities(
      snapshot({ userSkills: [userSkill(longName, `---\nname: ${longName}\n---\n\nbody\n`)] }),
    );
    const skill = result.skills[0];
    expect(TENANT_SLUG_PATTERN.test(skill.slug)).toBe(true);
    expect(skill.slug.length).toBeLessThanOrEqual(TENANT_SLUG_MAX);
    expect(skill.slugSource).toBe("hashed");
  });

  test("the same source under two different roots produces the same slug", () => {
    // The machine-level proof of "规则一经落地不许再改": the hash seed is `<source>/<dir>`, never an
    // absolute path and never the content, so two machines importing the same skill agree. This only
    // matters the day `hashed` fires, which is exactly why it has to be pinned now.
    const longName = "b".repeat(41);
    const build = (root: string) => {
      const skill = userSkill(longName, `---\nname: ${longName}\n---\n\nbody\n`);
      skill.skillMd.absolutePath = `${root}/skills/${longName}/SKILL.md`;
      return normalizeCapabilities({ sourceRoot: root, packages: [], userSkills: [skill], connectors: [] });
    };
    const onWindows = build("C:/Users/alice/.workbuddy");
    const onLinux = build("/home/bob/.workbuddy");
    expect(onWindows.skills[0].slugSource).toBe("hashed");
    expect(onLinux.skills[0].slug).toBe(onWindows.skills[0].slug);
    expect(onLinux.skills[0].slugSource).toBe(onWindows.skills[0].slugSource);
  });

  test("the seed is the source identity, so editing the body cannot rename the skill", () => {    const before = normalizeCapabilities(snapshot({ packages: [onePackage("a".repeat(40), "shared", "first body")] }));
    const after = normalizeCapabilities(snapshot({ packages: [onePackage("a".repeat(40), "shared", "edited body")] }));
    expect(before.skills[0].slug).toBe("shared");
    expect(after.skills[0].slug).toBe("shared");
    expect(before.skills[0].slugSource).toBe(after.skills[0].slugSource);
  });
});

describe("local user path redaction", () => {
  test("replaces the account name in all three measured shapes and keeps the structure", () => {
    expect(sanitizeLocalUserPaths("--content \"C:/Users/canqu/AppData/Local/Temp/twprobe/probe.html\"").text).toBe(
      "--content \"C:/Users/<user>/AppData/Local/Temp/twprobe/probe.html\"",
    );
    expect(sanitizeLocalUserPaths("run /c/Users/canqu/.workbuddy/binaries/python/bin/python3 x.py").text).toBe(
      "run /c/Users/<user>/.workbuddy/binaries/python/bin/python3 x.py",
    );
    expect(sanitizeLocalUserPaths("C:\\Users\\canqu\\AppData\\Local\\Microsoft\\WinGet\\x.exe").text).toBe(
      "C:\\Users\\<user>\\AppData\\Local\\Microsoft\\WinGet\\x.exe",
    );
  });

  test("stops at prose: a name followed by Chinese punctuation does not eat the sentence", () => {
    // Real source text: `必须用 Windows 路径（C:/Users/canqu，不认 MSYS 路径）`. A looser segment class
    // would have swallowed everything up to the next space and deleted the explanation.
    expect(sanitizeLocalUserPaths("必须用 Windows 路径（C:/Users/canqu，不认 MSYS 路径）").text).toBe(
      "必须用 Windows 路径（C:/Users/<user>，不认 MSYS 路径）",
    );
  });

  test("leaves an existing placeholder alone", () => {    const already = "BK=\"C:/Users/<user>/xagent-backup\"; echo $HOME; echo %USERPROFILE%";
    const result = sanitizeLocalUserPaths(already);
    expect(result.text).toBe(already);
    expect(result.hits).toBe(0);
  });

  test("is idempotent: a second pass over its own output changes nothing", () => {
    const once = sanitizeLocalUserPaths("C:/Users/canqu/a and /c/Users/canqu/b");
    expect(once.hits).toBe(2);
    const twice = sanitizeLocalUserPaths(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.hits).toBe(0);
  });

  test("a skill whose body quotes the author's machine is redacted and says so", () => {
    const dirty = userSkill("leaky", "---\nname: leaky\n---\n\n读 C:/Users/canqu/AppData/Local/x.json\n");
    const clean = userSkill("clean", "---\nname: clean\n---\n\n读 references/x.json\n");
    const result = normalizeCapabilities(snapshot({ userSkills: [dirty, clean] }));
    const leaky = result.skills.find((skill) => skill.slug === "leaky");
    const tidy = result.skills.find((skill) => skill.slug === "clean");
    expect(leaky?.instructions).toContain("C:/Users/<user>/AppData/Local/x.json");
    expect(leaky?.instructions.includes("canqu")).toBe(false);
    expect(leaky?.sanitized).toEqual(["local-user-path"]);
    // A clean row stays clean, so `sanitized` is evidence rather than a field everyone has to ignore.
    expect(tidy?.sanitized).toEqual([]);
  });
});

describe("agents and teams", () => {
  const teamPlugin: PluginJson = {
    name: "demo-team",
    version: "1.0.0",
    description: "Demo delivery team",
    expertType: "team",
    agentName: "demo-lead",
    teamInfo: { leadAgent: "demo-lead", memberAgents: ["demo-worker"] },
    displayName: { en: "Demo Team", zh: "演示专家团" },
    profession: { en: "Delivery Team", zh: "交付专家团" },
    members: [
      {
        id: "demo-lead",
        name: { en: "Lee", zh: "李带队" },
        profession: { en: "Director", zh: "交付总监" },
        role: "lead",
      },
      {
        id: "demo-worker",
        name: { en: "Woo", zh: "吴执行" },
        profession: { en: "Engineer", zh: "工程师" },
        role: "member",
      },
    ],
  };

  const teamPackage = expertPackage({
    dirName: "demo-team",
    plugin: teamPlugin,
    agents: [
      { id: "demo-lead", text: "---\nname: demo-lead\n---\n\nLead persona.\n" },
      { id: "demo-worker", text: "---\nname: demo-worker\n---\n\nWorker persona.\n" },
    ],
    skills: [packageSkill("demo-team", "demo-skill", "---\nname: demo-skill\n---\n\nSkill body.\n")],
  });

  test("a team becomes one agent per member, named in Chinese", () => {
    const result = normalizeCapabilities(snapshot({ packages: [teamPackage] }));
    expect(result.agents.map((agent) => agent.id)).toEqual(["demo-lead", "demo-worker"]);
    const lead = result.agents.find((agent) => agent.id === "demo-lead");
    expect(lead?.name).toBe("李带队");
    expect(lead?.title).toBe("交付总监");
    expect(lead?.avatarSeed).toBe("demo-lead");
    expect(lead?.teamId).toBe("demo-team");
    expect(lead?.systemPrompt.startsWith("Lead persona.")).toBe(true);
  });

  test("the lead's prompt gains a team section naming every member and the handoff rule", () => {
    const result = normalizeCapabilities(snapshot({ packages: [teamPackage] }));
    const lead = result.agents.find((agent) => agent.id === "demo-lead");
    const worker = result.agents.find((agent) => agent.id === "demo-worker");
    expect(lead?.systemPrompt).toContain("## 你的团队");
    expect(lead?.systemPrompt).toContain("demo-worker（吴执行，工程师）");
    expect(lead?.systemPrompt).toContain("@成员名字");
    expect(worker?.systemPrompt).not.toContain("## 你的团队");
  });

  test("the team carries a channel, a lead, its members, and a lead→member handoff grant", () => {
    const result = normalizeCapabilities(snapshot({ packages: [teamPackage] }));
    expect(result.teams).toHaveLength(1);
    const team = result.teams[0];
    expect(team.id).toBe("demo-team");
    expect(team.name).toBe("演示专家团");
    expect(team.channel).toBe("demo-team");
    expect(team.lead).toBe("demo-lead");
    expect(team.members).toEqual([
      { id: "demo-lead", name: "李带队", title: "交付总监", role: "lead" },
      { id: "demo-worker", name: "吴执行", title: "工程师", role: "member" },
    ]);
    expect(team.address).toEqual([{ from: "demo-lead", to: ["demo-worker"] }]);
  });

  test("every member of a package is granted the package's declared skills", () => {
    const result = normalizeCapabilities(snapshot({ packages: [teamPackage] }));
    expect(result.agents.every((agent) => agent.skills.length === 1)).toBe(true);
    expect(result.agents[0].skills[0]).toBe("demo-team--demo-skill");
  });

  test("a package with no displayName falls back to the override table, then to its directory name", () => {
    const unnamed = expertPackage({
      dirName: "software-company",
      plugin: {
        name: "software-company",
        version: "1.1.0",
        expertType: "team",
        agentName: "software-team-lead",
        members: [{ id: "software-team-lead", name: { zh: "齐活林" }, role: "lead" }],
      },
      agents: [{ id: "software-team-lead", text: "# Lead\n" }],
    });
    const result = normalizeCapabilities(snapshot({ packages: [unnamed] }));
    expect(result.teams[0].name).toBe("软件公司");
    expect(result.agents[0].name).toBe("齐活林");
  });

  test("an agent whose .md is missing gets a metadata prompt and a warning instead of an empty prompt", () => {
    const partial = expertPackage({
      dirName: "partial",
      plugin: {
        name: "partial",
        expertType: "team",
        agentName: "partial-lead",
        members: [{ id: "partial-lead", role: "lead" }, { id: "ghost", name: { zh: "影子" }, role: "member" }],
      },
      agents: [{ id: "partial-lead", text: "# Lead\n" }],
    });
    const result = normalizeCapabilities(snapshot({ packages: [partial] }));
    const ghost = result.agents.find((agent) => agent.id === "ghost");
    expect(ghost?.systemPrompt).toContain("# 影子");
    expect(result.warnings.some((warning) => warning.includes("ghost"))).toBe(true);
  });

  test("an agent's references/ claim follows the package, which is where an expert keeps them", () => {
    // `xtgxiso-windows-pc-care` points at <package>/references/*.md rather than at anything beside its
    // agent file, so the flag has to come from the package root or the audit misreports it as degraded.
    const withRefs = expertPackage({
      dirName: "pc-care",
      plugin: { name: "pc-care", expertType: "agent", agentName: "pc-care" },
      agents: [{ id: "pc-care", text: "Read references/script-templates.md first.\n" }],
      attachments: ["references", "examples"],
    });
    const result = normalizeCapabilities(snapshot({ packages: [withRefs] }));
    expect(result.agents[0].hasBundledReferences).toBe(true);
  });
});

describe("provenance", () => {
  test("a skill records source, url, version, checksum, licence and the declared tools", () => {
    const skill = userSkill(
      "license-demo",
      "---\nname: license-demo\nversion: 1.2.3\nlicense: MIT\nauthor: Someone\nallowed-tools: Read, Write\n---\n\nBody\n",
    );
    const result = normalizeCapabilities(snapshot({ userSkills: [skill] }));
    const ported = result.skills[0];
    expect(ported.provenance.source).toBe("workbuddy skill-marketplace:license-demo@1.2.3");
    expect(ported.provenance.sourceUrl).toBe("~/.workbuddy/skills/license-demo/SKILL.md");
    expect(ported.provenance.license).toBe("MIT");
    expect(ported.provenance.redistributable).toBe(true);
    expect(ported.provenance.attribution).toBe("© Someone");
    expect(ported.provenance.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(ported.provenance.fetchedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(ported.declaredTools).toEqual(["Read", "Write"]);
    expect(ported.tools).toEqual([]);
  });

  test("a paid skill is never redistributable, however permissive its licence", () => {
    const skill = userSkill(
      "paid-demo",
      "---\nname: paid-demo\nlicense: MIT\npricing:\n  model: per_call\n  amount_fen: 50\n---\n\nBody\n",
    );
    const result = normalizeCapabilities(snapshot({ userSkills: [skill] }));
    expect(result.skills[0].provenance.redistributable).toBe(false);
  });

  test("an undeclared licence stays unspecified and is not redistributable", () => {
    const skill = userSkill("bare-demo", "---\nname: bare-demo\n---\n\nBody\n");
    const result = normalizeCapabilities(snapshot({ userSkills: [skill] }));
    expect(result.skills[0].provenance.license).toBe("unspecified");
    expect(result.skills[0].provenance.redistributable).toBe(false);
    expect(result.skills[0].provenance.attribution).toBe("© WorkBuddy 能力市场");
  });

  test("attachment directories are listed as dropped", () => {
    const skill = userSkill("attach-demo", "---\nname: attach-demo\n---\n\nBody\n", ["references", "scripts"]);
    const result = normalizeCapabilities(snapshot({ userSkills: [skill] }));
    expect(result.skills[0].dropped).toEqual(["references/", "scripts/"]);
    expect(result.skills[0].hasBundledReferences).toBe(true);
  });
});

describe("connectors", () => {
  function connector(
    id: string,
    server: RawConnector["server"],
    marketplace: RawConnector["marketplace"] = null,
  ): RawConnector {
    return {
      id,
      dirName: id,
      mcpJson: sourceFile(`connectors-marketplace/connectors/${id}/mcp.json`, JSON.stringify({ mcpServers: { [id]: server } })),
      server,
      transport: server.url ? "url" : "command",
      attachedSkillPaths: [],
      marketplace,
    };
  }

  test("host is parsed from the url, not copied", () => {
    const result = normalizeCapabilities(
      snapshot({
        connectors: [
          connector("github", { url: "https://api.githubcopilot.com/mcp/", timeout: 600 }, {
            id: "github",
            name: "GitHub",
            authMode: "none",
          }),
        ],
      }),
    );
    expect(result.connectors[0]).toMatchObject({
      id: "github",
      title: "GitHub",
      host: "api.githubcopilot.com",
      url: "https://api.githubcopilot.com/mcp/",
      auth: "user-oauth",
      credentialEnv: "GITHUB_MCP_CREDENTIAL_ID",
      dropped: [],
    });
  });

  test("the title comes from the marketplace index, which is where the Chinese one lives", () => {
    const result = normalizeCapabilities(
      snapshot({
        connectors: [
          connector("tencent-docs", { url: "https://docs.qq.com/openapi/mcp" }, {
            id: "tencent-docs",
            name: "腾讯文档",
            nameEn: "Tencent Docs",
            authMode: "none",
          }),
        ],
      }),
    );
    expect(result.connectors[0].title).toBe("腾讯文档");
  });

  test("a connector with no index row falls back to its id rather than an empty title", () => {
    const result = normalizeCapabilities(
      snapshot({ connectors: [connector("tapd", { url: "https://websocket.tapd.cn/mcp/mcp" })] }),
    );
    expect(result.connectors[0].title).toBe("tapd");
  });

  test("a platform-managed auth mode is recorded, because openbot has no carrier for it", () => {
    // `server-side` means a WorkBuddy gateway holds the credential. openbot has no such gateway, so the
    // emitted `auth` has to be something a deployment can actually supply — and the difference has to be
    // visible in the manifest rather than inferred later.
    const result = normalizeCapabilities(
      snapshot({
        connectors: [
          connector("github", { url: "https://api.githubcopilot.com/mcp/" }, {
            id: "github",
            name: "GitHub",
            authMode: "server-side",
          }),
        ],
      }),
    );
    expect(result.connectors[0].auth).toBe("user-oauth");
    expect(result.connectors[0].dropped.join(" ")).toContain("server-side");
    expect(result.dropped.some((item) => item.reason.includes("server-side"))).toBe(true);
  });

  test("a stdio connector is dropped with a reason instead of being ported", () => {
    const result = normalizeCapabilities(
      snapshot({ connectors: [connector("github", { command: "npx", args: ["-y", "server"] })] }),
    );
    expect(result.connectors).toHaveLength(0);
    expect(result.dropped[0].reason).toContain("远程 URL");
  });

  test("an attached SKILL.md is recorded as dropped rather than becoming a skill", () => {
    const withSkill = { ...connector("github", { url: "https://api.githubcopilot.com/mcp/" }), attachedSkillPaths: ["skill/SKILL.md"] };
    const result = normalizeCapabilities(snapshot({ connectors: [withSkill] }));
    expect(result.skills).toHaveLength(0);
    expect(result.connectors[0].dropped).toHaveLength(1);
  });

  test("a connector with no preset fails loudly rather than emitting half a row", () => {
    expect(() =>
      normalizeCapabilities(snapshot({ connectors: [connector("mystery", { url: "https://mystery.test/mcp" })] })),
    ).toThrow(/no preset/);
  });
});

describe("readDeclaredTools", () => {
  test("accepts the three shapes the corpus uses", () => {
    expect(readDeclaredTools({ "allowed-tools": "Read,Write,Bash" })).toEqual(["Read", "Write", "Bash"]);
    expect(readDeclaredTools({ allowed_tools: ["Read", " Grep "] })).toEqual(["Read", "Grep"]);
    expect(readDeclaredTools({})).toEqual([]);
  });
});

describe("directory slugs", () => {
  test("the author namespace is kept and the channel token is dropped", () => {
    expect(directorySlug("dev-expert__skillhub")).toBe("dev-expert--skillhub");
    expect(directorySlug("dev-expert__indiv-weishui__skillhub")).toBe("dev-expert--indiv-weishui");
    expect(directorySlug("dev-expert__user_814dbe54__skillhub")).toBe("dev-expert--user-814dbe54");
    expect(directorySlug("fullstack-dev")).toBe("fullstack-dev");
  });
});

describe("the tenant-package slug constraint", () => {
  test("the pattern is the one the loader enforces: no underscores, 2 to 40 characters", () => {
    expect(TENANT_SLUG_PATTERN.test("dev-expert--skillhub")).toBe(true);
    expect(TENANT_SLUG_PATTERN.test("dev-expert__skillhub")).toBe(false);
    expect(TENANT_SLUG_PATTERN.test("a")).toBe(false);
    expect(TENANT_SLUG_PATTERN.test("x".repeat(TENANT_SLUG_MAX + 1))).toBe(false);
    expect(TENANT_SLUG_PATTERN.test("x".repeat(TENANT_SLUG_MAX))).toBe(true);
  });

  test("a package prefix that would exceed 40 characters falls back to the skill directory name", () => {
    // The real case: `humanize-ppt-team--remotion-video-toolkit` is 41 characters, and the loader throws.
    const long = expertPackage({
      dirName: "humanize-ppt-team",
      plugin: { name: "humanize-ppt-team", expertType: "agent", agentName: "humanize-ppt-team" },
      agents: [{ id: "humanize-ppt-team", text: "# persona\n" }],
      skills: [packageSkill("humanize-ppt-team", "remotion-video-toolkit", "---\nname: remotion-video-toolkit\n---\n\nBody\n")],
    });
    const result = normalizeCapabilities(snapshot({ packages: [long] }));
    expect(result.skills[0].slug).toBe("remotion-video-toolkit");
    expect(TENANT_SLUG_PATTERN.test(result.skills[0].slug)).toBe(true);
  });

  test("every slug a normalisation produces is loadable, and no two are equal", () => {
    const packages = [
      expertPackage({
        dirName: "engineering-workflow-skills",
        plugin: { name: "engineering-workflow-skills", expertType: "agent", agentName: "coach" },
        agents: [{ id: "coach", text: "# coach\n" }],
        skills: [
          packageSkill(
            "engineering-workflow-skills",
            "engineering-workflow",
            "---\nname: engineering-workflow\n---\n\nBody\n",
          ),
        ],
      }),
      expertPackage({
        dirName: "frontend-developer",
        plugin: { name: "frontend-developer", expertType: "agent", agentName: "fe" },
        agents: [{ id: "fe", text: "# fe\n" }],
        skills: [
          packageSkill("frontend-developer", "github", "---\nname: github\n---\n\npackage\n"),
          packageSkill("frontend-developer", "fullstack-dev", "---\nname: fullstack-dev\n---\n\npackage fe\n"),
        ],
      }),
      expertPackage({
        dirName: "senior-developer",
        plugin: { name: "senior-developer", expertType: "agent", agentName: "sd" },
        agents: [{ id: "sd", text: "# sd\n" }],
        skills: [packageSkill("senior-developer", "fullstack-dev", "---\nname: fullstack-dev\n---\n\nsenior\n")],
      }),
    ];
    const result = normalizeCapabilities(
      snapshot({
        packages,
        userSkills: [
          userSkill("github", "---\nname: github\n---\n\nuser\n"),
          userSkill("fullstack-dev", "---\nname: fullstack-dev\n---\n\nuser\n"),
          userSkill("dev-expert__skillhub", "---\nname: dev-expert\n---\n\nA\n"),
          userSkill("dev-expert__indiv-weishui__skillhub", "---\nname: dev-expert\n---\n\nB\n"),
          userSkill("dev-expert__user_814dbe54__skillhub", "---\nname: dev-expert\n---\n\nC\n"),
        ],
      }),
    );
    const slugs = result.skills.map((skill) => skill.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(TENANT_SLUG_PATTERN.test(slug)).toBe(true);
    }
    expect(slugs).toContain("frontend-developer--fullstack-dev");
    expect(slugs).toContain("senior-developer--fullstack-dev");
    expect(slugs).toContain("fullstack-dev");
  });

  test("a slug that cannot be shortened into shape gets a stable hash suffix", () => {
    // An underscore run collapses to a single hyphen, which is already loadable — the hash is for the
    // cases that are still invalid afterwards, such as one that is simply too long.
    expect(ensureTenantSlug("dev-expert__skillhub", "seed")).toBe("dev-expert-skillhub");
    const long = "x".repeat(60);
    const shortened = shortenSlug(long, "seed");
    expect(TENANT_SLUG_PATTERN.test(shortened)).toBe(true);
    expect(shortened).toBe(shortenSlug(long, "seed"));
    expect(shortened).not.toBe(shortenSlug(long, "other"));
  });
});

describe("references size", () => {
  test("refsBytes is carried through so P2 can decide between inlining and the asset channel", () => {
    const skill = userSkill("big-refs", "---\nname: big-refs\n---\n\nBody\n", ["references"], 64_000);
    const result = normalizeCapabilities(snapshot({ userSkills: [skill] }));
    expect(result.skills[0].refsBytes).toBe(64_000);
    expect(result.skills[0].dropped).toContain("references/");
  });
});

describe("id uniqueness", () => {
  test("a duplicate agent id stops the run, because openbot keys agents by id", () => {
    const plugin: PluginJson = { name: "dup", expertType: "agent", agentName: "same" };
    const one = expertPackage({
      dirName: "first",
      plugin,
      agents: [{ id: "same", text: "# one\n" }],
    });
    const two = expertPackage({
      dirName: "second",
      plugin: { ...plugin, name: "dup-two" },
      agents: [{ id: "same", text: "# two\n" }],
    });
    expect(() => normalizeCapabilities(snapshot({ packages: [one, two] }))).toThrow(/duplicate agent id/);
  });
});

describe("empty sources", () => {
  // A zero-byte or whitespace-only `SKILL.md` used to survive normalisation and become a skill whose
  // `instructions` were empty — a capability that reads downstream as "the model has nothing to do".
  // `--verify` caught it, but only after the package was written and without saying which source it
  // came from. These three shapes all have to stop the run, naming the skill.
  const cases: { name: string; text: string }[] = [
    { name: "0 字节的 SKILL.md", text: "" },
    { name: "只有空白的 SKILL.md", text: "  \r\n\n\t \n" },
    { name: "只有 front matter、没有正文的 SKILL.md", text: "---\nname: empty-body\n---\n" },
  ];

  for (const item of cases) {
    test(`${item.name} 在归一化阶段就报错`, () => {
      const skill = userSkill("empty-body", item.text);
      let thrown: unknown;
      try {
        normalizeCapabilities(snapshot({ userSkills: [skill] }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SourceLayoutError);
      const message = (thrown as Error).message;
      // The slug says which capability broke; the absolute path says which file to fix. The path is
      // diagnostic only and never reaches an emitted artifact.
      expect(message).toContain("empty-body");
      expect(message).toContain("/abs/skills/empty-body/SKILL.md");
    });
  }

  test("正文非空的技能不受影响", () => {
    const skill = userSkill("has-body", "---\nname: has-body\n---\n\n# Body\n");
    const result = normalizeCapabilities(snapshot({ userSkills: [skill] }));
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].instructions).toBe("# Body");
  });
});

// --------------------------------------------------------------------------------------------------
// Codex 审查意见修复的回归用例（#498）
// --------------------------------------------------------------------------------------------------

describe("包去重指纹包含随包技能的内容", () => {
  const PLUGIN: PluginJson = {
    name: "shared-pkg",
    expertType: "agent",
    agentName: "shared-pkg-agent",
    skills: ["./skills/shared"],
  };
  const AGENT_TEXT = "---\nname: shared-pkg-agent\n---\n\n同一份人设正文。\n";

  /** plugin.json 与 agents/*.md 完全一致、只有 SKILL.md 正文不同的两份下载。 */
  function build(dirName: string, skillBody: string): RawExpertPackage {
    return expertPackage({
      dirName,
      plugin: PLUGIN,
      agents: [{ id: "shared-pkg-agent", text: AGENT_TEXT }],
      skills: [packageSkill(dirName, "shared", `---\nname: shared\n---\n\n${skillBody}\n`)],
    });
  }

  test("plugin.json 与 agents 相同、SKILL.md 内容不同的两份下载不是重复包", () => {
    const first = build("pkg-alpha", "第一版技能正文。");
    const second = build("pkg-beta", "第二版技能正文，内容不同。");
    expect(packageFingerprint(first)).not.toBe(packageFingerprint(second));
    const result = normalizeCapabilities(snapshot({ packages: [first, second] }));
    // 人设身份只有一份（agent id 是主键，不重复产生），但两份技能正文都按内容保留，一个不少。
    expect(result.agents).toHaveLength(1);
    expect(result.skills).toHaveLength(2);
    const instructions = result.skills.map((skill) => skill.instructions);
    expect(instructions).toContain("第一版技能正文。");
    expect(instructions).toContain("第二版技能正文，内容不同。");
    // 折叠有记录，但理由说的是“仅技能内容不同”，而不是“重复下载”。
    const merged = result.dropped.find((item) => item.kind === "agent" && item.reason.includes("仅随包技能内容不同"));
    expect(merged).toBeDefined();
    expect(result.dropped.filter((item) => item.reason.includes("重复下载"))).toHaveLength(0);
  });

  test("内容完全一致的两份下载仍然整体折叠（既有行为不回退）", () => {
    const first = build("engineering-workflow-skills", "同一份正文。");
    const second = build("ex_eqoqYRT1NIwb", "同一份正文。");
    expect(packageFingerprint(first)).toBe(packageFingerprint(second));
    const result = normalizeCapabilities(snapshot({ packages: [first, second] }));
    expect(result.agents).toHaveLength(1);
    expect(result.skills).toHaveLength(1);
    expect(result.dropped.some((item) => item.reason.includes("重复下载"))).toBe(true);
  });
});

describe("团队成员用原 ID 查人设文档、用规范化 ID 输出", () => {
  test("plugin.json 里的 Demo_Lead 能查到 agents/Demo_Lead.md，输出的 id 是 demo-lead", () => {
    const result = normalizeCapabilities(
      snapshot({
        packages: [
          expertPackage({
            dirName: "demo-team",
            plugin: {
              name: "demo-team",
              expertType: "team",
              teamInfo: { leadAgent: "Demo_Lead", memberAgents: ["Demo_Mate"] },
            },
            agents: [
              { id: "Demo_Lead", text: "---\nname: Demo_Lead\n---\n\n负责人的完整人设正文。\n" },
              { id: "Demo_Mate", text: "---\nname: Demo_Mate\n---\n\n成员的完整人设正文。\n" },
            ],
          }),
        ],
      }),
    );
    const lead = result.agents.find((agent) => agent.id === "demo-lead");
    expect(lead).toBeDefined();
    // 修复前：按 kebab 之后的 "demo-lead" 查文档必然落空，system_prompt 退回元数据兜底；
    // 修复后：人设文档正文（不是兜底模板）成为 system_prompt 的主体。
    expect(lead?.systemPrompt).toContain("负责人的完整人设正文。");
    const mate = result.agents.find((agent) => agent.id === "demo-mate");
    expect(mate?.systemPrompt).toContain("成员的完整人设正文。");
  });
});

describe("没有 description 的技能仍得到非空 summary", () => {
  test("summary 从 SKILL.md 正文首段派生，而不是空串", () => {
    const result = normalizeCapabilities(
      snapshot({
        userSkills: [
          userSkill("bare-skill", "---\nname: bare-skill\n---\n\n把周报整理成一张表格。\n\n第二段说明。\n"),
        ],
      }),
    );
    const skill = result.skills[0];
    // server 侧 parseTenantSkills 用 requiredString 校验 summary：空串会拒绝整个包。
    expect(skill.summary.length).toBeGreaterThan(0);
    expect(skill.summary).toContain("把周报整理成一张表格");
  });

  test("有 description 时仍然优先用 description（既有行为不回退）", () => {
    const result = normalizeCapabilities(
      snapshot({
        userSkills: [
          userSkill(
            "with-description",
            "---\nname: with-description\ndescription: 声明的摘要。\n---\n\n正文首段。\n",
          ),
        ],
      }),
    );
    expect(result.skills[0].summary).toBe("声明的摘要。");
  });
});

describe("品牌清洗（L4-4）：只动品牌 fallback 与自我称呼，教学指令保留", () => {
  test("从句形态：删 fallback，保同行有效指令", () => {
    const line =
      "  1. 必须读取并遵循 `skills/frontend-slides/SKILL.md`；如果 WorkBuddy 已安装到 marketplace，也可读取 `~/.workbuddy/skills-marketplace/skills/frontend-slides/SKILL.md`。";
    const { text, hits } = sanitizeWorkbuddyRefs(line);
    expect(hits).toBe(1);
    expect(text).toBe("  1. 必须读取并遵循 `skills/frontend-slides/SKILL.md`");
  });

  test("整行 fallback：整行删除，不留空洞", () => {
    const { text, hits } = sanitizeWorkbuddyRefs(
      "先看正文。\n也可读取 ~/.workbuddy/skills/extra/SKILL.md\n再继续。",
    );
    expect(hits).toBe(1);
    expect(text).toBe("先看正文。\n再继续。");
  });

  test("团队描述自我称呼收窄为 Team Agent", () => {
    const { text, hits } = sanitizeWorkbuddyRefs(
      "Humanize PPT WorkBuddy Team Agent: AST outline first.",
    );
    expect(hits).toBe(1);
    expect(text).toBe("Humanize PPT Team Agent: AST outline first.");
  });

  test("有意义的教学提及不动，且函数幂等", () => {
    const body =
      "WorkBuddy 产品本体的设计系统在这里；交付物写到 .workbuddy/artifacts/。";
    const first = sanitizeWorkbuddyRefs(body);
    expect(first.hits).toBe(0);
    expect(first.text).toBe(body);
    expect(sanitizeWorkbuddyRefs(first.text).hits).toBe(0);
  });
});
