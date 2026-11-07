/**
 * 参考截图与本地截图的逐像素对比。
 *
 *   bun tests/parity/diff.ts [--out <dir>] [--scenario data] [--theme dark] [--threshold 8]
 *
 * For every `<out>/reference/<theme>/<WxH>/<slug>.png` that has a counterpart at
 * `<out>/<scenario>/<theme>/<WxH>/<slug>.png`, counts the pixels where any channel differs by more
 * than `threshold`/255, and writes a diff image (ours faded to grey, differing pixels in red) to
 * `<out>/diff/<scenario>/<theme>/<WxH>/<slug>.png`, plus `<out>/diff/report.md` and `report.json`.
 *
 * No PNG decoder is installed in this repository, so decoding happens in Chromium: both images are
 * drawn onto canvases in a blank page and compared there.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { chromium, type Page } from "playwright-core";

const DEFAULT_OUT =
  "/tmp/claude-0/-home-user-xiongbaowork/87ff88c2-019b-516c-a0cd-6b2b65a63f7a/scratchpad/parity-shots";

type Comparison = {
  file: string;
  referenceSize: string;
  oursSize: string;
  differingPixels: number;
  totalPixels: number;
  percent: number;
};

function parseArgs(argv: string[]) {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    out: value("--out") ?? DEFAULT_OUT,
    scenario: value("--scenario") ?? "data",
    theme: value("--theme") ?? "dark",
    threshold: Number(value("--threshold") ?? 8),
  };
}

async function pngFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith(".png"))
    .map((entry) => join(root, entry))
    .sort();
}

/** Runs in the page: decode both data URLs, compare, and paint the diff. */
async function compareInPage(input: {
  reference: string;
  ours: string;
  threshold: number;
}): Promise<{
  referenceSize: string;
  oursSize: string;
  differingPixels: number;
  totalPixels: number;
  diff: string;
}> {
  const load = (source: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("could not decode image"));
      image.src = source;
    });
  const [reference, ours] = await Promise.all([
    load(input.reference),
    load(input.ours),
  ]);
  const width = Math.max(reference.naturalWidth, ours.naturalWidth);
  const height = Math.max(reference.naturalHeight, ours.naturalHeight);
  const pixels = (image: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, width, height).data;
  };
  const a = pixels(reference);
  const b = pixels(ours);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  const out = context.createImageData(width, height);
  let differing = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const outside =
        x >= reference.naturalWidth ||
        y >= reference.naturalHeight ||
        x >= ours.naturalWidth ||
        y >= ours.naturalHeight;
      const differs =
        outside ||
        Math.abs(a[i]! - b[i]!) > input.threshold ||
        Math.abs(a[i + 1]! - b[i + 1]!) > input.threshold ||
        Math.abs(a[i + 2]! - b[i + 2]!) > input.threshold ||
        Math.abs(a[i + 3]! - b[i + 3]!) > input.threshold;
      if (differs) {
        differing++;
        out.data[i] = 255;
        out.data[i + 1] = 0;
        out.data[i + 2] = 0;
        out.data[i + 3] = 255;
      } else {
        const grey = Math.round(
          (0.299 * b[i]! + 0.587 * b[i + 1]! + 0.114 * b[i + 2]!) * 0.35 + 160,
        );
        out.data[i] = grey;
        out.data[i + 1] = grey;
        out.data[i + 2] = grey;
        out.data[i + 3] = 255;
      }
    }
  }
  context.putImageData(out, 0, 0);
  return {
    referenceSize: `${reference.naturalWidth}x${reference.naturalHeight}`,
    oursSize: `${ours.naturalWidth}x${ours.naturalHeight}`,
    differingPixels: differing,
    totalPixels: width * height,
    diff: canvas.toDataURL("image/png"),
  };
}

const dataUrl = async (path: string) =>
  `data:image/png;base64,${(await readFile(path)).toString("base64")}`;

async function compare(
  page: Page,
  referencePath: string,
  oursPath: string,
  diffPath: string,
  threshold: number,
) {
  const result = await page.evaluate(compareInPage, {
    reference: await dataUrl(referencePath),
    ours: await dataUrl(oursPath),
    threshold,
  });
  await mkdir(dirname(diffPath), { recursive: true });
  await writeFile(
    diffPath,
    Buffer.from(result.diff.replace(/^data:image\/png;base64,/, ""), "base64"),
  );
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const referenceRoot = join(options.out, "reference", options.theme);
  const oursRoot = join(options.out, options.scenario, options.theme);
  const diffRoot = join(options.out, "diff", options.scenario, options.theme);
  const references = await pngFiles(referenceRoot);
  if (references.length === 0) {
    console.log(`no reference screenshots under ${referenceRoot}`);
    return;
  }

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
  });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>parity diff</title>");
  const comparisons: Comparison[] = [];
  const missing: string[] = [];
  try {
    for (const referencePath of references) {
      const file = relative(referenceRoot, referencePath);
      const oursPath = join(oursRoot, file);
      if (!existsSync(oursPath)) {
        missing.push(file);
        continue;
      }
      const result = await compare(
        page,
        referencePath,
        oursPath,
        join(diffRoot, file),
        options.threshold,
      );
      const percent =
        Math.round((result.differingPixels / result.totalPixels) * 10_000) /
        100;
      comparisons.push({
        file,
        referenceSize: result.referenceSize,
        oursSize: result.oursSize,
        differingPixels: result.differingPixels,
        totalPixels: result.totalPixels,
        percent,
      });
      console.log(`${file}: ${percent}% differ`);
    }
  } finally {
    await browser.close();
  }

  await mkdir(join(options.out, "diff"), { recursive: true });
  await writeFile(
    join(options.out, "diff", "report.json"),
    `${JSON.stringify({ ...options, comparisons, missing }, null, 2)}\n`,
  );
  const lines = [
    "# Parity diff",
    "",
    `- reference: ${referenceRoot}`,
    `- ours: ${oursRoot}`,
    `- threshold: ${options.threshold}/255 per channel`,
    "",
    "| file | reference | ours | differing pixels | % |",
    "| --- | --- | --- | ---: | ---: |",
    ...comparisons.map(
      (row) =>
        `| ${row.file} | ${row.referenceSize} | ${row.oursSize} | ${row.differingPixels} | ${row.percent} |`,
    ),
    "",
    ...(missing.length > 0
      ? [
          "## Reference without a capture",
          "",
          ...missing.map((file) => `- ${file}`),
          "",
        ]
      : []),
  ];
  await writeFile(join(options.out, "diff", "report.md"), lines.join("\n"));
  console.log(`report: ${join(options.out, "diff", "report.md")}`);
}

if (import.meta.main) {
  await main();
}
