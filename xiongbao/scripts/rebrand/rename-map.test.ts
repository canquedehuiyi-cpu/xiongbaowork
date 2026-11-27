import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PATH_VARIANTS } from "../brand/guard/budget";
import {
  buildProtect,
  GUARD_PATHS,
  isBinary,
  isGuardPath,
  isSkipped,
  loadProtect,
  type ProtectEntry,
  readProtectEntries,
  renamePath,
  renameText,
  SKIP_PATHS,
  VARIANTS,
} from "./rename-map";

describe("renameText", () => {
  const p = loadProtect("R1");

  test("改包名、标识符与路径片段", () => {
    expect(renameText('from "@openbot/shared"', p)).toBe(
      'from "@xiongbao/shared"',
    );
    expect(renameText("normaliseOpenBotOrigin", p)).toBe(
      "normaliseXiongBaoOrigin",
    );
  });

  test("六个变体各自落到对应的新写法（不带保护）", () => {
    const none = /$^/g;
    expect(renameText("openBotRun OPENBOT_ openbotRoot", none)).toBe(
      "xiongBaoRun XIONGBAO_ xiongbaoRoot",
    );
    expect(renameText("OpenBot Openbot @openbot/x", none)).toBe(
      "XiongBao Xiongbao @xiongbao/x",
    );
  });

  test("环境变量名在 R1 受保护，同一行的别的写法照改", () => {
    expect(renameText("OPENBOT_PUBLIC_URL", p)).toBe("OPENBOT_PUBLIC_URL");
    expect(renameText('"OPENBOT_RELEASE", openbotRoot', p)).toBe(
      '"OPENBOT_RELEASE", xiongbaoRoot',
    );
  });

  test("许可证署名与依赖包名永远不动", () => {
    expect(renameText("Copyright (c) 2026 CopilotKit", p)).toBe(
      "Copyright (c) 2026 CopilotKit",
    );
    expect(renameText('import "@copilotkit/react-core"', p)).toBe(
      'import "@copilotkit/react-core"',
    );
    expect(renameText("https://open.bot/errors/x", p)).toBe(
      "https://open.bot/errors/x",
    );
  });

  test("renaming twice equals renaming once", () => {
    const mixed = [
      'import { OpenBotRole } from "@openbot/shared/openbot-actor";',
      "const openBotRun = process.env.OPENBOT_PUBLIC_URL ?? openbotRoot;",
      'const label = "openbot-bearer"; // Openbot',
      "Copyright (c) 2026 CopilotKit",
    ].join("\n");
    for (const phase of ["R1", "R2", "R3", "R4"] as const) {
      const protect = loadProtect(phase);
      const once = renameText(mixed, protect);
      expect(renameText(once, protect)).toBe(once);
    }
  });

  test("单独的环境变量前缀也受保护（R1 不拆开 startsWith 的前缀判断）", () => {
    expect(renameText('upper.startsWith("OPENBOT_")', p)).toBe(
      'upper.startsWith("OPENBOT_")',
    );
    expect(renameText('upper.startsWith("OPENBOT_")', loadProtect("R2"))).toBe(
      'upper.startsWith("XIONGBAO_")',
    );
  });

  test("计划放在 R1 改的名字在 R1 就改：扩展消息类型、K8s 标签、开发邮箱、令牌头、测试域名", () => {
    for (const [from, to] of [
      ['{ type: "openbot.ping" }', '{ type: "xiongbao.ping" }'],
      ['"openbot.dev/component"', '"xiongbao.dev/component"'],
      ["dev@openbot.local", "dev@xiongbao.local"],
      ['"x-openbot-agent-token"', '"x-xiongbao-agent-token"'],
      ['"https://openbot.example.com"', '"https://xiongbao.example.com"'],
      ['"name": "openbot-mobile"', '"name": "xiongbao-mobile"'],
    ] as const) {
      expect(renameText(from, p)).toBe(to);
    }
  });

  test("连接串保护带边界：同一标识符不会改一半", () => {
    const text = "postgres://openbot_fixture:x@h/db -U openbot_fixture";
    expect(renameText(text, p)).toBe(
      "postgres://xiongbao_fixture:x@h/db -U xiongbao_fixture",
    );
    // 超级用户与公开默认口令随迁移基线化（R4 Task 26）不再保护：连接串里的用户名、口令、库名一起改。
    expect(
      renameText("postgres://openbot:openbot@h/openbot_b -U openbot", p),
    ).toBe("postgres://xiongbao:xiongbao@h/xiongbao_b -U xiongbao");
    expect(renameText("ROLE_WRITER_PASSWORD:-openbot-dev", p)).toBe(
      "ROLE_WRITER_PASSWORD:-xiongbao-dev",
    );
  });

  test("作用域条目只在自己的文件里生效", () => {
    const entries: ProtectEntry[] = [
      {
        text: 'ID = "openbot"',
        file: "a/openbot-x.ts",
        until: "R3",
        reason: "r",
      },
    ];
    const line = 'const ID = "openbot";';
    expect(
      renameText(line, buildProtect(entries, "R1", "a/openbot-x.ts")),
    ).toBe(line);
    // 文件在 R1 被改名之后，再按新路径找也认。
    expect(
      renameText(line, buildProtect(entries, "R2", "a/xiongbao-x.ts")),
    ).toBe(line);
    expect(renameText(line, buildProtect(entries, "R1", "b/other.ts"))).toBe(
      'const ID = "xiongbao";',
    );
    expect(renameText(line, buildProtect(entries, "R1"))).toBe(
      'const ID = "xiongbao";',
    );
  });

  test("输入含 NUL 时抛错，不悄悄与占位符混淆", () => {
    expect(() => renameText(`a${String.fromCharCode(0)}b`, p)).toThrow(/NUL/);
  });

  test("空文本与没有任何命中的文本原样返回", () => {
    expect(renameText("", /$^/g)).toBe("");
    expect(renameText("nothing here", loadProtect("R1"))).toBe("nothing here");
  });

  test("保护片段按长度降序匹配，长的精确串优先于短的", () => {
    const entries: ProtectEntry[] = [
      { text: "openbot", until: "R3", reason: "短" },
      { text: "openbot-keep", until: "R3", reason: "长" },
    ];
    const protect = buildProtect(entries, "R1");
    expect(renameText("openbot-keep openbot-x", protect)).toBe(
      "openbot-keep openbot-x",
    );
    const shortOnly = buildProtect([entries[1] as ProtectEntry], "R1");
    expect(renameText("openbot-keep openbot-x", shortOnly)).toBe(
      "openbot-keep xiongbao-x",
    );
  });

  test("text 条目按字面转义，pattern 条目按正则", () => {
    const protect = buildProtect(
      [
        { text: "a.b(c)", until: "forever", reason: "字面" },
        { pattern: "ENV_[A-Z]+", until: "forever", reason: "正则" },
      ],
      "R1",
    );
    expect(renameText("a.b(c) aXb(c) ENV_FOO openbot", protect)).toBe(
      "a.b(c) aXb(c) ENV_FOO xiongbao",
    );
  });
});

