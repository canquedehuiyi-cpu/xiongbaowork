/**
 * DoD-7：主路径上一共有多少行是纯英文的？
 *
 * 「纯英文文字行 = 0（品牌名、模型名、邮箱示例除外）」是验收口径，而它要的是**数出来的行数**，不是一句
 * 「看起来都中文了」。这个文件只做分类：给一批已经渲染出来的文字行，判断哪几行是纯英文、哪几行按口径可
 * 以豁免、豁免的理由是什么。
 *
 * 渲染不在这里。主路径的路由得挂进 happy-dom、用真的路由树和真的组件画一遍，而「DOM 什么时候存在」
 * 决定了 Base UI 和 React DOM 在模块求值时就定下来的那些分支（见 `app/tests/preload.ts` 的注释）——只有
 * `bun test` 的 preload 能把这件事做对，`app/src/lib/marks.ts` 里的 `import.meta.glob` 也只有在那条路径上
 * 才是被替身接住的。所以：**规则在本文件，渲染在 `app/tests/i18n-dom-scan.test.tsx`**，数出来的账记在
 * `app/tests/i18n-dom-budget.json`。
 *
 * 一条判据，两处取舍：
 *
 * - 行里**有汉字**就不算纯英文。中英混排（「用 GPT-4o 回答」）是中文界面里正常的样子，DoD-7 罚的是整行
 *   只有英文的那种，不是夹了英文词的那种。
 * - 行里**没有汉字、也没有拉丁字母**（数字、时间、百分号、`·`）同样不算。它本来就不需要翻译。
 *
 * 剩下的就是要把英文抠掉的候选。**豁免按「抠掉之后还剩不剩拉丁字母」判**：一行里只要品牌名、模型名、
 * 邮箱、地址、版本号、格式名把英文占满了，它就不是没翻的文案；只要抠完还剩一个词，那就是给英文受众写的
 * 一句话，逐条列出来给人看。
 */

/** 有汉字就算中文行。 */
const HAN = /\p{Script=Han}/u;
/** 有拉丁字母才可能是纯英文行。 */
const LATIN = /[A-Za-z]/;

/**
 * 行里可以整段抠掉、且不影响「这行是文案」判断的东西。每条都带名字，报告里按名字分组，读者能一眼看出
 * 一行是因为什么被放过的。
 */
