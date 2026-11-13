import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AllowEntry } from "../../scripts/brand/guard/allowlist";
import { segmentWords } from "../../scripts/brand/guard/artifact-words";
import { metricsTable } from "../../scripts/brand/metrics";
import {
  BUILD_PATH,
  canonical,
  scanDeb,
  scanImageConfig,
  scanImageFiles,
  scanLog,
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

describe("image and deb scans (Task 5)", () => {
  test("image-files: a word per path segment, own files found", () => {
    const root = dir();
    const list = join(root, "files.txt");
    writeFileSync(
      list,
      [
        "/etc/hosts",
        "/app/shared/openbot-actor.ts",
        "/usr/src/openbot/x.js",
        "/app/toolkit/src/copilotkit/agents.ts",
        "/usr/local/sbin/openbot-apt",
        "",
      ].join("\n"),
    );
    const found = scanImageFiles(list).found;
    expect([...found.keys()].sort()).toEqual([
      "copilotkit",
      "openbot",
      "openbot-actor.ts",
      "openbot-apt",
    ]);
  });

  test("image-files: a new version or hash of the same package says the same words", () => {
    const store = (version: string, hash: string) =>
      [
        `/app/node_modules/.bun/@copilotkit+shared@${version}+${hash}`,
        `/app/node_modules/.bun/@copilotkit+shared@${version}+${hash}/node_modules/@copilotkit/shared/package.json`,
        `/app/node_modules/.bun/copilotkit-cli@${version}+${hash}/node_modules/copilotkit-cli@${version}`,
        `/app/node_modules/.bun/@openbot+shared@${version}/node_modules/@openbot/shared`,
        `${hash}/node_modules/@copilotkit/runtime/dist/index.d.mts`,
      ].join("\n");
    const root = dir();
    const one = join(root, "one.txt");
    const two = join(root, "two.txt");
    writeFileSync(one, store("1.85.0", "232c2669fb60c3cc"));
    writeFileSync(two, store("1.86.0-next.3", "e95e36fcb715f04e"));
    const first = [...scanImageFiles(one).found.keys()].sort();
    expect(first).toEqual([...scanImageFiles(two).found.keys()].sort());
    expect(first).toEqual(["@copilotkit", "@openbot", "copilotkit-cli"]);
  });

  test("deb: string literals packed back to back are cut at the brand word and at `/`", () => {
    const text =
      "agent-desktop/opt/google/chrome/chrome/usr/bin/chromiumopenbot-runner/proc.configautostartxiongbao-device\n" +
      "shared/openbot-browser.ts\n@copilotkit/core@1.85.0\ndata-openbot-secret\n$openbotOut.AutoFlush\n";
    expect([...segmentWords(text).keys()]).toEqual([
      "openbot-runner",
      "openbot-browser.ts",
      "@copilotkit",
      "data-openbot-secret",
      "$openbotOut.AutoFlush",
    ]);
  });

  test("deb: a literal glued to an ALL-CAPS name, or a brand word glued to the one before it, is cut there", () => {
    const text =
      "openbot-runnerXIONGBAO_DESKTOP_ENGINEOPENBOT_DESKTOP_ENGINE\nfromOpenBot\nOpenBot\n";
    expect([...segmentWords(text).keys()]).toEqual([
      "openbot-runner",
      "OPENBOT_DESKTOP_ENGINE",
      "OpenBot",
    ]);
  });

  test("image-config: Config.Env and Config.Labels, nothing else", () => {
    const root = dir();
    const file = join(root, "inspect.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          Name: "/openbot-trackb",
          Config: {
            Env: ["OPENBOT_X=1", "PATH=/usr/bin"],
            Labels: { "ai.copilotkit.openbot.recorder": "v1" },
          },
        },
      ]),
    );
    const found = scanImageConfig(file).found;
    expect(found.has("OPENBOT_X")).toBe(true);
    expect(found.has("ai.copilotkit.openbot.recorder")).toBe(true);
    expect(found.has("/openbot-trackb")).toBe(false);
  });

  test("deb: the listing, every control field and the extracted files are scanned", () => {
    const root = dir();
    const tree = join(root, "pkg");
    mkdirSync(join(tree, "DEBIAN"), { recursive: true });
    mkdirSync(join(tree, "usr", "bin"), { recursive: true });
    mkdirSync(join(tree, "usr", "share", "doc"), { recursive: true });
    writeFileSync(
      join(tree, "DEBIAN", "control"),
      "Package: openbot-device\nVersion: 1.0.0\nArchitecture: amd64\nMaintainer: x <x@example.com>\nDescription: openbot-desc\n",
    );
    writeFileSync(
      join(tree, "usr", "bin", "xiongbao-runner"),
      Buffer.from(
        "\0/home/runner/work/x/x/openbot/node_modules/a\0copilotkit-inside\0/usr/bin/chromiumopenbot-runner/proc.configautostart\0@copilotkit/core@1.85.0\0",
      ),
    );
    writeFileSync(join(tree, "usr", "share", "doc", "openbot-doc.txt"), "hi\n");
    const deb = join(root, "out.deb");
    execFileSync("dpkg-deb", ["--build", "-Znone", tree, deb], {
      stdio: "ignore",
    });
    const scan = scanDeb(deb, "/home/runner/work/x/x/openbot");
    expect(scan.found.has("openbot-device")).toBe(true);
    expect(scan.found.has("openbot-desc")).toBe(true);
    expect(scan.found.has("copilotkit-inside")).toBe(true);
    // Rust packs its literals with nothing between them: only the name and its own segment are the word.
    expect(scan.found.has("openbot-runner")).toBe(true);
    expect(scan.found.has("@copilotkit")).toBe(true);
    expect([...scan.found.keys()].filter((w) => w.length > 40)).toEqual([]);
    expect(
      [...scan.found.keys()].some((w) => w.endsWith("openbot-doc.txt")),
    ).toBe(true);
    expect(scan.found.get(BUILD_PATH)).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("web on a log file: words only, no source map check", () => {
    const root = dir();
    const log = join(root, "startup.log");
    writeFileSync(log, "boot openbot\n//# sourceMappingURL=x.map\n");
    const scan = scanLog(log);
    expect(scan.problems).toEqual([]);
    expect(scan.found.has("openbot")).toBe(true);
  });

  test("the new baselines are committed as JSON lists", () => {
    for (const name of ["image-files", "image-config", "image-logs", "deb"]) {
      const list: unknown = JSON.parse(
        readFileSync(
          new URL(`./brand-artifacts/${name}.json`, import.meta.url),
          "utf8",
        ),
      );
      expect(Array.isArray(list), name).toBe(true);
    }
  });
});
