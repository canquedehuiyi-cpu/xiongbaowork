import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * 员工电脑的文档环境（docker/docs-toolchain）：两个镜像装同一套 Python 文档库、markitdown、pandoc 和
 * 中文字体，单镜像另装 LibreOffice 无界面版；装完当场跑 selfcheck.py，生成 docx、xlsx、pptx、PDF（带中文）
 * 再读回来，出不了中文就构建失败。
 *
 * 这里管两件事。一是装法本身：版本全部钉死、两个 Dockerfile 都装了字体并跑了自检、CI 的 image job 以员工
 * 用户再跑一次。二是自检脚本真的能判对错：机器上有装好这些库的 Python 时（`DOCS_SELFCHECK_PYTHON`，或系统
 * python3 正好装齐），跑一遍要全过；把字体拿掉再跑，要报中文字体那一项失败。没有这样的 Python 就跳过运行
 * 的部分，镜像里的那一遍由 image job 跑。
 */

const root = join(import.meta.dir, "..");
const toolchain = join(root, "docker", "docs-toolchain");
const read = (...parts: string[]) => readFileSync(join(...parts), "utf8");

const requirements = read(toolchain, "requirements.txt");
const pins = requirements
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

describe("the documents toolchain's install", () => {
  test("every package is pinned to one exact version, transitive ones included", () => {
    expect(pins.length).toBeGreaterThan(20);
    for (const pin of pins)
      expect(pin).toMatch(
        /^[A-Za-z0-9_.-]+(\[[a-z,]+\])?==[0-9][0-9A-Za-z.]*$/,
      );
    const names = pins.map((pin) => pin.split(/[[=]/)[0]?.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const wanted of [
      "python-docx",
      "openpyxl",
      "python-pptx",
      "reportlab",
      "weasyprint",
      "pypdf",
      "pdfplumber",
      "pandas",
      "markitdown",
    ])
      expect(names).toContain(wanted);
    // markitdown 读 Word、PDF、PPT、Excel 要各自的可选依赖。
    expect(pins).toContain("markitdown[docx,pdf,pptx,xlsx]==0.1.9");
  });

  test("the install goes into its own venv that the system python3 reads, never into the system's site-packages", () => {
    const install = read(toolchain, "install.sh");
    expect(install).not.toContain("--break-system-packages");
    expect(install).toContain("python3 -m venv");
    expect(install).toContain("xiongbao-docs.pth");
    expect(install).toContain("/usr/local/bin/markitdown");
  });

  for (const [label, path, soffice] of [
    ["the single image", "Dockerfile", true],
    ["the computer image", join("agent-computer", "Dockerfile"), false],
  ] as const) {
    test(`${label} installs Chinese fonts and the toolchain, and fails its build when the self-check fails`, () => {
      const dockerfile = read(root, path);
      expect(dockerfile).toContain(
        "COPY docker/docs-toolchain /opt/docs-toolchain",
      );
      expect(dockerfile).toContain("fonts-noto-cjk");
      expect(dockerfile).toContain("fonts-wqy-microhei");
      expect(dockerfile).toContain("pandoc");
      expect(dockerfile).toContain(
        "sh /opt/docs-toolchain/install.sh /opt/docs-toolchain/requirements.txt",
      );
      expect(dockerfile).toContain(
        `python3 /opt/docs-toolchain/selfcheck.py --require-pandoc${soffice ? " --require-soffice" : ""} \\`,
      );
      // LibreOffice is 400 MB and more: the single image only, and its headless build.
      expect(dockerfile.includes("libreoffice-writer-nogui")).toBe(soffice);
      expect(dockerfile).not.toMatch(/libreoffice(-writer|-calc|-impress)?\s/);
    });
  }

  test("CI's image job runs the self-check again, as the default employee", () => {
    const ci = read(root, "..", ".github", "workflows", "ci.yml");
    expect(ci).toContain(
      "docker run --rm --user pwuser --entrypoint python3 xiongbao:trackb /opt/docs-toolchain/selfcheck.py --require-pandoc --require-soffice",
    );
  });
});

/** A Python that has every library the self-check imports, or undefined. */
function pythonWithToolchain(): string | undefined {
  for (const candidate of [process.env.DOCS_SELFCHECK_PYTHON, "python3"]) {
    if (!candidate) continue;
    const probe = Bun.spawnSync([
      candidate,
      "-c",
      "import docx, openpyxl, pptx, reportlab, weasyprint, pypdf, pdfplumber, markitdown",
    ]);
    if (probe.exitCode === 0) return candidate;
  }
  return undefined;
}

const python = pythonWithToolchain();
const hasFontconfig =
  Bun.spawnSync(["sh", "-c", "command -v fc-list"]).exitCode === 0;
const runnable = python !== undefined && hasFontconfig;

function selfcheck(env: Record<string, string> = {}) {
  const run = Bun.spawnSync(
    [python ?? "python3", join(toolchain, "selfcheck.py")],
    { env: { ...process.env, ...env }, timeout: 300_000 },
  );
  return { code: run.exitCode, out: run.stdout.toString() };
}

describe.skipIf(!runnable)("the self-check, run on this machine", () => {
  test("makes a docx, an xlsx, a pptx and two PDFs with Chinese in them, and reads each back", () => {
    const { code, out } = selfcheck();
    expect(out).toContain("PASS cjk-font");
    for (const step of [
      "docx",
      "xlsx",
      "pptx",
      "pdf-weasyprint",
      "pdf-reportlab",
      "markitdown",
    ])
      expect(out).toContain(`PASS ${step} `);
    expect(out).toContain("0 failed");
    expect(code).toBe(0);
  }, 300_000);

  test("with no Chinese font on the machine, it fails, and says which check did", () => {
    const empty = mkdtempSync(join(tmpdir(), "no-fonts-"));
    try {
      const config = join(empty, "fonts.conf");
      writeFileSync(
        config,
        `<?xml version="1.0"?><fontconfig><cachedir>${empty}</cachedir></fontconfig>`,
      );
      const { code, out } = selfcheck({ FONTCONFIG_FILE: config });
      expect(out).toContain("FAIL cjk-font");
      expect(out).toContain("FAIL pdf-reportlab");
      expect(code).toBe(1);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 300_000);
});
