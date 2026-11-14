/**
 * Tests for `l1-gate.ts` — the whitelist consumer of `capability-lock.yaml`.
 *
 * Pinned the way each rule could actually fail:
 *
 *   1. **Parse** — a lock rendered by the writer side parses back to the same entries; a lock with a
 *      bad version, an empty entry list, a traversal origin, a bad checksum, a missing §6.4 field, a
 *      dangling channel reference or a drifted entries_count is refused before any gate decision.
 *   2. **Gate order** — identity first (NOT_IN_LOCK), then the owner's exclusion list (checked even
 *      against a lock row that claims `redistributable: true`), then the flag itself, then the
 *      whitelist. The whitelist can only subtract: a `redistributable: false` row stays refused even
 *      when someone puts its slug on the list.
 *   3. **Checksum bridge** — the cached bytes of a locked unit must hash to the locked value; drift,
 *      tampering and a missing cache copy are all refused.
 *   4. **Two-table lockstep** — `CACHE_CHANNEL_ROOTS` must equal the `homePath` set in the fetch
 *      script, or the checksum assert verifies the wrong bytes.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertCacheEntryMatchesLock,
  buildL1Gate,
  CACHE_CHANNEL_ROOTS,
  ChecksumMismatchError,
  filterSnapshotByGate,
  isSafeLockOrigin,
  LockParseError,
  parseLockDocument,
  parseOfficialSkillUnitName,
  verifyAllowedUnits,
} from "./l1-gate";
import {
  directorySha256,
  fileSha256,
  type LockChannelProvenance,
  type LockDocument,
  type LockEntry,
  renderLockDocument,
} from "./lockfile";
import type { RawSkill, WorkBuddySnapshot } from "./read-workbuddy";

/** A valid entry, with every field the validator demands; tests mutate one field at a time. */
function validEntry(overrides: Partial<LockEntry> = {}): LockEntry {
  return {
    slug: "sample-package",
    kind: "expert-package",
    channel: "experts",
    origin: "plugins/sample-package",
    source: "local snapshot ~/.workbuddy/plugins/marketplaces/experts",
    source_url: "",
    source_version: "1.0.0",
    checksum_sha256: "a".repeat(64),
    license: "MIT",
    redistributable: false,
    attribution: "© Sample Author",
    fetched_at: "2026-11-12T09:08:24.213Z",
    ...overrides,
  };
}

function validChannels(): LockChannelProvenance[] {
  return [
    {
      id: "experts",
      source: "local snapshot ~/.workbuddy/plugins/marketplaces/experts",
      url: "",
      url_verified: false,
      version: "unspecified",
      index_checksum_sha256: "b".repeat(64),
      note: "专家市场快照",
    },
    {
      id: "official-plugins",
      source: "https://download.codebuddy.cn/plugin-marketplace/bundle.zip",
      url: "https://download.codebuddy.cn/plugin-marketplace/bundle.zip",
      url_verified: true,
      version: '"etag-value"',
      index_checksum_sha256: "c".repeat(64),
      note: "官方插件市场快照",
    },
    {
      id: "connectors",
      source: "local snapshot ~/.workbuddy/connectors-marketplace",
      url: "",
      url_verified: false,
      version: "unspecified",
      index_checksum_sha256: "d".repeat(64),
      note: "连接器市场快照",
    },
  ];
}

function validLock(entries: LockEntry[]): LockDocument {
  return {
    version: 2,
    phase: "p1-5",
    cache_dir: ".cache/capabilities",
    generated_from: "local-snapshot",
    fetched_at: "2026-11-12T09:08:24.213Z",
    channels: validChannels(),
    entries,
  };
}

