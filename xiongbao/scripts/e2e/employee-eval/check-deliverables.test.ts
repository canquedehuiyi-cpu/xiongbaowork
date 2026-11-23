import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  checkDelivApp,
  checkDelivDocx,
  checkDelivImage,
  checkDelivPptx,
  checkDelivVideo,
  checkDelivWeb,
  checkDelivXlsx,
  localRefs,
} from "./check-deliverables";
import { CHECKERS } from "./checkers";
import {
  DELIVERABLES_SUITE,
  FIXTURES_DIR,
  materialize,
  TASK_TITLES,
  taskPrompt,
} from "./lib";
import { cleanup, emptyDir, failed, write } from "./test-support";

afterAll(cleanup);

// 二进制样例不入库：测试里现生成到临时目录。缺本机工具时对应用例跳过并说明原因（CI 上会装）。
const has = (cmd: string[]) => {
  try {
    return (
      Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" }).exitCode === 0
    );
  } catch {
    return false;
  }
};
const hasOffice = (module: string) =>
  has(["python3", "-I", "-c", `import ${module}`]);
// 起 python、ffmpeg 子进程的用例在负载高时会超过默认 5 秒，给足时间。
function gate(name: string, ok: boolean, why: string) {
  if (!ok) console.log(`跳过「${name}」相关用例：${why}`);
  return (title: string, body: () => void) =>
    ok ? test(title, body, 30_000) : test.skip(title, body);
}
const pptxTest = gate("pptx", hasOffice("pptx"), "没有 python-pptx");
const docxTest = gate("docx", hasOffice("docx"), "没有 python-docx");
const xlsxTest = gate("xlsx", hasOffice("openpyxl"), "没有 openpyxl");
const videoTest = gate(
  "video",
  has(["ffprobe", "-version"]) && has(["ffmpeg", "-version"]),
  "没有 ffprobe/ffmpeg",
);