describe("保护清单按阶段到期", () => {
  test("protect entries expire by phase", () => {
    const entries: ProtectEntry[] = [
      { text: "keep-until-r2", until: "R2", reason: "r2" },
    ];
    expect(buildProtect(entries, "R1").test("keep-until-r2")).toBe(true);
    expect(buildProtect(entries, "R2").test("keep-until-r2")).toBe(false);
    expect(buildProtect(entries, "R4").test("keep-until-r2")).toBe(false);
  });

  test("forever 条目在每个阶段都生效", () => {
    const entries: ProtectEntry[] = [
      { text: "forever-text", until: "forever", reason: "f" },
    ];
    for (const phase of ["R1", "R2", "R3", "R4"] as const) {
      expect(buildProtect(entries, phase).test("forever-text")).toBe(true);
    }
  });

  test("没有任何生效条目时不匹配任何文本", () => {
    expect(buildProtect([], "R1").test("anything")).toBe(false);
  });

  test("真实清单：环境变量在 R1 受保护、R2 起改名；until R5 的条目到 R4 仍受保护", () => {
    expect(renameText("OPENBOT_PUBLIC_URL", loadProtect("R1"))).toBe(
      "OPENBOT_PUBLIC_URL",
    );
    expect(renameText("OPENBOT_PUBLIC_URL", loadProtect("R2"))).toBe(
      "XIONGBAO_PUBLIC_URL",
    );
    const refusal = 'OLD_PREFIX = "OPENBOT_"';
    for (const phase of ["R1", "R4"] as const)
      expect(
        renameText(refusal, loadProtect(phase, "xiongbao/shared/env-name.ts")),
      ).toBe(refusal);
    expect(renameText(refusal, loadProtect("R4"))).toBe(
      'OLD_PREFIX = "XIONGBAO_"',
    );
    const copyright = "Copyright (c) 2026 CopilotKit";
    expect(renameText(copyright, loadProtect("R4"))).toBe(copyright);
  });

  test("每个条目的 until 与 reason 合法，pattern 能编译", () => {
    const phases = new Set(["R1", "R2", "R3", "R4", "R5", "forever"]);
    for (const entry of readProtectEntries()) {
      expect(phases.has(entry.until)).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(Boolean(entry.text) !== Boolean(entry.pattern)).toBe(true);
      if (entry.pattern)
        expect(() => new RegExp(entry.pattern as string)).not.toThrow();
    }
  });
});