describe("parseLockDocument", () => {
  test("a writer-side render parses back to the same entries", () => {
    const entries = [
      validEntry(),
      validEntry({
        slug: "github",
        kind: "connector",
        channel: "connectors",
        origin: "connectors/github/mcp.json",
        license: "unspecified",
        redistributable: false,
        attribution: "© 各连接器厂商（经 WorkBuddy 连接器市场收录）",
      }),
    ];
    const parsed = parseLockDocument(renderLockDocument(validLock(entries)));
    expect(parsed.version).toBe(2);
    expect(parsed.entries.length).toBe(2);
    expect(parsed.entries[0]).toEqual(entries[0]);
    expect(parsed.entries[1]).toEqual(entries[1]);
    expect(parsed.channels.map((channel) => channel.id)).toEqual([
      "experts",
      "official-plugins",
      "connectors",
    ]);
  });

  test("refuses a version the gate was not built for", () => {
    const text = renderLockDocument(validLock([validEntry()])).replace(
      "version: 2",
      "version: 3",
    );
    expect(() => parseLockDocument(text)).toThrow(/version 必须是 2/);
  });

  test("refuses an empty entry list", () => {
    const text = renderLockDocument(validLock([]));
    expect(() => parseLockDocument(text)).toThrow(/entries 必须是非空数组/);
  });

  test("refuses a traversal origin, an absolute path and a backslash", () => {
    // the writer refuses to render such rows, so mutate the rendered text instead
    const base = renderLockDocument(validLock([validEntry()]));
    for (const origin of ["../outside/pkg", "/etc/pkg", "plugins\\pkg"]) {
      const broken = base.replace('"plugins/sample-package"', JSON.stringify(origin));
      expect(() => parseLockDocument(broken)).toThrow(LockParseError);
    }
  });

  test("refuses a checksum that is not 64 lowercase hex", () => {
    const base = renderLockDocument(validLock([validEntry()]));
    const broken = base.replace(`"${"a".repeat(64)}"`, `"XYZ"`);
    expect(broken).toContain('"XYZ"');
    expect(() => parseLockDocument(broken)).toThrow(LockParseError);
  });

  test("refuses a row missing a §6.4 licence field (writer-side validator re-run)", () => {
    // hand-built text: the writer refuses to render a licence-incomplete row, so parse must refuse
    // it too — that is the second-lock property under test. The entry line drops the licence field;
    // the assertValidLockEntries re-run inside parse is what must fire.
    const base = renderLockDocument(validLock([validEntry()]));
    const broken = base
      .split("\n")
      .map((line) =>
        line.startsWith("  - {")
          ? line.replace(/license: "[^"]*", /, "")
          : line,
      )
      .join("\n");
    expect(broken).not.toContain("license:");
    expect(() => parseLockDocument(broken)).toThrow(/capability-lock 校验失败/);
  });

  test("refuses an entry whose channel is not declared in the header", () => {
    // render with a header that omits the connectors channel, then include a connectors entry:
    // the writer does not cross-check entry channels against the header, parse must.
    const header = validChannels().filter((c) => c.id !== "connectors");
    const doc: LockDocument = {
      ...validLock([
        validEntry({ channel: "connectors", kind: "connector", origin: "connectors/github/mcp.json" }),
      ]),
      channels: header,
    };
    const text = renderLockDocument(doc);
    expect(() => parseLockDocument(text)).toThrow(/未声明的通道/);
  });

  test("refuses an entries_count that disagrees with the entry list", () => {
    const text = renderLockDocument(validLock([validEntry()])).replace(
      "entries_count: 1",
      "entries_count: 7",
    );
    expect(() => parseLockDocument(text)).toThrow(/entries_count/);
  });

  test("refuses text that is not YAML at all", () => {
    expect(() => parseLockDocument("\t{{{{ nope")).toThrow(LockParseError);
  });
});

