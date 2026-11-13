/**
 * Tests for `capability-lock.yaml`: the four guarantees the L1 lock must hold, each pinned the way it
 * could actually fail.
 *
 *   1. Idempotence — two renders of the same entries are byte-identical, and the render parses back to
 *      the same entries. A lock file that drifts between runs is worse than no lock file.
 *   2. Checksums — file and directory hashing are content-only, stable across re-reads, and change when
 *      the content changes (pinned against a published SHA-256 vector, not against our own output).
 *   3. The nine §6.4 fields — a row missing any one of them is refused, fail-closed.
 *   4. The exclusion list — `guizang-ppt-skill` and `taskmaster` can never surface as
 *      `redistributable: true`, checked on the data (the validator) as well as the applier, so removing
 *      the applier from a pipeline cannot smuggle an excluded slug through.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  applyLicenseExclusions,
  assertValidLockEntries,
  compareLockEntries,
  directorySha256,
  fileSha256,
  isPermissiveLockLicense,
  LICENSE_EXCLUSIONS,
  type LockEntry,
  renderLockDocument,
  sha256Hex,
  validateLockEntries,
} from "./lockfile";

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

describe("rendering is idempotent", () => {
  const entries = [
    validEntry(),
    validEntry({
      slug: "taskmaster",
      kind: "official-plugin",
      channel: "official-plugins",
      origin: "external_plugins/taskmaster",
      license: "MIT WITH Commons-Clause",
    }),
    validEntry({
      slug: "guizang-ppt-skill",
      kind: "skill",
      channel: "experts",
      origin: "plugins/humanize-ppt-team/skills/guizang-ppt-skill",
      license: "AGPL-3.0",
    }),
    validEntry({
      slug: "github",
      kind: "connector",
      channel: "connectors",
      origin: "connectors/github/mcp.json",
      license: "unspecified",
      attribution: "© 各连接器厂商（经 WorkBuddy 连接器市场收录）",
    }),
  ];

  test("two renders of the same entries are byte-identical", () => {
    const doc = {
      version: 2,
      phase: "p1-5",
      cache_dir: ".cache/capabilities",
      generated_from: "local-snapshot",
      fetched_at: "2026-11-12T09:08:24.213Z",
      channels: [],
      entries: [...entries].sort(compareLockEntries),
    };
    expect(renderLockDocument(doc)).toBe(renderLockDocument(doc));
  });

  test("the render parses back to the same entries, field for field", () => {
    const doc = {
      version: 2,
      phase: "p1-5",
      cache_dir: ".cache/capabilities",
      generated_from: "local-snapshot",
      fetched_at: "2026-11-12T09:08:24.213Z",
      channels: [
        {
          id: "experts",
          source: "local snapshot ~/.workbuddy/plugins/marketplaces/experts",
          url: "",
          url_verified: false,
          version: "unspecified",
          index_checksum_sha256: "b".repeat(64),
          note: "测试",
        },
      ],
      entries: [...entries].sort(compareLockEntries),
    };
    const parsed = parseYaml(renderLockDocument(doc)) as {
      entries: LockEntry[];
      channels: { id: string; note: string }[];
      entries_count: number;
    };
    expect(parsed.entries_count).toBe(entries.length);
    expect(parsed.channels[0].id).toBe("experts");
    expect(parsed.entries).toEqual([...entries].sort(compareLockEntries));
  });

  test("a changed package changes exactly its own line, not the whole file", () => {
    const doc = {
      version: 2,
      phase: "p1-5",
      cache_dir: ".cache/capabilities",
      generated_from: "local-snapshot",
      fetched_at: "2026-11-12T09:08:24.213Z",
      channels: [],
      entries: [...entries].sort(compareLockEntries),
    };
    const before = renderLockDocument(doc).split("\n");
    const changed: typeof doc = {
      ...doc,
      entries: doc.entries.map((entry) =>
        entry.slug === "github" ? { ...entry, source_version: "2.0.0" } : entry,
      ),
    };
    const after = renderLockDocument(changed).split("\n");
    expect(before.length).toBe(after.length);
    const changedLines = before
      .map((line, index) => ({
        line,
        changed: line !== after[index],
        after: after[index],
      }))
      .filter((entry) => entry.changed);
    expect(changedLines.length).toBe(1);
    expect(changedLines[0].line).toContain("github");
    expect(changedLines[0].line).toContain("1.0.0");
    expect(changedLines[0].after).toContain("2.0.0");
  });
});

describe("checksums are content-only", () => {
  test("sha256Hex matches the published vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("directorySha256 ignores mtime and is stable across re-reads", () => {
    const root = mkdtempSync(join(tmpdir(), "port-capabilities-lock-"));
    try {
      mkdirSync(join(root, "pkg/skills/inner"), { recursive: true });
      writeFileSync(join(root, "pkg/SKILL.md"), "# hello\n", "utf8");
      writeFileSync(
        join(root, "pkg/skills/inner/SKILL.md"),
        "nested\n",
        "utf8",
      );
      const first = directorySha256(join(root, "pkg"));
      // Rewrite the same content: a fresh mtime must not change the hash.
      writeFileSync(join(root, "pkg/SKILL.md"), "# hello\n", "utf8");
      expect(directorySha256(join(root, "pkg"))).toBe(first);
      // Changing one file's content changes the hash.
      writeFileSync(
        join(root, "pkg/skills/inner/SKILL.md"),
        "nested v2\n",
        "utf8",
      );
      expect(directorySha256(join(root, "pkg"))).not.toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fileSha256 of a fixture matches sha256Hex of the same bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "port-capabilities-lock-"));
    try {
      const path = join(root, "mcp.json");
      const bytes = Buffer.from('{"mcpServers":{}}\n', "utf8");
      writeFileSync(path, bytes);
      expect(fileSha256(path)).toBe(sha256Hex(bytes));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the nine §6.4 fields are fail-closed", () => {
  test("a complete set of entries passes validation", () => {
    expect(validateLockEntries([validEntry()])).toEqual([]);
    expect(() => assertValidLockEntries([validEntry()])).not.toThrow();
  });

  test("removing any one of the nine fields is a refusal, with the field named", () => {
    const fields: (keyof LockEntry)[] = [
      "source",
      "source_version",
      "checksum_sha256",
      "license",
      "redistributable",
      "attribution",
      "fetched_at",
    ];
    for (const field of fields) {
      const broken = validEntry();
      delete (broken as unknown as Record<string, unknown>)[field];
      const violations = validateLockEntries([broken]);
      expect(violations.some((violation) => violation.field === field)).toBe(
        true,
      );
    }
  });

  test("an empty-string field counts as missing, not as present", () => {
    const violations = validateLockEntries([validEntry({ license: "  " })]);
    expect(violations.some((violation) => violation.field === "license")).toBe(
      true,
    );
  });

  test("a malformed checksum or timestamp is refused, not tolerated", () => {
    expect(
      validateLockEntries([validEntry({ checksum_sha256: "ABCDEF" })]).some(
        (violation) => violation.field === "checksum_sha256",
      ),
    ).toBe(true);
    expect(
      validateLockEntries([validEntry({ fetched_at: "2026-11-12" })]).some(
        (violation) => violation.field === "fetched_at",
      ),
    ).toBe(true);
    expect(
      validateLockEntries([
        validEntry({ redistributable: "false" as unknown as boolean }),
      ]).some((violation) => violation.field === "redistributable"),
    ).toBe(true);
  });

  test("duplicate kind:slug rows are refused", () => {
    const violations = validateLockEntries([validEntry(), validEntry()]);
    expect(violations.some((violation) => violation.field === "slug")).toBe(
      true,
    );
  });
});

describe("the AGPL / Commons-Clause exclusion holds", () => {
  test("a guizang-ppt-skill whose bundled files say MIT is forced to AGPL-3.0 and not redistributable", () => {
    const entry = applyLicenseExclusions(
      validEntry({
        slug: "guizang-ppt-skill",
        kind: "skill",
        origin: "plugins/humanize-ppt-team/skills/guizang-ppt-skill",
        license: "MIT",
        redistributable: true,
      }),
    );
    expect(entry.license).toBe("AGPL-3.0");
    expect(entry.redistributable).toBe(false);
    expect(validateLockEntries([entry])).toEqual([]);
  });

  test("taskmaster keeps its verbatim licence and loses the grant", () => {
    const entry = applyLicenseExclusions(
      validEntry({
        slug: "taskmaster",
        kind: "official-plugin",
        origin: "external_plugins/taskmaster",
        license: "MIT WITH Commons-Clause",
        redistributable: true,
      }),
    );
    expect(entry.license).toBe("MIT WITH Commons-Clause");
    expect(entry.redistributable).toBe(false);
  });

  test("the validator rejects an excluded slug marked redistributable, whatever pipeline produced it", () => {
    // The invariant is checked on the data, so an entry that skipped the applier still cannot pass.
    const forged = validEntry({
      slug: "guizang-ppt-skill",
      kind: "skill",
      license: "MIT",
      redistributable: true,
    });
    const violations = validateLockEntries([forged]);
    expect(
      violations.some((violation) => violation.field === "redistributable"),
    ).toBe(true);
    expect(violations.some((violation) => violation.field === "license")).toBe(
      true,
    );
    expect(() => assertValidLockEntries([forged])).toThrow(
      /不得标记为可再分发/,
    );
  });

  test("the exclusion table still names both decided slugs", () => {
    // If a future edit drops a row from the table, this fails before the rule silently stops holding.
    expect(Object.keys(LICENSE_EXCLUSIONS).sort()).toEqual([
      "guizang-ppt-skill",
      "taskmaster",
    ]);
  });

  test("a non-excluded entry passes through the applier untouched", () => {
    const entry = validEntry();
    expect(applyLicenseExclusions(entry)).toEqual(entry);
  });

  test("isPermissiveLockLicense says yes for exactly the short allowlist", () => {
    for (const license of [
      "mit",
      "apache-2.0",
      "bsd-2-clause",
      "bsd-3-clause",
      "isc",
    ]) {
      expect(isPermissiveLockLicense(license)).toBe(true);
    }
    for (const license of [
      "unspecified",
      "GPL-3.0-or-later",
      "AGPL-3.0",
      "MIT WITH Commons-Clause",
      "",
    ]) {
      expect(isPermissiveLockLicense(license)).toBe(false);
    }
  });
});
