import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const script = join(import.meta.dir, "apply.ts");

type Report = {
  files: number;
  lines: number;
  moved: number;
  collisions: string[];
  review: number;
  skippedBinary: number;
  errors: string[];
};

let root: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
};

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, env: GIT_ENV });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function put(path: string, content: string | Uint8Array) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function run(args: string[], cwd = root) {
  const result = Bun.spawnSync(["bun", script, ...args], {
    cwd,
    env: GIT_ENV,
  });
  const stdout = result.stdout.toString().trim();
  return {
    code: result.exitCode,
    stderr: result.stderr.toString(),
    stdout,
    report: (stdout.startsWith("{") ? JSON.parse(stdout) : undefined) as
      | Report
      | undefined,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rebrand-apply-"));
  git("init", "-q");
  put(
    "xiongbao/server/src/model.ts",
    "export const openbotModel = 1;\nexport const keep = 2;\n",
  );
  put("xiongbao/server/src/existing.ts", "export const xiongbaoModel = 0;\n");
  put("xiongbao/server/src/openbot-actor.ts", "export const actor = 1;\n");
  put(
    "xiongbao/server/drizzle/0054_app_role.sql",
    "CREATE ROLE openbot_app LOGIN;\n",
  );
  put(
    "xiongbao/app/src/welcome.tsx",
    [
      "export const Welcome = () => (",
      "  <p>Welcome to OpenBot</p>",
      ");",
      'export const code = "OpenBotModel";',
      "// the user's own OpenBot is what this page greets",
      "  if (error instanceof OpenBotError) throw error;",
      "",
    ].join("\n"),
  );
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("apply CLI", () => {
  test("改内容、按名移动、报告重名，迁移目录不动", () => {
    const { code, report } = run(["--phase", "R1", "xiongbao/"]);
    expect(code).toBe(0);
    expect(report).toMatchObject({ moved: 1, collisions: ["xiongbaoModel"] });
    expect(report?.files).toBe(2);
    expect(read("xiongbao/server/src/model.ts")).toContain("xiongbaoModel = 1");
    expect(existsSync(join(root, "xiongbao/server/src/openbot-actor.ts"))).toBe(
      false,
    );
    expect(
      existsSync(join(root, "xiongbao/server/src/xiongbao-actor.ts")),
    ).toBe(true);
    expect(read("xiongbao/server/drizzle/0054_app_role.sql")).toBe(
      "CREATE ROLE openbot_app LOGIN;\n",
    );
    // 移动走 git mv：暂存区里是一次改名，不是删除加新增。
    expect(git("status", "--porcelain")).toContain(
      "R  xiongbao/server/src/openbot-actor.ts -> xiongbao/server/src/xiongbao-actor.ts",
    );
  });

  test("lines 只数真正改变的行", () => {
    const { report } = run(["--phase", "R1", "xiongbao/"]);
    // model.ts 1 行 + welcome.tsx 4 行（句子、标识符字符串、注释、instanceof 各一）
    expect(report?.lines).toBe(5);
  });

  test("--dry-run 报告同样的数字，工作区与暂存区都不变", () => {
    const before = git("status", "--porcelain");
    const dry = run(["--phase", "R1", "--dry-run", "xiongbao/"]);
    expect(dry.code).toBe(0);
    expect(git("status", "--porcelain")).toBe(before);
    expect(read("xiongbao/server/src/model.ts")).toContain("openbotModel");
    const real = run(["--phase", "R1", "xiongbao/"]);
    expect(dry.report).toEqual(real.report);
  });

  test("--review-out 只写界面句子里被替换的行，标识符、注释与代码行不进来", () => {
    const out = join(root, "..", `review-${Date.now()}.txt`);
    try {
      const { report } = run([
        "--phase",
        "R1",
        "--review-out",
        out,
        "xiongbao/",
      ]);
      expect(report?.review).toBe(1);
      expect(readFileSync(out, "utf8")).toBe(
        "xiongbao/app/src/welcome.tsx:2: <p>Welcome to XiongBao</p>\n",
      );
    } finally {
      rmSync(out, { force: true });
    }
  });

  test("保护清单按阶段生效：R1 不动环境变量名", () => {
    put("xiongbao/server/src/env.ts", "const a = process.env.OPENBOT_PORT;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "env");
    run(["--phase", "R1", "xiongbao/"]);
    expect(read("xiongbao/server/src/env.ts")).toBe(
      "const a = process.env.OPENBOT_PORT;\n",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "r1");
    run(["--phase", "R2", "xiongbao/"]);
    expect(read("xiongbao/server/src/env.ts")).toBe(
      "const a = process.env.XIONGBAO_PORT;\n",
    );
  });

  test("二进制文件内容不动、数入 skippedBinary，但文件名照改", () => {
    put("xiongbao/assets/openbot-logo.bin", new Uint8Array([0x6f, 0, 0x4f]));
    git("add", "-A");
    git("commit", "-q", "-m", "bin");
    const { report } = run(["--phase", "R1", "xiongbao/assets/"]);
    expect(report?.skippedBinary).toBe(1);
    expect(report?.moved).toBe(1);
    expect(existsSync(join(root, "xiongbao/assets/xiongbao-logo.bin"))).toBe(
      true,
    );
  });

  test("不是合法 UTF-8 的文件当作二进制，避免改坏字节", () => {
    put("xiongbao/assets/latin.txt", new Uint8Array([0x6f, 0xe9, 0x4f, 0x70]));
    git("add", "-A");
    git("commit", "-q", "-m", "latin");
    const { report } = run(["--phase", "R1", "xiongbao/assets/"]);
    expect(report?.skippedBinary).toBe(1);
    expect(report?.files).toBe(0);
  });

  test("改名目标已存在时不覆盖：列为错误、退出 1、什么都不改", () => {
    put("xiongbao/server/src/xiongbao-actor.ts", "export const other = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "clash");
    const { code, report } = run(["--phase", "R1", "xiongbao/"]);
    expect(code).toBe(1);
    expect(report?.errors).toEqual([
      "xiongbao/server/src/openbot-actor.ts -> xiongbao/server/src/xiongbao-actor.ts: 目标已存在",
    ]);
    expect(read("xiongbao/server/src/model.ts")).toContain("openbotModel");
    expect(read("xiongbao/server/src/xiongbao-actor.ts")).toBe(
      "export const other = 1;\n",
    );
  });

  test("路径相对仓库根，在子目录里运行结果相同；工具自己的目录不改", () => {
    put("xiongbao/scripts/rebrand/protect.json", '{"text":"openbot"}\n');
    git("add", "-A");
    git("commit", "-q", "-m", "tool");
    const { code, report } = run(
      ["--phase", "R1", "xiongbao/server/", "xiongbao/scripts/"],
      join(root, "xiongbao/server/src"),
    );
    expect(code).toBe(0);
    expect(report?.moved).toBe(1);
    expect(read("xiongbao/scripts/rebrand/protect.json")).toBe(
      '{"text":"openbot"}\n',
    );
  });

  test("范围内工作区有未提交改动时拒绝真跑（dry-run 不受限），什么都不改", () => {
    writeFileSync(join(root, "xiongbao/server/src/existing.ts"), "// 手改\n");
    const refused = run(["--phase", "R1", "xiongbao/"]);
    expect(refused.code).toBe(1);
    expect(refused.report?.errors[0]).toContain("工作区不干净");
    expect(read("xiongbao/server/src/model.ts")).toContain("openbotModel");
    expect(run(["--phase", "R1", "--dry-run", "xiongbao/"]).code).toBe(0);
    // 范围之外的改动不挡路。
    const elsewhere = run(["--phase", "R1", "xiongbao/app/"]);
    expect(elsewhere.code).toBe(0);
  });

  test("范围内有未跟踪文件也拒绝真跑：恢复提示里的 git clean 会删掉它们", () => {
    put("xiongbao/server/src/untracked.ts", "export const x = 1;\n");
    const refused = run(["--phase", "R1", "xiongbao/"]);
    expect(refused.code).toBe(1);
    expect(refused.report?.errors[0]).toContain("untracked.ts");
    expect(read("xiongbao/server/src/model.ts")).toContain("openbotModel");
  });

  test("collisions 不列新品牌词本身，只列真正撞名的标识符", () => {
    put(
      "xiongbao/server/src/scope.ts",
      'import "@openbot/x";\nexport const xiongbao = 1;\n',
    );
    git("add", "-A");
    git("commit", "-q", "-m", "scope");
    const { report } = run(["--phase", "R1", "xiongbao/"]);
    expect(report?.collisions).toEqual(["xiongbaoModel"]);
  });

  test("带作用域的保护只在自己的文件里生效，别处同样的文字照改", () => {
    put(
      "xiongbao/shared/learning.ts",
      'export const AUTOMATIC_LEARNING_CONTAINER_ID = "openbot";\n',
    );
    put(
      "xiongbao/shared/elsewhere.ts",
      'export const AUTOMATIC_LEARNING_CONTAINER_ID = "openbot";\n',
    );
    git("add", "-A");
    git("commit", "-q", "-m", "scoped");
    run(["--phase", "R1", "xiongbao/shared/"]);
    expect(read("xiongbao/shared/learning.ts")).toContain('"openbot"');
    expect(read("xiongbao/shared/elsewhere.ts")).toContain('"xiongbao"');
  });

  test("参数不合法时退出 2 并说明用法", () => {
    expect(run(["xiongbao/"]).code).toBe(2);
    expect(run(["--phase", "R9", "xiongbao/"]).code).toBe(2);
    expect(run(["--phase", "R1"]).code).toBe(2);
    expect(run(["--phase", "R1", "--nope", "xiongbao/"]).code).toBe(2);
  });

  test("没有命中旧名时报告全零并成功", () => {
    const { code, report } = run(["--phase", "R1", "xiongbao/server/drizzle/"]);
    expect(code).toBe(0);
    expect(report).toMatchObject({
      files: 0,
      lines: 0,
      moved: 0,
      collisions: [],
      review: 0,
    });
  });
});
