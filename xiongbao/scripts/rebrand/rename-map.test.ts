import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildProtect,
  isSkipped,
  loadProtect,
  type Phase,
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
    expect(renameText("openBotRun OPENBOT_ openbotUrl", none)).toBe(
      "xiongBaoRun XIONGBAO_ xiongbaoUrl",
    );
    expect(renameText("OpenBot Openbot @openbot/x", none)).toBe(
      "XiongBao Xiongbao @xiongbao/x",
    );
  });

  test("环境变量名在 R1 受保护，持久化的凭据标记不被误改", () => {
    expect(renameText("OPENBOT_PUBLIC_URL", p)).toBe("OPENBOT_PUBLIC_URL");
    expect(renameText('"openbot.vault.credential.v2", openbotUrl', p)).toBe(
      '"openbot.vault.credential.v2", xiongbaoUrl',
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
      "const openBotRun = process.env.OPENBOT_PUBLIC_URL ?? openbotUrl;",
      'const label = "openbot.vault.credential.v2"; // Openbot',
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

  test("扩展身份到 R2 就改：带引号的写法也不再被冻结", () => {
    const r2 = loadProtect("R2");
    expect(renameText('"openbot-recorder"', r2)).toBe('"xiongbao-recorder"');
    expect(renameText('"ai.copilotkit.openbot.recorder"', r2)).toBe(
      '"ai.copilotkit.xiongbao.recorder"',
    );
    expect(renameText('"openbot-recorder"', p)).toBe('"openbot-recorder"');
  });

  test("连接串保护带边界：同一标识符不会改一半", () => {
    const text = "postgres://openbot_fixture:x@h/db -U openbot_fixture";
    expect(renameText(text, p)).toBe(
      "postgres://xiongbao_fixture:x@h/db -U xiongbao_fixture",
    );
    // 超级用户 openbot 全仓保护到 R4：用户名保留，以它为前缀的别的名字照改。
    expect(renameText("postgres://openbot:x@h/db -U openbot -d x", p)).toBe(
      "postgres://openbot:x@h/db -U openbot -d x",
    );
    expect(
      renameText(
        "postgres://openbot:x@h/db -U openbot -d x",
        loadProtect("R4"),
      ),
    ).toBe("postgres://xiongbao:x@h/db -U xiongbao -d x");
    // 应用角色的口令随 0054 迁移，角色名本身是库对象；连接串里两处都不动。
    expect(renameText("postgres://openbot_app:openbot@h/openbot_b", p)).toBe(
      "postgres://openbot_app:openbot@h/xiongbao_b",
    );
  });

  describe("真实文件：超级用户角色 openbot 到 R4 才改，库名按文件区分", () => {
    const root = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd: import.meta.dir,
    })
      .stdout.toString()
      .trim();
    const R1 = (path: string) => {
      const source = readFileSync(join(root, path), "utf8");
      return { source, out: renameText(source, loadProtect("R1", path)) };
    };
    const count = (text: string, pattern: RegExp) =>
      (text.match(pattern) ?? []).length;
    // 超级用户出现的各种写法：R1 前后条数必须一样（全部保留旧名），也不能冒出以新名为用户的写法。
    const SUPERUSER = [
      /POSTGRES_USER(?:\s*:\s*|=|:-)["']?openbot\b/g,
      /-U ?["']?openbot\b/g,
      /postgres(?:ql)?:\/\/openbot(?=[:@/])/g,
      /OWNER(?: TO)? ["']?openbot\b/g,
    ];
    const NEW_SUPERUSER =
      /POSTGRES_USER(?:\s*:\s*|=|:-)["']?xiongbao\b|-U ?["']?xiongbao\b|postgres(?:ql)?:\/\/xiongbao[:@/]|OWNER(?: TO)? ["']?xiongbao\b/;
    // 库名：旧名不再出现在 -d、POSTGRES_DB、连接串尾部。
    const OLD_DATABASE =
      /-d openbot\b|POSTGRES_DB(?:\s*:\s*|=)["']?openbot\b|:5432\/openbot(?![\w-])/;

    for (const path of [
      ".github/workflows/ci.yml",
      "xiongbao/docker-compose.yml",
      "xiongbao/scripts/start.sh",
    ]) {
      test(`${path}：超级用户处处仍是 openbot，库名处处一致改成 xiongbao`, () => {
        const { source, out } = R1(path);
        for (const pattern of SUPERUSER) {
          expect(count(out, pattern)).toBe(count(source, pattern));
        }
        expect(out).not.toMatch(NEW_SUPERUSER);
        expect(out).not.toMatch(OLD_DATABASE);
        // 应用角色的口令写在 0054 迁移里，连接串里要保持一致。
        expect(count(out, /openbot_app:openbot(?![\w-])/g)).toBe(
          count(source, /openbot_app:openbot(?![\w-])/g),
        );
        expect(out).not.toMatch(/openbot_app:xiongbao/);
      });
    }

    test("开发 compose 与 start.sh 的库名互相一致，超级用户与 0054 的 FOR ROLE openbot 对得上", () => {
      const compose = R1("xiongbao/docker-compose.yml").out;
      const start = R1("xiongbao/scripts/start.sh").out;
      expect(compose).toMatch(/POSTGRES_DB: xiongbao\b/);
      expect(compose).toMatch(/POSTGRES_USER: openbot\b/);
      expect(start).toMatch(/psql -U openbot -d xiongbao\b/);
      const migration = readFileSync(
        join(root, "xiongbao/server/drizzle/0054_app_role.sql"),
        "utf8",
      );
      expect(migration).toContain("FOR ROLE openbot IN SCHEMA public");
    });

    for (const name of ["postgres-init.sh", "migrate.sh"]) {
      test(`s6/${name}：R1 后与原文逐字相同；R3 起库名才改，超级用户到 R4 才改`, () => {
        const path = `xiongbao/docker/s6/scripts/${name}`;
        const { source, out } = R1(path);
        expect(out).toBe(source);
        const r3 = renameText(source, loadProtect("R3", path));
        expect(r3).not.toMatch(OLD_DATABASE);
        expect(r3).toMatch(/-U openbot\b/);
        const r4 = renameText(source, loadProtect("R4", path));
        expect(r4).not.toMatch(/-U openbot\b/);
        expect(r4).toMatch(/-U xiongbao\b/);
      });
    }

    test("image-smoke.sh：检查交付镜像里的库，库名与应用角色口令都不动", () => {
      const { source, out } = R1("xiongbao/scripts/ci/image-smoke.sh");
      expect(count(out, /-d openbot\b/g)).toBe(count(source, /-d openbot\b/g));
      expect(out).toContain("PGPASSWORD=openbot ");
    });
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

  test("真实清单：环境变量在 R1 受保护、R2 起改名；加密域名到 R3 才改", () => {
    expect(renameText("OPENBOT_PUBLIC_URL", loadProtect("R1"))).toBe(
      "OPENBOT_PUBLIC_URL",
    );
    expect(renameText("OPENBOT_PUBLIC_URL", loadProtect("R2"))).toBe(
      "XIONGBAO_PUBLIC_URL",
    );
    const aad = '"openbot.vault.credential.v2"';
    expect(renameText(aad, loadProtect("R2"))).toBe(aad);
    expect(renameText(aad, loadProtect("R3"))).toBe(
      '"xiongbao.vault.credential.v2"',
    );
    const copyright = "Copyright (c) 2026 CopilotKit";
    expect(renameText(copyright, loadProtect("R4"))).toBe(copyright);
  });

  test("每个条目的 until 与 reason 合法，pattern 能编译", () => {
    const phases = new Set(["R1", "R2", "R3", "R4", "forever"]);
    for (const entry of readProtectEntries()) {
      expect(phases.has(entry.until as Phase | "forever")).toBe(true);
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
