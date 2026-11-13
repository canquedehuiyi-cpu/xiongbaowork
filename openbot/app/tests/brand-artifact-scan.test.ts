import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AllowEntry } from "../../scripts/brand/guard/allowlist";
import { metricsTable } from "../../scripts/brand/metrics";
import {
  BUILD_PATH,
  canonical,
  scanRunner,
  scanWeb,
  summaryOf,
  verdict,
} from "../../scripts/brand/scan-artifact";

const dir = () => mkdtempSync(join(tmpdir(), "scan-"));
const entry = (word: string) => ({
  word,
  category: "operator-visible" as const,
  plan: "rewrite" as const,
  note: "x",
});

describe("scan-artifact", () => {
  test("a minifier's renamed local does not change the word", () => {
    expect(canonical("fromOpenBot:n")).toBe("fromOpenBot:_");
    expect(canonical("e.openbotUrl")).toBe("_.openbotUrl");
    expect(canonical("openbotUrl:xe")).toBe("openbotUrl:_");
    expect(canonical("docs.copilotkit.ai")).toBe("docs.copilotkit.ai");
    expect(canonical("ai.copilotkit.openbot.recorder")).toBe(
      "ai.copilotkit.openbot.recorder",
    );
  });

  test("failure lines name the kind, the word and which way it is wrong", () => {
    const root = dir();
    writeFileSync(
      join(root, "a.js"),
      `x="openbot-new";y="Powered by CopilotKit"`,
    );
    const scan = scanWeb(root);
    expect(scan.reported).toEqual(["Powered by CopilotKit"]);
    const failures = verdict("web", scan, [
      entry("openbot-gone"),
      entry("CopilotKit"),
    ]);
    expect(failures).toContain("web: openbot-new （多出来的）");
    expect(failures).toContain("web: openbot-gone （已经没了）");
    expect(summaryOf("web", scan, failures)).toContain("不失败");
    expect(
      verdict("web", scan, [entry("openbot-new"), entry("CopilotKit")]),
    ).toEqual([]);
  });

  test("web: a map file or a sourceMappingURL fails", () => {
    const root = dir();
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "a.js.map"), "{}");
    writeFileSync(join(root, "a.js"), "x\n//# sourceMappingURL=a.js.map");
    const problems = scanWeb(root).problems.join("\n");
    expect(problems).toContain("source map 文件");
    expect(problems).toContain("sourceMappingURL");
  });

  test("runner: the build machine's path is a word that must be listed", () => {
    const root = dir();
    const file = join(root, "bin");
    writeFileSync(
      file,
      Buffer.from(`\0/home/runner/work/x/x/openbot/node_modules/a\0`),
    );
    const scan = scanRunner(file, "/home/runner/work/x/x/openbot");
    expect(scan.found.get(BUILD_PATH)).toBe(1);
    expect(verdict("runner", scan, [])).toContain(
      `runner: ${BUILD_PATH} （多出来的）`,
    );
    expect(verdict("runner", scan, [entry(BUILD_PATH)])).toEqual([]);
  });

  test("the lists in the repo match the committed baselines' shape", () => {
    for (const name of ["web", "extension", "runner"]) {
      const list = JSON.parse(
        readFileSync(
          new URL(`./brand-artifacts/${name}.json`, import.meta.url),
          "utf8",
        ),
      ) as { word?: string; prefix?: string; category: string; plan: string }[];
      expect(list.length).toBeGreaterThan(0);
      expect(
        list.filter((e) => e.prefix && e.category !== "third-party-name"),
      ).toEqual([]);
    }
  });
});

describe("metrics", () => {
  const allow = (
    category: AllowEntry["category"],
    plan: AllowEntry["plan"],
  ): AllowEntry => ({
    file: "a.ts",
    text: "t",
    reason: "r",
    category,
    plan,
  });
  test("remaining work, permanent leftovers and the change against base", () => {
    const head = {
      allow: [
        allow("operator-visible", "rewrite"),
        allow("third-party-name", "keep"),
      ],
      budget: [{ rule: "identifier", scope: "app/src", lines: 3 }],
      words: { web: [entry("a")] },
    };
    const table = metricsTable(head, {
      allow: [
        allow("operator-visible", "rewrite"),
        allow("operator-visible", "rewrite"),
      ],
      budget: [{ rule: "identifier", scope: "app/src", lines: 5 }],
      words: { web: [entry("a"), entry("b")] },
    });
    expect(table).toContain("| 剩余工作量（rewrite + remove） | 1 | -1 |");
    expect(table).toContain("| 永久残留（keep） | 1 | +1 |");
    expect(table).toContain("| identifier | 3 | -2 |");
    expect(table).toContain("| web | 1 | -1 | - | 1 |");
  });
});