describe("isSafeLockOrigin", () => {
  test("accepts relative posix paths, refuses everything that could escape", () => {
    expect(isSafeLockOrigin("connectors/github/mcp.json")).toBe(true);
    expect(isSafeLockOrigin("plugins/sample-package")).toBe(true);
    expect(isSafeLockOrigin("")).toBe(false);
    expect(isSafeLockOrigin("/abs")).toBe(false);
    expect(isSafeLockOrigin("C:/abs")).toBe(false);
    expect(isSafeLockOrigin("a/../b")).toBe(false);
    expect(isSafeLockOrigin("a//b")).toBe(false);
    expect(isSafeLockOrigin("a\\b")).toBe(false);
    expect(isSafeLockOrigin("plugins/chainguard/")).toBe(true); // trailing slash: tolerated
    expect(isSafeLockOrigin(42)).toBe(false);
  });
});

describe("buildL1Gate — rule order", () => {
  // An excluded slug mis-recorded as redistributable: the writer refuses to emit such a lock,
  // but the gate must refuse it too if a hand-edited document ever arrives.
  const entries = [
    validEntry({ slug: "clear-mit", redistributable: true }),
    validEntry({
      slug: "unclear-connector",
      kind: "connector",
      channel: "connectors",
      origin: "connectors/unclear/mcp.json",
    }),
    validEntry({
      slug: "guizang-ppt-skill",
      kind: "skill",
      channel: "experts",
      origin: "plugins/humanize-ppt-team/skills/guizang-ppt-skill",
      license: "AGPL-3.0",
      redistributable: true,
    }),
  ];

  test("an unknown unit is refused before any licence rule runs", () => {
    const decision = buildL1Gate(validLock(entries)).decide("ghost", "skill");
    expect(decision.code).toBe("NOT_IN_LOCK");
    expect(decision.entry).toBeUndefined();
  });

  test("the exclusion list wins over a mis-recorded redistributable flag", () => {
    const decision = buildL1Gate(validLock(entries)).decide(
      "guizang-ppt-skill",
      "skill",
    );
    expect(decision.code).toBe("LICENSE_EXCLUDED");
    expect(decision.reason).toContain("owner 排除清单");
  });

  test("redistributable: false is refused even without a whitelist", () => {
    const decision = buildL1Gate(validLock(entries)).decide(
      "unclear-connector",
      "connector",
    );
    expect(decision.code).toBe("NOT_REDISTRIBUTABLE");
    expect(decision.reason).toContain("redistributable: false");
  });

  test("a licence-clean unit is allowed, carrying its lock entry", () => {
    const decision = buildL1Gate(validLock(entries)).decide(
      "clear-mit",
      "expert-package",
    );
    expect(decision.code).toBe("ALLOWED");
    expect(decision.entry?.slug).toBe("clear-mit");
  });

  test("the whitelist narrows but never widens", () => {
    // unclear-connector is on the whitelist yet redistributable: false — still refused.
    const gate = buildL1Gate(validLock(entries), [
      "unclear-connector",
      "clear-mit",
    ]);
    expect(gate.decide("unclear-connector", "connector").code).toBe(
      "NOT_REDISTRIBUTABLE",
    );
    expect(gate.decide("clear-mit", "expert-package").code).toBe("ALLOWED");
    // clear-mit passes the licence rules but not this narrower whitelist.
    const narrow = buildL1Gate(validLock(entries), ["other-slug"]);
    expect(narrow.decide("clear-mit", "expert-package").code).toBe(
      "NOT_WHITELISTED",
    );
  });

  test("stats and the decision cache agree with what was asked", () => {
    const gate = buildL1Gate(validLock(entries));
    gate.decide("clear-mit", "expert-package");
    gate.decide("clear-mit", "expert-package"); // cached, not double-counted
    gate.decide("ghost", "skill");
    expect(gate.stats).toEqual({ asked: 2, allowed: 1, refused: 1 });
    expect(gate.decisions.get("expert-package:clear-mit")?.code).toBe("ALLOWED");
  });
});