const ALLOWED: readonly { readonly why: string; readonly pattern: RegExp }[] = [
  /*
   * 时区：`GMT+01:00（Africa/Casablanca）`。
   *
   * 这不是应用的文案，是浏览器 `Intl` 的时区列表：多数时区有中文名（「中国标准时间」），少数没有，
   * 于是 ICU 退回 `GMT+01:00` 加括号里的 IANA 标识符。`/settings/notifications` 的时区下拉把它
   * 整个画出来，三十七行都是这个形状——把 `Africa/Casablanca` 翻成中文反而对不上任何时区。
   *
   * 只认这个精确形态（`GMT` + 偏移 + 全角括号里的区域/城市），不认「括号里有斜杠」，免得把
   * 真正的句子放过。
   */
  {
    why: "时区名",
    pattern: /GMT[+-]\d{2}:\d{2}（[A-Za-z0-9_+/-]+）/g,
  },
  // 单独的年月日时间：`2026-11-14`、`14:20`。分割之后还会有残片，所以再单列一条。
  {
    why: "时间",
    pattern: /\b\d{1,4}[-/:.]\d{1,2}(?:[-/:.]\d{1,4})?(?::\d{2})?\b/g,
  },
  // 邮箱示例：DoD-7 点名豁免。
  { why: "邮箱示例", pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  // 地址：协议头或 `www.`，跟着一串不含空白的字符。
  { why: "地址", pattern: /\b(?:https?:\/\/|www\.)[^\s，。；、）)]+/gi },
  // 版本号。要求至少两个点，免得把 `1.5` 这种小数当成版本。
  { why: "版本号", pattern: /\bv?\d+\.\d+\.\d+(?:[.-][\w.]+)*/gi },
  // 模型名：厂商名打头，带型号后缀。DoD-7 点名豁免。
  {
    why: "模型名",
    pattern:
      /\b(?:gpt|o[1-4](?:-mini)?|claude|gemini|gemma|llama|qwen|kimi|deepseek|mistral|mixtral|phi|command|granite|titan|nova|sonnet|opus|haiku|text-embedding|whisper|dall-e)[\w.:-]*/gi,
  },
  /*
   * 品牌与产品名：DoD-7 点名豁免。只列**这个名字本身**，不列它所在的句子——`Connect your GitHub account`
   * 抠掉 `GitHub` 还剩三个词，照样是违规，这正是应该被抓的那种。
   *
   * `waker` / `wakerflow` 是本产品自己的功能名，界面上一向按原样写（侧栏的「@Waker」、能力的「WakerFlow」
   * 页签），和上游品牌同一类，不算没翻的文案。
   *
   * `xiongbao(?:\s+work)?` 是**两词写法**：产品英文名是 `XiongBao Work`（`appConfig.brand.englishName`），
   * `/desktop-return` 三处都画着它。只列 `xiongbao` 的话，抠掉前半截还剩一个 `Work`，整行会被判成
   * 没翻的英文——那是判据的错，不是页面的。
   */
  {
    why: "品牌名",
    pattern:
      /\b(?:openai|anthropic|google|microsoft|apple|amazon|meta|github|gitlab|gmail|slack|notion|linear|jira|figma|asana|trello|discord|telegram|wechat|wecom|zoom|dropbox|salesforce|hubspot|stripe|vercel|cloudflare|sentry|datadog|postgresql|postgres|docker|kubernetes|playwright|browserbase|composio|arcade|copilotkit|copilot|mcp|wakerflow|waker|xiongbao(?:\s+work)?)\b/gi,
  },
  /*
   * 格式、单位、协议缩写：`PDF`、`CSV`、`JSON`、`MB`、`CPU`。**白名单，不是「全大写就算」**：后者会把
   * `WORK RECORD` 这种全大写的眉标当成缩写放过，而那正是一行没翻的英文。
   */
  {
    why: "缩写",
    pattern:
      /\b(?:PDF|CSV|JSON|XML|HTML|CSS|SVG|PNG|JPG|JPEG|GIF|WEBP|MP3|MP4|WAV|ZIP|API|URL|URI|HTTP|HTTPS|SQL|UUID|CPU|GPU|RAM|KB|MB|GB|TB|MS|ID|AI|LLM|MCP|SDK|CLI|UI|UX|OK)\b/g,
  },
  /*
   * 键名：`Shift`、`Enter`、`Cmd`。键盘上印的那个字，中文界面里一向照抄，`⇧` 和 `Shift` 是同一个东西
   * 的两种画法。**白名单而不是「首字母大写的单词」**：后者会把 `Settings`、`Cancel` 一起放过，那正是
   * 要抓的没翻的文案。
   */
  {
    why: "键名",
    pattern:
      /\b(?:Shift|Ctrl|Control|Cmd|Command|Alt|Option|Enter|Return|Tab|Esc|Escape|Space|Backspace|Delete|Home|End|PageUp|PageDown)\b/g,
  },
  /*
   * 语言与格式的名字：`JavaScript`、`Markdown`。写在这些字段的标签上（`/admin/playground` 的
   * 代码框就叫 `HTML` / `CSS` / `JavaScript`），中文界面里一向照抄，翻成「爪哇脚本」才是错。
   *
   * 和「缩写」分开列，因为判断依据不同：那一桶是「这个写法在中文里就是它」，这一桶是
   * 「这个技术本身只有这一个名字」。同样是白名单，不是「首字母大写就算」。
   */
  {
    why: "技术名词",
    pattern: /\b(?:JavaScript|TypeScript|Markdown|YAML|GraphQL|WebSocket)\b/g,
  },
  // 形态像 id 的串：`agent_7f3a`、`8f3a2b1c`、`sk-live-…`。必须含数字，免得把普通单词当 id 放过。
  { why: "标识符", pattern: /\b(?=[\w-]*\d)[\w-]{6,}\b/g },
];

/** 一行文字行的判决。 */
export type Verdict =
  | { readonly kind: "chinese" }
  | { readonly kind: "no-letters" }
  | { readonly kind: "allowed"; readonly why: readonly string[] }
  | { readonly kind: "english"; readonly rest: string };

/**
 * 这一行怎么算。
 *
 * `rest` 是抠掉豁免之后剩下的那段，写在报告里：一行被判成纯英文时，扣掉品牌名和邮箱以后它还剩下什么，
 * 正是要改的那部分文案。
 */
export function verdictOf(line: string): Verdict {
  if (HAN.test(line)) return { kind: "chinese" };
  if (!LATIN.test(line)) return { kind: "no-letters" };
  /*
   * 一两个字母的纯拉丁行是**画上去的字形**，不是文案。
   *
   * 唯一的实例：「员工们正在休息」后面那个 `z`（`work-record-banner.tsx:190`，`aria-hidden="true"` 的
   * 小字号上标），画的是一声睡觉的 z。它旁边的说明行也是 `aria-hidden`，却由 `aria-describedby` 指着、
   * 屏幕上真看得见——所以按 `aria-hidden` 整棵跳过是错的，那会连工作台九个应用格子的说明行一起跳掉。
   * 按长度判才对：一到两个字母写不成一句话。
   *
   * 这类行在报告里单列成「装饰字形」，逐条可查。`OK`、`AI` 这类两字母缩写也会落进来，无害。
   */
  if (line.length <= 2 && /^[A-Za-z]+$/.test(line))
    return { kind: "allowed", why: ["装饰字形"] };
  let rest = line;
  const why: string[] = [];
  for (const { why: name, pattern } of ALLOWED) {
    const before = rest;
    rest = rest.replace(pattern, " ");
    if (rest !== before) why.push(name);
  }
  if (LATIN.test(rest)) return { kind: "english", rest: collapse(rest) };
  return why.length > 0 ? { kind: "allowed", why } : { kind: "no-letters" };
}