function python(script: string, ...args: string[]) {
  const run = Bun.spawnSync(["python3", "-I", "-c", script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
}

function makePptx(path: string, slides: number) {
  python(
    `import sys
from pptx import Presentation
p = Presentation()
for i in range(int(sys.argv[2])):
    s = p.slides.add_slide(p.slide_layouts[1])
    s.shapes.title.text = "第%d页" % (i + 1)
p.save(sys.argv[1])`,
    path,
    String(slides),
  );
}

function makeDocx(path: string, headings: string[]) {
  python(
    `import sys, docx
d = docx.Document()
for i, h in enumerate(sys.argv[2:]):
    d.add_heading(h, 0 if i == 0 else 1)
    d.add_paragraph("要点")
d.save(sys.argv[1])`,
    path,
    ...headings,
  );
}

/** 公式单元格没有缓存值（openpyxl 写出来的样子），`cache` 为真时把算好的值补进 XML，像 LibreOffice 重算保存后那样。 */
function makeXlsx(
  path: string,
  cache: boolean,
  header = "项目,单价,数量,金额",
) {
  python(
    `import sys, re, zipfile, shutil, openpyxl
path, cache, header = sys.argv[1], sys.argv[2] == "1", sys.argv[3].split(",")
wb = openpyxl.Workbook(); ws = wb.active
ws.append(header)
for row in (("键盘", 100, 3), ("鼠标", 50, 4), ("显示器", 800, 2)):
    ws.append(list(row) + ["=B%d*C%d" % (ws.max_row + 1, ws.max_row + 1)])
ws.append(["合计", None, None, "=SUM(D2:D4)"])
wb.save(path)
if cache:
    vals = {"D2": 300, "D3": 200, "D4": 1600, "D5": 2100}
    tmp = path + ".tmp"
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, "w") as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                text = data.decode()
                for ref, v in vals.items():
                    text = re.sub(r'(<c r="%s"[^>]*>\\s*<f>[^<]*</f>)\\s*<v\\s*/>|(<c r="%s"[^>]*>\\s*<f>[^<]*</f>)\\s*<v></v>' % (ref, ref), lambda m: (m.group(1) or m.group(2)) + "<v>%s</v>" % v, text)
                data = text.encode()
            zout.writestr(item, data)
    shutil.move(tmp, path)`,
    path,
    cache ? "1" : "0",
    header,
  );
}

function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/** 纯色 RGB 的最小 PNG。 */
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x66)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeVideo(path: string, seconds: number) {
  const run = Bun.spawnSync(
    [
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=blue:s=64x64:d=${seconds}:r=5`,
      "-pix_fmt",
      "yuv420p",
      path,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
}

describe("pptx", () => {
  pptxTest(
    "a 5-slide pptx passes, a 2-slide one fails with the count in the detail",
    () => {
      const good = emptyDir();
      makePptx(join(good, "deck.pptx"), 5);
      const outcome = checkDelivPptx(good);
      expect(failed(outcome)).toEqual([]);
      expect(outcome.passed).toBe(true);

      const short = emptyDir();
      makePptx(join(short, "deck.pptx"), 2);
      const bad = checkDelivPptx(short);
      expect(failed(bad)).toEqual(["页数不少于 5 页"]);
      expect(bad.checks.find((item) => !item.ok)?.detail).toContain("2 页");
    },
  );

  test("a missing or broken pptx fails without throwing", () => {
    expect(failed(checkDelivPptx(emptyDir()))).toContain("deck.pptx 存在");
    const broken = emptyDir();
    write(broken, "deck.pptx", "这不是 pptx");
    expect(checkDelivPptx(broken).passed).toBe(false);
  });
});

describe("docx", () => {
  docxTest(
    "headings in heading style pass; a missing heading fails and is named",
    () => {
      const good = emptyDir();
      makeDocx(join(good, "report.docx"), ["项目周报", "本周进展", "下周计划"]);
      expect(failed(checkDelivDocx(good))).toEqual([]);

      const bad = emptyDir();
      makeDocx(join(bad, "report.docx"), ["项目周报", "本周进展"]);
      const outcome = checkDelivDocx(bad);
      expect(failed(outcome)).toEqual(["含标题 项目周报、本周进展、下周计划"]);
      expect(outcome.checks.find((item) => !item.ok)?.detail).toContain(
        "缺：下周计划",
      );
    },
  );

  docxTest(
    "the title text in a body paragraph does not count as a heading",
    () => {
      const dir = emptyDir();
      python(
        `import sys, docx
d = docx.Document()
for t in ("项目周报", "本周进展", "下周计划"):
    d.add_paragraph(t)
d.save(sys.argv[1])`,
        join(dir, "report.docx"),
      );
      expect(checkDelivDocx(dir).passed).toBe(false);
    },
  );
});

describe("xlsx", () => {
  xlsxTest("formulas with cached values equal to the gold pass", () => {
    const dir = emptyDir();
    makeXlsx(join(dir, "budget.xlsx"), true);
    expect(failed(checkDelivXlsx(dir))).toEqual([]);
  });

  xlsxTest(
    "formulas without a cached value fail, and the cell is named",
    () => {
      const dir = emptyDir();
      makeXlsx(join(dir, "budget.xlsx"), false);
      const outcome = checkDelivXlsx(dir);
      expect(failed(outcome)).toEqual(["公式缓存值等于金标"]);
      expect(outcome.checks.find((item) => !item.ok)?.detail).toContain(
        "D2 缓存值 null",
      );
    },
  );

  xlsxTest("a wrong header fails", () => {
    const dir = emptyDir();
    makeXlsx(join(dir, "budget.xlsx"), true, "名称,单价,数量,金额");
    expect(failed(checkDelivXlsx(dir))).toEqual(["表头是 项目,单价,数量,金额"]);
  });

  test("a missing xlsx fails", () => {
    expect(failed(checkDelivXlsx(emptyDir()))).toContain("budget.xlsx 存在");
  });
});

describe("web", () => {
  const page = (extra: string) =>
    `<!doctype html><html><head><link rel="stylesheet" href="style.css?v=1"></head><body><h1>菜单</h1>${extra}<a href="#top">顶</a><a href="https://example.com/x">外链</a><img src="data:image/png;base64,AAAA"></body></html>`;

  test("a page whose relative resources all exist passes", () => {
    const dir = emptyDir();
    write(dir, "site/index.html", page('<img src="img/logo.png">'));
    write(dir, "site/style.css", "body{}");
    write(dir, "site/img/logo.png", "x");
    expect(failed(checkDelivWeb(dir))).toEqual([]);
  });

  test("a missing resource, a missing index and an escape from site/ fail", () => {
    const dir = emptyDir();
    write(dir, "site/index.html", page('<script src="app.js"></script>'));
    write(dir, "site/style.css", "body{}");
    const outcome = checkDelivWeb(dir);
    expect(failed(outcome)).toEqual(["引用的相对资源都在"]);
    expect(outcome.checks.find((item) => !item.ok)?.detail).toContain("app.js");

    expect(failed(checkDelivWeb(emptyDir()))).toContain("site/index.html 存在");

    const outside = emptyDir();
    write(outside, "site/index.html", page('<img src="../secret.png">'));
    write(outside, "site/style.css", "body{}");
    write(outside, "secret.png", "x");
    expect(checkDelivWeb(outside).passed).toBe(false);
  });

  test("localRefs skips addresses, anchors and data URIs", () => {
    expect(
      localRefs(
        `<a href="//cdn/x"><a href="mailto:a@b"><a href='a.html#x'><img src=b.png><a href="javascript:void(0)">`,
      ),
    ).toEqual(["a.html", "b.png"]);
  });
});

describe("app", () => {
  test("script, page and an app item with a port pass", () => {
    const dir = emptyDir();
    write(dir, "app/server.js", "// 服务");
    write(dir, "app/index.html", "<p>待办</p>");
    expect(
      failed(
        checkDelivApp(dir, [
          { kind: "workspace_file" },
          { kind: "app", port: 4321 },
        ]),
      ),
    ).toEqual([]);
  });

  test("a missing script, page or app item fails", () => {
    const dir = emptyDir();
    write(dir, "app/index.html", "<p>待办</p>");
    expect(failed(checkDelivApp(dir, [{ kind: "app", port: 4321 }]))).toEqual([
      "服务脚本在",
    ]);

    const none = emptyDir();
    write(none, "app/server.py", "pass");
    expect(failed(checkDelivApp(none, [{ kind: "note" }]))).toEqual([
      "app/index.html 存在",
      "交付里有 app 项且写了端口",
    ]);
    // 没拿到交付清单时也不算过。
    expect(failed(checkDelivApp(none))).toContain("交付里有 app 项且写了端口");
    expect(failed(checkDelivApp(none, [{ kind: "app" }]))).toContain(
      "交付里有 app 项且写了端口",
    );
  });
});

describe("image", () => {
  test("a real PNG passes; a renamed JPEG, an empty file and a missing file fail", () => {
    const good = emptyDir();
    writeFileSync(join(good, "cover.png"), makePng(8, 4));
    expect(failed(checkDelivImage(good))).toEqual([]);
    const jpeg = emptyDir();
    writeFileSync(
      join(jpeg, "cover.png"),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    );
    expect(failed(checkDelivImage(jpeg))).toEqual([
      "文件头是 PNG 魔数",
      "宽高都大于 0",
    ]);
    const empty = emptyDir();
    write(empty, "cover.png", "");
    expect(checkDelivImage(empty).passed).toBe(false);
    expect(failed(checkDelivImage(emptyDir()))).toContain("cover.png 存在");
  });

  test("a PNG whose height is 0 fails", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "cover.png"), makePng(8, 0));
    const outcome = checkDelivImage(dir);
    expect(failed(outcome)).toEqual(["宽高都大于 0"]);
    expect(outcome.checks.at(-1)?.detail).toBe("8×0");
  });
});

describe("video", () => {
  videoTest("a 2-second video passes; one over 30 seconds fails", () => {
    const good = emptyDir();
    makeVideo(join(good, "intro.mp4"), 2);
    expect(failed(checkDelivVideo(good))).toEqual([]);

    const long = emptyDir();
    makeVideo(join(long, "intro.mp4"), 31);
    expect(failed(checkDelivVideo(long))).toEqual(["时长 1–30 秒"]);
  });

  videoTest("a sub-second video and a non-video file fail", () => {
    const short = emptyDir();
    makeVideo(join(short, "intro.mp4"), 0.4);
    expect(failed(checkDelivVideo(short))).toEqual(["时长 1–30 秒"]);

    const fake = emptyDir();
    write(fake, "intro.mp4", "不是视频");
    expect(checkDelivVideo(fake).passed).toBe(false);
    expect(failed(checkDelivVideo(emptyDir()))).toContain("intro.mp4 存在");
  });
});

describe("suite wiring", () => {
  test("each deliverable has a registered checker, a title and a Chinese TASK.md the employee is pointed at", () => {
    for (const task of DELIVERABLES_SUITE) {
      expect(CHECKERS[task]).toBeFunction();
      expect(TASK_TITLES[task]).toBeTruthy();
      const path = join(FIXTURES_DIR, "deliverables", task, "TASK.md");
      expect(existsSync(path)).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text).toContain("判分标准");
      expect(text).toMatch(/[一-龥]/);
      const dest = emptyDir();
      expect(materialize(task, dest)).toEqual(["TASK.md"]);
      expect(taskPrompt(task, "eval/x")).toContain("eval/x/TASK.md");
    }
  });

  test("each fixture stays under 50KB", () => {
    for (const task of DELIVERABLES_SUITE) {
      const size = readFileSync(
        join(FIXTURES_DIR, "deliverables", task, "TASK.md"),
      ).length;
      expect(size).toBeLessThan(50 * 1024);
    }
  });
});