describe("assertCacheEntryMatchesLock", () => {
  test("a matching file unit passes and returns the verified path", () => {
    const dir = mkdtempSync(join(tmpdir(), "l1gate-file-"));
    try {
      const unit = join(
        dir,
        "connectors-marketplace/connectors/github/mcp.json",
      );
      mkdirSync(join(unit, ".."), { recursive: true });
      writeFileSync(unit, '{"mcpServers":{}}\n');
      const entries = [
        validEntry({
          slug: "github",
          kind: "connector",
          channel: "connectors",
          origin: "connectors/github/mcp.json",
          checksum_sha256: fileSha256(unit),
        }),
      ];
      const gate = buildL1Gate(validLock(entries));
      const verified = assertCacheEntryMatchesLock(
        gate,
        dir,
        "github",
        "connector",
      );
      expect(verified).toBe(unit);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a matching directory unit passes; a tampered copy is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "l1gate-dir-"));
    try {
      const unit = join(
        dir,
        "plugins/marketplaces/experts/plugins/sample-package",
      );
      mkdirSync(unit, { recursive: true });
      writeFileSync(join(unit, "SKILL.md"), "# sample\n");
      const entries = [
        validEntry({ checksum_sha256: directorySha256(unit) }),
      ];
      const gate = buildL1Gate(validLock(entries));
      expect(
        assertCacheEntryMatchesLock(gate, dir, "sample-package", "expert-package"),
      ).toBe(unit);
      // tamper: one extra byte changes the directory hash
      writeFileSync(join(unit, "SKILL.md"), "# sample tampered\n");
      expect(() =>
        assertCacheEntryMatchesLock(gate, dir, "sample-package", "expert-package"),
      ).toThrow(ChecksumMismatchError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing cache copy is a mismatch, not a silent skip", () => {
    const dir = mkdtempSync(join(tmpdir(), "l1gate-miss-"));
    try {
      const gate = buildL1Gate(validLock([validEntry({ checksum_sha256: "e".repeat(64) })]));
      expect(() =>
        assertCacheEntryMatchesLock(gate, dir, "sample-package", "expert-package"),
      ).toThrow(/缓存副本不存在/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a unit that is not in the lock throws before any path is touched", () => {
    const gate = buildL1Gate(validLock([validEntry()]));
    expect(() =>
      assertCacheEntryMatchesLock(gate, "/tmp", "ghost", "skill"),
    ).toThrow(/NOT_IN_LOCK/);
  });
});

describe("CACHE_CHANNEL_ROOTS stays in lockstep with the fetch script", () => {
  test("every channel's cache root equals the fetch script's homePath", () => {
    const fetchSource = readFileSync(
      join(import.meta.dir, "..", "..", "scripts", "fetch-capabilities.ts"),
      "utf8",
    );
    for (const [channelId, cacheRoot] of Object.entries(CACHE_CHANNEL_ROOTS)) {
      const match = fetchSource.match(
        new RegExp(`id: "${channelId}",\\s*homePath: "([^"]+)"`),
      );
      expect(match).not.toBeNull();
      expect(match![1]).toBe(cacheRoot);
    }
  });
});

/** A minimal snapshot skill unit; the gate only reads `dirName`. */
function skillUnit(dirName: string): RawSkill {
  return {
    dirName,
    skillMd: { path: "SKILL.md", content: "# x\n" } as unknown as RawSkill["skillMd"],
    attachments: [],
    hasReferencesDir: false,
    referencesBytes: 0,
    fetchedAt: "2026-11-14T00:00:00.000Z",
    tier: "user",
    packageDirName: null,
  };
}

function snapshotWith(...skills: RawSkill[]): WorkBuddySnapshot {
  return { sourceRoot: "/fake-source", packages: [], userSkills: skills, connectors: [] };
}

/** A redistributable official-plugin row, the granularity flattened skill units map to. */
function officialPluginEntry(overrides: Partial<LockEntry> = {}): LockEntry {
  return validEntry({
    slug: "all-skills",
    kind: "official-plugin",
    channel: "official-plugins",
    origin: "plugins/all-skills",
    redistributable: true,
    ...overrides,
  });
}

describe("parseOfficialSkillUnitName", () => {
  test("splits a flattened unit into plugin slug and skill sub-path", () => {
    expect(parseOfficialSkillUnitName("all-skills--skills--artifacts-builder")).toEqual({
      pluginSlug: "all-skills",
      subpath: "artifacts-builder",
    });
  });

  test("folds nested sub-paths back to slashes", () => {
    expect(parseOfficialSkillUnitName("pkg--skills--nested--deep")).toEqual({
      pluginSlug: "pkg",
      subpath: "nested/deep",
    });
  });

  test("returns undefined for plain skills, whole plugins and degenerate names", () => {
    expect(parseOfficialSkillUnitName("agent-browser")).toBeUndefined();
    expect(parseOfficialSkillUnitName("some-skill-row")).toBeUndefined();
    expect(parseOfficialSkillUnitName("--skills--trailing")).toBeUndefined();
    expect(parseOfficialSkillUnitName("plugin--skills--")).toBeUndefined();
    expect(parseOfficialSkillUnitName("")).toBeUndefined();
  });
});

describe("official-plugin skill mapping and skill-level whitelist", () => {
  test("a flattened unit maps to its plugin row and is allowed without a whitelist", () => {
    const gate = buildL1Gate(validLock([officialPluginEntry()]));
    const gated = filterSnapshotByGate(
      snapshotWith(skillUnit("all-skills--skills--artifacts-builder")),
      gate,
    );
    expect(gated.snapshot.userSkills).toHaveLength(1);
    expect(gated.stats.byCode.ALLOWED).toBe(1);
    const decision = gate.decisions.get("official-plugin:all-skills#artifacts-builder");
    expect(decision?.code).toBe("ALLOWED");
    expect(decision?.entry?.slug).toBe("all-skills");
  });

  test("a real-shaped unit name maps too (plugin without 'skills' in its own name)", () => {
    const gate = buildL1Gate(
      validLock([
        officialPluginEntry({ slug: "accessibility-compliance", origin: "external_plugins/accessibility-compliance" }),
      ]),
    );
    const gated = filterSnapshotByGate(
      snapshotWith(skillUnit("accessibility-compliance--skills--screen-reader-testing")),
      gate,
    );
    expect(gated.snapshot.userSkills).toHaveLength(1);
  });

  test("a skill-level whitelist entry allows only the listed sub-path", () => {
    const gate = buildL1Gate(validLock([officialPluginEntry()]), [
      "all-skills/artifacts-builder",
    ]);
    const gated = filterSnapshotByGate(
      snapshotWith(
        skillUnit("all-skills--skills--artifacts-builder"),
        skillUnit("all-skills--skills--file-organizer"),
      ),
      gate,
    );
    expect(gated.snapshot.userSkills.map((skill) => skill.dirName)).toEqual([
      "all-skills--skills--artifacts-builder",
    ]);
    const refused = gated.dropped.find((dropped) =>
      dropped.unit.endsWith("file-organizer"),
    );
    expect(refused?.code).toBe("NOT_WHITELISTED");
    expect(refused?.reason).toContain("只放行 [artifacts-builder]");
  });

  test("a plain whitelist entry still admits every skill of the package", () => {
    const gate = buildL1Gate(validLock([officialPluginEntry()]), ["all-skills"]);
    const gated = filterSnapshotByGate(
      snapshotWith(
        skillUnit("all-skills--skills--artifacts-builder"),
        skillUnit("all-skills--skills--file-organizer"),
      ),
      gate,
    );
    expect(gated.snapshot.userSkills).toHaveLength(2);
  });

  test("a package listed only through sub-paths refuses the whole-package unit", () => {
    const gate = buildL1Gate(validLock([officialPluginEntry()]), [
      "all-skills/artifacts-builder",
    ]);
    // The whole-plugin unit (a plugin whose own directory is one skill) is not any listed sub-path.
    expect(gate.decide("all-skills", "official-plugin").code).toBe("NOT_WHITELISTED");
    // …while its listed skill still passes.
    expect(
      gate.decideOfficialPluginSkill("all-skills--skills--artifacts-builder", {
        pluginSlug: "all-skills",
        subpath: "artifacts-builder",
      }).code,
    ).toBe("ALLOWED");
  });

  test("the licence rules run at plugin granularity before any whitelist narrowing", () => {
    const gate = buildL1Gate(
      validLock([officialPluginEntry({ redistributable: false })]),
      ["all-skills/artifacts-builder"],
    );
    expect(
      gate.decideOfficialPluginSkill("all-skills--skills--artifacts-builder", {
        pluginSlug: "all-skills",
        subpath: "artifacts-builder",
      }).code,
    ).toBe("NOT_REDISTRIBUTABLE");
    const excluded = buildL1Gate(
      validLock([officialPluginEntry({ slug: "taskmaster", origin: "plugins/taskmaster" })]),
      ["taskmaster/anything"],
    );
    expect(
      excluded.decideOfficialPluginSkill("taskmaster--skills--anything", {
        pluginSlug: "taskmaster",
        subpath: "anything",
      }).code,
    ).toBe("LICENSE_EXCLUDED");
  });

  test("a flattened unit whose plugin is not in the lock stays NOT_IN_LOCK (fail-closed)", () => {
    const gate = buildL1Gate(validLock([officialPluginEntry()]));
    const gated = filterSnapshotByGate(
      snapshotWith(skillUnit("ghost-plugin--skills--secret")),
      gate,
    );
    expect(gated.snapshot.userSkills).toHaveLength(0);
    expect(gated.dropped[0]?.code).toBe("NOT_IN_LOCK");
  });
});

describe("whitelist entry validation", () => {
  test("refuses empty entries and malformed sub-paths before any decision", () => {
    const lock = validLock([officialPluginEntry()]);
    expect(() => buildL1Gate(lock, [""])).toThrow(/白名单条目不能为空/);
    expect(() => buildL1Gate(lock, ["pkg/"])).toThrow(/白名单条目格式非法/);
    expect(() => buildL1Gate(lock, ["pkg//x"])).toThrow(/白名单条目格式非法/);
    expect(() => buildL1Gate(lock, ["pkg sub"])).toThrow(/白名单条目格式非法/);
  });

  test("an empty whitelist refuses everything it is asked about", () => {
    const gate = buildL1Gate(validLock([officialPluginEntry()]), []);
    expect(gate.decide("all-skills", "official-plugin").code).toBe("NOT_WHITELISTED");
  });
});

describe("verifyAllowedUnits — batch byte closure of the gate", () => {
  /** Build a fake fetch cache holding one official plugin with two skills. */
  function cacheWithPlugin(): { dir: string; pluginRoot: string } {
    const dir = mkdtempSync(join(tmpdir(), "l1gate-verify-"));
    const pluginRoot = join(
      dir,
      "plugins/marketplaces/codebuddy-plugins-official/plugins/all-skills",
    );
    mkdirSync(join(pluginRoot, "skills/artifacts-builder"), { recursive: true });
    writeFileSync(join(pluginRoot, "skills/artifacts-builder/SKILL.md"), "# a\n");
    mkdirSync(join(pluginRoot, "skills/file-organizer"), { recursive: true });
    writeFileSync(join(pluginRoot, "skills/file-organizer/SKILL.md"), "# b\n");
    return { dir, pluginRoot };
  }

  test("two mapped units of one plugin verify the plugin row exactly once", () => {
    const { dir, pluginRoot } = cacheWithPlugin();
    try {
      const lock = validLock([
        officialPluginEntry({ checksum_sha256: directorySha256(pluginRoot) }),
      ]);
      const gate = buildL1Gate(lock);
      const gated = filterSnapshotByGate(
        snapshotWith(
          skillUnit("all-skills--skills--artifacts-builder"),
          skillUnit("all-skills--skills--file-organizer"),
        ),
        gate,
      );
      const verification = verifyAllowedUnits(gated, gate, dir, { strict: true });
      expect(verification.verified).toBe(1);
      expect(verification.warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drifted bytes are refused even though the gate allowed the unit", () => {
    const { dir, pluginRoot } = cacheWithPlugin();
    try {
      const lock = validLock([
        officialPluginEntry({ checksum_sha256: directorySha256(pluginRoot) }),
      ]);
      const gate = buildL1Gate(lock);
      const gated = filterSnapshotByGate(
        snapshotWith(skillUnit("all-skills--skills--artifacts-builder")),
        gate,
      );
      writeFileSync(join(pluginRoot, "skills/artifacts-builder/SKILL.md"), "# tampered\n");
      expect(() => verifyAllowedUnits(gated, gate, dir, { strict: true })).toThrow(
        ChecksumMismatchError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("strict mode (fetch cache) treats a missing unit root as fatal; home mode warns", () => {
    const lock = validLock([officialPluginEntry()]);
    const gate = buildL1Gate(lock);
    const gated = filterSnapshotByGate(
      snapshotWith(skillUnit("all-skills--skills--artifacts-builder")),
      gate,
    );
    const empty = mkdtempSync(join(tmpdir(), "l1gate-empty-"));
    try {
      expect(() => verifyAllowedUnits(gated, gate, empty, { strict: true })).toThrow(
        /缓存副本不存在/,
      );
      const homeMode = verifyAllowedUnits(gated, gate, empty, { strict: false });
      expect(homeMode.verified).toBe(0);
      expect(homeMode.warnings).toHaveLength(1);
      expect(homeMode.warnings[0]).toContain("official-plugin/all-skills");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("expert packages and connectors verify through the same path", () => {
    const dir = mkdtempSync(join(tmpdir(), "l1gate-mixed-"));
    try {
      const pkgRoot = join(dir, "plugins/marketplaces/experts/plugins/sample-package");
      mkdirSync(pkgRoot, { recursive: true });
      writeFileSync(join(pkgRoot, "plugin.json"), "{}\n");
      const connectorFile = join(dir, "connectors-marketplace/connectors/github/mcp.json");
      mkdirSync(join(connectorFile, ".."), { recursive: true });
      writeFileSync(connectorFile, '{"mcpServers":{}}\n');
      const lock = validLock([
        validEntry({ redistributable: true, checksum_sha256: directorySha256(pkgRoot) }),
        validEntry({
          slug: "github",
          kind: "connector",
          channel: "connectors",
          origin: "connectors/github/mcp.json",
          redistributable: true,
          checksum_sha256: fileSha256(connectorFile),
        }),
      ]);
      const gate = buildL1Gate(lock);
      const snapshot: WorkBuddySnapshot = {
        sourceRoot: dir,
        packages: [
          {
            dirName: "sample-package",
            pluginJson: { path: "plugin.json", content: "{}\n" } as never,
            plugin: {} as never,
            agents: [],
            skills: [],
            attachments: [],
            fetchedAt: "2026-11-14T00:00:00.000Z",
          } as never,
        ],
        userSkills: [],
        connectors: [
          {
            id: "github",
            dirName: "github",
            mcpJson: { path: "mcp.json", content: "{}\n" } as never,
            server: {} as never,
          } as never,
        ],
      };
      const gated = filterSnapshotByGate(snapshot, gate);
      const verification = verifyAllowedUnits(gated, gate, dir, { strict: true });
      expect(verification.verified).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
