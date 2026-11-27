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
import { segmentWords } from "../../scripts/brand/guard/artifact-words";
import {
  LIBRARY,
  LIBRARY_LOWER,
  OLD_ENV_PREFIX,
  OLD_PRODUCT,
  OLD_PRODUCT_LOWER,
} from "../../scripts/brand/guard/words";
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

// The old names, short, from the one place that spells them (words.ts).
const E = OLD_ENV_PREFIX;
const P = OLD_PRODUCT;
const O = OLD_PRODUCT_LOWER;
const LP = LIBRARY;
const L = LIBRARY_LOWER;

const dir = () => mkdtempSync(join(tmpdir(), "scan-"));
const entry = (word: string) => ({
  word,
  category: "kept" as const,
  note: "x",
});

describe("scan-artifact", () => {
  test("a minifier's renamed local does not change the word", () => {
    expect(canonical(`from${P}:n`)).toBe(`from${P}:_`);
    expect(canonical(`e.${O}Url`)).toBe(`_.${O}Url`);
    expect(canonical(`${O}Url:xe`)).toBe(`${O}Url:_`);
    expect(canonical(`docs.${L}.ai`)).toBe(`docs.${L}.ai`);
    expect(canonical(`ai.${L}.${O}.recorder`)).toBe(`ai.${L}.${O}.recorder`);
  });

  test("failure lines name the kind, the word and which way it is wrong", () => {
    const root = dir();
    writeFileSync(join(root, "a.js"), `x="${O}-new";y="Powered by ${LP}"`);
    const scan = scanWeb(root);
    expect(scan.reported).toEqual([`Powered by ${LP}`]);
    const failures = verdict("web", scan, [entry(`${O}-gone`), entry(`${LP}`)]);
    expect(failures).toContain(`web: ${O}-new （多出来的）`);
    expect(failures).toContain(`web: ${O}-gone （已经没了）`);
    expect(summaryOf("web", scan, failures)).toContain("不失败");
    expect(verdict("web", scan, [entry(`${O}-new`), entry(`${LP}`)])).toEqual(
      [],
    );
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
      Buffer.from(`\0/home/runner/work/x/x/xiongbao/node_modules/a\0`),
    );
    const scan = scanRunner(file, "/home/runner/work/x/x/xiongbao");
    expect(scan.found.get(BUILD_PATH)).toBe(1);
    expect(verdict("runner", scan, [])).toContain(
      `runner: ${BUILD_PATH} （多出来的）`,
    );
    expect(verdict("runner", scan, [entry(BUILD_PATH)])).toEqual([]);
  });

  test("the lists in the repo match the committed baselines' shape", () => {
    for (const name of ["web", "runner"]) {
      const list = JSON.parse(
        readFileSync(
          new URL(`./brand-artifacts/${name}.json`, import.meta.url),
          "utf8",
        ),
      ) as { word?: string; prefix?: string; category: string }[];
      expect(list.length).toBeGreaterThan(0);
      expect(
        list.filter((e) => e.prefix && e.category !== "dependency"),
      ).toEqual([]);
    }
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
        `/app/shared/${O}-actor.ts`,
        `/usr/src/${O}/x.js`,
        `/app/toolkit/src/${L}/agents.ts`,
        `/usr/local/sbin/${O}-apt`,
        "",
      ].join("\n"),
    );
    const found = scanImageFiles(list).found;
    expect([...found.keys()].sort()).toEqual([
      `${L}`,
      `${O}`,
      `${O}-actor.ts`,
      `${O}-apt`,
    ]);
  });

  test("image-files: a new version or hash of the same package says the same words", () => {
    const store = (version: string, hash: string) =>
      [
        `/app/node_modules/.bun/@${L}+shared@${version}+${hash}`,
        `/app/node_modules/.bun/@${L}+shared@${version}+${hash}/node_modules/@${L}/shared/package.json`,
        `/app/node_modules/.bun/${L}-cli@${version}+${hash}/node_modules/${L}-cli@${version}`,
        `/app/node_modules/.bun/@${O}+shared@${version}/node_modules/@${O}/shared`,
        `${hash}/node_modules/@${L}/runtime/dist/index.d.mts`,
      ].join("\n");
    const root = dir();
    const one = join(root, "one.txt");
    const two = join(root, "two.txt");
    writeFileSync(one, store("1.85.0", "232c2669fb60c3cc"));
    writeFileSync(two, store("1.86.0-next.3", "e95e36fcb715f04e"));
    const first = [...scanImageFiles(one).found.keys()].sort();
    expect(first).toEqual([...scanImageFiles(two).found.keys()].sort());
    expect(first).toEqual([`@${L}`, `@${O}`, `${L}-cli`]);
  });

  test("deb: string literals packed back to back are cut at the brand word and at `/`", () => {
    const text =
      `agent-desktop/opt/google/chrome/chrome/usr/bin/chromium${O}-runner/proc.configautostartxiongbao-device\n` +
      `shared/${O}-browser.ts\n@${L}/core@1.85.0\ndata-${O}-secret\n$${O}Out.AutoFlush\n`;
    expect([...segmentWords(text).keys()]).toEqual([
      `${O}-runner`,
      `${O}-browser.ts`,
      `@${L}`,
      `data-${O}-secret`,
      `$${O}Out.AutoFlush`,
    ]);
  });

  test("deb: a literal glued to an ALL-CAPS name, or a brand word glued to the one before it, is cut there", () => {
    const text = `${O}-runnerXIONGBAO_DESKTOP_ENGINE${E}DESKTOP_ENGINE\nfrom${P}\n${P}\n`;
    expect([...segmentWords(text).keys()]).toEqual([
      `${O}-runner`,
      `${E}DESKTOP_ENGINE`,
      `${P}`,
    ]);
  });

  test("image-config: Config.Env and Config.Labels, nothing else", () => {
    const root = dir();
    const file = join(root, "inspect.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          Name: `/${O}-trackb`,
          Config: {
            Env: [`${E}X=1`, "PATH=/usr/bin"],
            Labels: { [`ai.${L}.${O}.recorder`]: "v1" },
          },
        },
      ]),
    );
    const found = scanImageConfig(file).found;
    expect(found.has(`${E}X`)).toBe(true);
    expect(found.has(`ai.${L}.${O}.recorder`)).toBe(true);
    expect(found.has(`/${O}-trackb`)).toBe(false);
  });

  // `dpkg-deb` packs the archive this case reads. A machine without it (Windows) cannot build the
  // fixture at all, so the case is skipped there rather than failing on the missing command.
  test.if(Bun.which("dpkg-deb") !== null)(
    "deb: the listing, every control field and the extracted files are scanned",
    () => {
      const root = dir();
      const tree = join(root, "pkg");
      mkdirSync(join(tree, "DEBIAN"), { recursive: true });
      mkdirSync(join(tree, "usr", "bin"), { recursive: true });
      mkdirSync(join(tree, "usr", "share", "doc"), { recursive: true });
      writeFileSync(
        join(tree, "DEBIAN", "control"),
        `Package: ${O}-device\nVersion: 1.0.0\nArchitecture: amd64\nMaintainer: x <x@example.com>\nDescription: ${O}-desc\n`,
      );
      writeFileSync(
        join(tree, "usr", "bin", "xiongbao-runner"),
        Buffer.from(
          `\0/home/runner/work/x/x/xiongbao/node_modules/a\0${L}-inside\0/usr/bin/chromium${O}-runner/proc.configautostart\0@${L}/core@1.85.0\0`,
        ),
      );
      writeFileSync(join(tree, "usr", "share", "doc", `${O}-doc.txt`), "hi\n");
      const deb = join(root, "out.deb");
      execFileSync("dpkg-deb", ["--build", "-Znone", tree, deb], {
        stdio: "ignore",
      });
      const scan = scanDeb(deb, "/home/runner/work/x/x/xiongbao");
      expect(scan.found.has(`${O}-device`)).toBe(true);
      expect(scan.found.has(`${O}-desc`)).toBe(true);
      expect(scan.found.has(`${L}-inside`)).toBe(true);
      // Rust packs its literals with nothing between them: only the name and its own segment are the word.
      expect(scan.found.has(`${O}-runner`)).toBe(true);
      expect(scan.found.has(`@${L}`)).toBe(true);
      expect([...scan.found.keys()].filter((w) => w.length > 40)).toEqual([]);
      expect(
        [...scan.found.keys()].some((w) => w.endsWith(`${O}-doc.txt`)),
      ).toBe(true);
      expect(scan.found.get(BUILD_PATH)).toBe(1);
      rmSync(root, { recursive: true, force: true });
    },
  );

  test("web on a log file: words only, no source map check", () => {
    const root = dir();
    const log = join(root, "startup.log");
    writeFileSync(log, `boot ${O}\n//# sourceMappingURL=x.map\n`);
    const scan = scanLog(log);
    expect(scan.problems).toEqual([]);
    expect(scan.found.has(`${O}`)).toBe(true);
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