describe("renamePath", () => {
  test("文件名与目录名都套变体", () => {
    expect(renamePath("xiongbao/shared/openbot-actor.ts")).toBe(
      "xiongbao/shared/xiongbao-actor.ts",
    );
    expect(renamePath("xiongbao/charts/openbot/templates/_helpers.tpl")).toBe(
      "xiongbao/charts/xiongbao/templates/_helpers.tpl",
    );
  });

  test("按路径段处理：作用域包目录与大小写变体", () => {
    expect(renamePath("a/@openbot/shared/OpenBotRole.ts")).toBe(
      "a/@xiongbao/shared/XiongBaoRole.ts",
    );
  });

  test("不含旧名的路径原样返回", () => {
    expect(renamePath("xiongbao/server/src/app.ts")).toBe(
      "xiongbao/server/src/app.ts",
    );
  });
});

describe("isSkipped", () => {
  test("迁移、归档、依赖与锁文件任何阶段都不动", () => {
    expect(isSkipped("xiongbao/server/drizzle/0054_app_role.sql")).toBe(true);
    expect(isSkipped("archives/x.md")).toBe(true);
    expect(isSkipped("xiongbao/node_modules/a/b.js")).toBe(true);
    expect(isSkipped("xiongbao/bun.lock")).toBe(true);
    expect(isSkipped("xiongbao/desktop/bun.lock")).toBe(true);
  });

  test("恢复目录只跳过 sql 与 meta 子目录", () => {
    expect(
      isSkipped("xiongbao/server/recovery/recovery-1/sql/0112_x.sql"),
    ).toBe(true);
    expect(
      isSkipped("xiongbao/server/recovery/recovery-1/meta/_journal.json"),
    ).toBe(true);
    expect(isSkipped("xiongbao/server/recovery/recovery-1/index.ts")).toBe(
      false,
    );
    expect(isSkipped("xiongbao/server/recovery/readme.ts")).toBe(false);
  });

  test("普通源码不跳过，前缀相近的目录不误判", () => {
    expect(isSkipped("xiongbao/server/src/app.ts")).toBe(false);
    expect(isSkipped("xiongbao/server/drizzle-extras/a.ts")).toBe(false);
    expect(isSkipped("archives-old/a.md")).toBe(false);
  });

  test("路径写法 ./ 与反斜杠先归一", () => {
    expect(isSkipped("./archives/x.md")).toBe(true);
    expect(isSkipped("xiongbao\\server\\drizzle\\0001.sql")).toBe(true);
  });
});