/** 抠完豁免留下的空格压成一个，好读。 */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 一个路由扫出来的账。 */
export type RouteScan = {
  /** 这个路由在应用里的地址。 */
  readonly at: string;
  /** 渲染出来的、非空的文字行。 */
  readonly lines: readonly string[];
  /**
   * 地址里的参数值（`/admin/components/$name` 的 `button`）。
   *
   * 它们会原样显示在页面上——标题、回显、面包屑——而它们**不是这个应用的文案**：组件就叫
   * `button`，工具就叫 `issues`，把标题翻成「按钮」反而对不上任何东西。这类行只做整行相等比较，
   * 不做子串：一句「找不到 button」里有汉字，仍然按中文行算，不会被这条豁免放过。
   */
  readonly identifiers?: readonly string[];
};

/** 一个路由扫出来的结果：违规行逐条，豁免行按理由归类计数。 */
export type RouteReport = {
  readonly at: string;
  readonly lines: number;
  readonly chinese: number;
  readonly violations: readonly {
    readonly line: string;
    readonly rest: string;
  }[];
  readonly allowed: ReadonlyMap<string, readonly string[]>;
};

/** 数一个路由。 */
export function scanRoute(route: RouteScan): RouteReport {
  let chinese = 0;
  const violations: { line: string; rest: string }[] = [];
  const allowed = new Map<string, string[]>();
  for (const line of route.lines) {
    const verdict = verdictOf(line);
    if (verdict.kind === "chinese") {
      chinese += 1;
    } else if (route.identifiers?.includes(line)) {
      /*
       * 整行等于地址参数值：这是标识符，不是文案。放在 `verdictOf` 之后判，是为了让中文行先落进
       * 中文那一栏——参数值碰巧含汉字（`slug: "总结"`）时它仍算中文。
       */
      const bucket = allowed.get("地址参数") ?? [];
      bucket.push(line);
      allowed.set("地址参数", bucket);
    } else if (verdict.kind === "english") {
      violations.push({ line, rest: verdict.rest });
    } else if (verdict.kind === "allowed") {
      for (const why of verdict.why) {
        const bucket = allowed.get(why) ?? [];
        bucket.push(line);
        allowed.set(why, bucket);
      }
    }
  }
  return {
    at: route.at,
    lines: route.lines.length,
    chinese,
    violations,
    allowed,
  };
}

/** 一张报告的正文，逐行读得下去的那种。 */
export function report(reports: readonly RouteReport[]): string {
  const out: string[] = [];
  const total = reports.reduce((sum, one) => sum + one.violations.length, 0);
  const rows = reports
    .map((one) => ({
      at: one.at,
      lines: one.lines,
      chinese: one.chinese,
      english: one.violations.length,
    }))
    .sort((a, b) => b.english - a.english || a.at.localeCompare(b.at));

  out.push("DoD-7 主路径纯英文文字行扫描");
  out.push("");
  out.push(
    [
      "路由".padEnd(28),
      "文字行".padStart(6),
      "中文".padStart(6),
      "纯英文".padStart(8),
    ].join(""),
  );
  for (const row of rows) {
    out.push(
      [
        row.at.padEnd(28),
        String(row.lines).padStart(6),
        String(row.chinese).padStart(6),
        String(row.english).padStart(8),
      ].join(""),
    );
  }
  out.push("");
  out.push(`合计：${reports.length} 个路由，${total} 行纯英文。`);

  const withFindings = reports.filter((one) => one.violations.length > 0);
  if (withFindings.length > 0) {
    out.push("");
    out.push("纯英文行（要改的）：");
    for (const one of withFindings) {
      out.push(`  ${one.at}`);
      for (const finding of one.violations) {
        out.push(`    ${JSON.stringify(finding.line)}`);
        out.push(`      扣除豁免后：${JSON.stringify(finding.rest)}`);
      }
    }
  }

  const exemptions = new Map<string, string[]>();
  for (const one of reports) {
    for (const [why, lines] of one.allowed) {
      const bucket = exemptions.get(why) ?? [];
      bucket.push(...lines.map((line) => `${one.at}  ${line}`));
      exemptions.set(why, bucket);
    }
  }
  if (exemptions.size > 0) {
    out.push("");
    out.push("按口径豁免的行（品牌名、模型名、邮箱示例等）：");
    for (const why of [...exemptions.keys()].sort()) {
      out.push(`  ${why}`);
      for (const line of [...new Set(exemptions.get(why) ?? [])].sort())
        out.push(`    ${line}`);
    }
  }

  return out.join("\n");
}
