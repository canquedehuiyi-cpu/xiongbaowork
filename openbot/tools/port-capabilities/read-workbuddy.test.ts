/**
 * The reader's job is to report the layout as it is, so these tests build a miniature WorkBuddy home on
 * disk and assert on what comes back: which files are picked up, where the timestamps come from, and what
 * happens when the source tree is not what it claims to be.
 *
 * The fixture is deliberately shaped like the real install rather than like a convenient one: a package
 * with an opaque directory name, a package whose `plugin.json` omits `agents[]`, a skill with a `__skillhub`
 * suffix, a connector that is a local stdio command, and a stray non-skill directory that must be skipped.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { readConnector, readWorkBuddy, SourceLayoutError } from "./read-workbuddy";

const root = mkdtempSync(join(tmpdir(), "port-capabilities-read-"));

/** Write a file, creating parents. */
function write(relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

/** A minimal but structurally faithful `plugin.json`. */
function pluginJson(input: {
  name: string;
  version: string;
  expertType: "agent" | "team";
  agentName: string;
  agents?: string[];
  skills?: string[];
  members?: { id: string; role: string }[];
}): string {
  return `${JSON.stringify(
    {
      name: input.name,
      version: input.version,
      description: `${input.name} description`,
      expertType: input.expertType,
      agentName: input.agentName,
      ...(input.agents ? { agents: input.agents } : {}),
      ...(input.skills ? { skills: input.skills } : {}),
      ...(input.members ? { members: input.members } : {}),
    },
    null,
    2,
  )}\n`;
}

write(
  "plugins/marketplaces/experts/plugins/demo-team/.codebuddy-plugin/plugin.json",
  pluginJson({
    name: "demo-team",
    version: "1.0.0",
    expertType: "team",
    agentName: "demo-lead",
    skills: ["./skills/alpha"],
    members: [
      { id: "demo-lead", role: "lead" },
      { id: "demo-worker", role: "member" },
    ],
  }),
);
write("plugins/marketplaces/experts/plugins/demo-team/.downloaded_at", "2026-09-16T14:54:10.596Z\n");
write("plugins/marketplaces/experts/plugins/demo-team/agents/demo-lead.md", "---\nname: demo-lead\n---\n\nLead body.\n");
write(
  "plugins/marketplaces/experts/plugins/demo-team/agents/demo-worker.md",
  "---\nname: demo-worker\n---\n\nWorker body.\n",
);
write(
  "plugins/marketplaces/experts/plugins/demo-team/skills/alpha/SKILL.md",
  "---\nname: alpha\ndescription: Alpha skill.\n---\n\nAlpha body.\n",
);
write("plugins/marketplaces/experts/plugins/demo-team/skills/alpha/references/notes.md", "notes\n");

// A package that declares no agents[] and no skills[] at all, the way software-company ships.
write(
  "plugins/marketplaces/experts/plugins/undeclared/.codebuddy-plugin/plugin.json",
  pluginJson({ name: "undeclared", version: "0.1.0", expertType: "agent", agentName: "undeclared" }),
);
write("plugins/marketplaces/experts/plugins/undeclared/agents/undeclared.md", "Body without front matter.\n");

// A user-level skill with a channel suffix, a SkillHub install timestamp, and two attachment directories.
write("skills/token-master__skillhub/SKILL.md", "---\nname: token-efficient-dev\n---\n\nToken body.\n");
write("skills/token-master__skillhub/_skillhub_meta.json", `${JSON.stringify({ installedAt: 1_792_252_095_898 })}`);
write("skills/token-master__skillhub/references/one.md", "one\n");
write("skills/token-master__skillhub/scripts/run.py", "print(1)\n");

// Not a skill: no SKILL.md. Must be skipped without special-casing its name.
write("skills/.migration-state.json", "{}\n");

write(
  "connectors-marketplace/connectors/remote/mcp.json",
  `${JSON.stringify({ mcpServers: { remote: { url: "https://example.test/mcp/", timeout: 600 } } })}\n`,
);
write("connectors-marketplace/connectors/remote/skill/SKILL.md", "Attached install instructions.\n");
write(
  "connectors-marketplace/connectors/local/mcp.json",
  `${JSON.stringify({ mcpServers: { local: { command: "npx", args: ["-y", "some-server"] } } })}\n`,
);
write(
  "connectors-marketplace/connectors/unlisted/mcp.json",
  `${JSON.stringify({ mcpServers: { unlisted: { url: "https://unlisted.test/mcp/" } } })}\n`,
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readWorkBuddy", () => {
  const snapshot = readWorkBuddy({ sourceRoot: root, connectorAllowlist: ["local", "remote"] });

  test("reads every package and every skill directory, sorted by name", () => {
    expect(snapshot.packages.map((pkg) => pkg.dirName)).toEqual(["demo-team", "undeclared"]);
    expect(snapshot.userSkills.map((skill) => skill.dirName)).toEqual(["token-master__skillhub"]);
  });

  test("takes fetchedAt from .downloaded_at rather than from the clock", () => {
    const demo = snapshot.packages.find((pkg) => pkg.dirName === "demo-team");
    expect(demo?.fetchedAt).toBe("2026-09-16T14:54:10.596Z");
  });

  test("takes fetchedAt from _skillhub_meta.json installedAt", () => {
    const skill = snapshot.userSkills[0];
    expect(skill.fetchedAt).toBe(new Date(1_792_252_095_898).toISOString());
  });

  test("records attachment directories and whether references/ is one of them", () => {
    const skill = snapshot.userSkills[0];
    expect(skill.attachments).toEqual(["references", "scripts"]);
    expect(skill.hasReferencesDir).toBe(true);
    expect(skill.tier).toBe("user");
    expect(skill.packageDirName).toBeNull();
  });

  test("finds agent documents even when plugin.json declares none", () => {
    const undeclared = snapshot.packages.find((pkg) => pkg.dirName === "undeclared");
    expect(undeclared?.agents.map((doc) => doc.id)).toEqual(["undeclared"]);
    expect(undeclared?.skills).toEqual([]);
  });

  test("reads only the declared skills of a package", () => {
    const demo = snapshot.packages.find((pkg) => pkg.dirName === "demo-team");
    expect(demo?.skills.map((skill) => skill.dirName)).toEqual(["alpha"]);
    expect(demo?.skills[0].tier).toBe("package");
    expect(demo?.skills[0].packageDirName).toBe("demo-team");
  });

  test("uses posix paths relative to the WorkBuddy home", () => {
    const demo = snapshot.packages.find((pkg) => pkg.dirName === "demo-team");
    expect(demo?.pluginJson.relativePath).toBe("plugins/marketplaces/experts/plugins/demo-team/.codebuddy-plugin/plugin.json");
    expect(demo?.pluginJson.relativePath.includes("\\")).toBe(false);
  });

  test("does not open connectors outside the allowlist", () => {
    expect(snapshot.connectors.map((connector) => connector.id)).toEqual(["local", "remote"]);
  });

  test("distinguishes a remote url connector from a local stdio command", () => {
    const remote = snapshot.connectors.find((connector) => connector.id === "remote");
    const local = snapshot.connectors.find((connector) => connector.id === "local");
    expect(remote?.transport).toBe("url");
    expect(remote?.server.url).toBe("https://example.test/mcp/");
    expect(remote?.attachedSkillPaths).toEqual(["skill/SKILL.md"]);
    expect(local?.transport).toBe("command");
    expect(local?.server.command).toBe("npx");
  });

  test("returns null for a connector directory that does not exist", () => {
    expect(readConnector(root, "absent")).toBeNull();
  });
});

describe("readWorkBuddy failure modes", () => {
  test("refuses a missing source root", () => {
    expect(() => readWorkBuddy({ sourceRoot: join(root, "no-such-home") })).toThrow(SourceLayoutError);
  });

  test("refuses a source root with none of the three inputs, instead of writing an empty package", () => {
    const empty = mkdtempSync(join(tmpdir(), "port-capabilities-empty-"));
    try {
      expect(() => readWorkBuddy({ sourceRoot: empty })).toThrow(/nothing to port/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("reports invalid plugin.json as a layout error", () => {
    const broken = mkdtempSync(join(tmpdir(), "port-capabilities-broken-"));
    try {
      const packageRoot = join(broken, "plugins/marketplaces/experts/plugins/broken/.codebuddy-plugin");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, "plugin.json"), "{ not json", "utf8");
      expect(() => readWorkBuddy({ sourceRoot: broken })).toThrow(/not valid JSON/);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