describe("isGuardPath", () => {
  test("品牌护栏的代码、测试、白名单、预算与产物词表都算，按前缀匹配", () => {
    for (const path of [
      "xiongbao/scripts/brand/guard/ratchet.ts",
      "xiongbao/scripts/brand/scan-artifact.ts",
      "xiongbao/app/tests/brand-ratchet.test.ts",
      "xiongbao/app/tests/brand-budget.json",
      "xiongbao/app/tests/brand-leak-allowlist.json",
      "xiongbao/app/tests/brand-artifacts/web.json",
      "xiongbao/app/tests/product-name-allowlist.json",
      "./xiongbao/app/tests/brand-web-copy.test.tsx",
    ])
      expect(isGuardPath(path)).toBe(true);
    expect(GUARD_PATHS).toHaveLength(3);
  });

  test("同目录里不属于护栏的文件与相近的目录名不算", () => {
    for (const path of [
      "xiongbao/app/tests/branding.test.ts",
      "xiongbao/app/tests/settings-usage-data.test.tsx",
      "xiongbao/scripts/branded/x.ts",
      "xiongbao/scripts/rebrand/apply.ts",
      "xiongbao/app/src/brand-name.ts",
    ])
      expect(isGuardPath(path)).toBe(false);
  });
});

describe("isBinary", () => {
  test("含 NUL 或不是合法 UTF-8 的是二进制，普通 UTF-8 文本（含中文）不是", () => {
    expect(isBinary(Buffer.from([0x6f, 0, 0x4f]))).toBe(true);
    expect(isBinary(Buffer.from([0x6f, 0xe9, 0x4f, 0x70]))).toBe(true);
    expect(isBinary(Buffer.from("熊宝 openbot\n", "utf8"))).toBe(false);
    expect(isBinary(Buffer.alloc(0))).toBe(false);
  });
});

describe("上游自有地址", () => {
  const kept = [
    "https://github.com/CopilotKit/OpenBot/blob/main/desktop/TELEMETRY.md",
    "https://github.com/CopilotKit/OpenBot.git",
    '"CopilotKit/openbot"',
    "ghcr.io/copilotkit/openbot-server:v1",
    "ghcr.io/copilotkit/openbot-agent-langgraph-agui",
    "ghcr.io/copilotkit/charts/openbot",
    "https://downloads.copilotkit.ai/latest/OpenBot-mac-arm64.dmg",
    "https://dashboard.operations.copilotkit.ai/early-access/openbot?platform=web&utm_campaign=openbot-early-access",
  ];

  test("R1–R3 原样保留，同一行里别的旧名照改", () => {
    for (const phase of ["R1", "R2", "R3"] as const) {
      const protect = loadProtect(phase);
      for (const url of kept) {
        expect(renameText(url, protect)).toBe(url);
        expect(renameText(`${url} openbotRoot`, protect)).toBe(
          `${url} xiongbaoRoot`,
        );
      }
    }
  });

  test("不是上游地址的同名片段不受保护", () => {
    const protect = loadProtect("R1");
    expect(renameText("toolkit/openbot-x", protect)).toBe("toolkit/xiongbao-x");
    expect(renameText("copilotkit-openbot-bucket", protect)).toBe(
      "copilotkit-xiongbao-bucket",
    );
  });

  test("真实文件：发布脚本与发布流程的上游地址在 R1 不变", () => {
    const root = join(import.meta.dir, "../../..");
    for (const [file, address] of [
      ["xiongbao/scripts/release-manifest.ts", '"CopilotKit/openbot"'],
      [
        "xiongbao/.github/workflows/publish-release.yml",
        "'CopilotKit/openbot'",
      ],
    ] as const) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text).toContain(address);
      expect(renameText(text, loadProtect("R1", file))).toContain(address);
    }
  });
});

describe("常量", () => {
  test("VARIANTS 顺序固定：包作用域先于大写，大写先于混合写法", () => {
    expect(VARIANTS.map(([from]) => from)).toEqual([
      "@openbot/",
      "OPENBOT",
      "OpenBot",
      "Openbot",
      "openBot",
      "openbot",
    ]);
    expect(SKIP_PATHS).toContain("archives/");
  });

  test("品牌护栏内联的路径变体表与改名表一致（护栏不 import 改名工具）", () => {
    expect(PATH_VARIANTS).toEqual(VARIANTS);
  });
});

describe("保护清单与源码一致", () => {
  const root = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd: import.meta.dir,
  })
    .stdout.toString()
    .trim();
  // 排除的地方都会"自证"这些文字：设计文档、归档、本工具自己、品牌护栏的白名单与产物词表。
  const excluded = [
    ":(exclude)archives",
    ":(exclude)docs",
    ":(exclude)xiongbao/scripts/rebrand",
    ":(exclude)xiongbao/app/tests/brand-leak-allowlist.json",
    ":(exclude)xiongbao/app/tests/brand-artifacts",
  ];
  const textEntries = readProtectEntries().filter(
    (entry): entry is ProtectEntry & { text: string } =>
      typeof entry.text === "string",
  );

  // 带作用域的条目只在它的文件里找（文件被改名后也认新路径）；全仓条目在整棵树里找。
  const scopeOf = (entry: ProtectEntry) =>
    entry.file ? [entry.file, renamePath(entry.file)] : [];

  async function grep(args: string[], scope: string[]) {
    const proc = Bun.spawn(
      [
        "git",
        "grep",
        ...args,
        "--",
        ...(scope.length > 0 ? scope : [".", ...excluded]),
      ],
      { cwd: root, stdout: "ignore", stderr: "ignore" },
    );
    return (await proc.exited) === 0;
  }

  async function inParallel<T>(
    items: T[],
    check: (item: T) => Promise<boolean>,
  ) {
    const bad: T[] = [];
    const queue = [...items];
    const worker = async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        if (!(await check(item))) bad.push(item);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return bad;
  }

  test("every protect text exists verbatim in the tree", async () => {
    expect(textEntries.length).toBeGreaterThan(0);
    const missing = await inParallel(textEntries, (entry) =>
      grep(["-F", "-q", "-e", entry.text], scopeOf(entry)),
    );
    expect(missing.map((entry) => entry.text)).toEqual([]);
  }, 120_000);

  test("text 条目不拆名：以单词字符结尾的文字，树里每个命中处后面都不紧跟单词字符", async () => {
    const ending = textEntries.filter((entry) => /\w$/.test(entry.text));
    expect(ending.length).toBeGreaterThan(0);
    const splitting = await inParallel(ending, async (entry) => {
      const source = entry.text.replace(/[^\w]/g, (c) => `\\${c}`);
      return !(await grep(["-P", "-q", "-e", `${source}\\w`], scopeOf(entry)));
    });
    expect(splitting.map((entry) => entry.text)).toEqual([]);
  }, 120_000);

  test("带作用域的条目指向的文件都存在", async () => {
    const scoped = readProtectEntries().filter((entry) => entry.file);
    expect(scoped.length).toBeGreaterThan(0);
    const gone = await inParallel(scoped, (entry) =>
      grep(["-q", "-e", "", "-I"], scopeOf(entry)).then(
        (found) => found || existsSync(join(root, entry.file as string)),
      ),
    );
    expect(gone.map((entry) => entry.file)).toEqual([]);
  });
});
