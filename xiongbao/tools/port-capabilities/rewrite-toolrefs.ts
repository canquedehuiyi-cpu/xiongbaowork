/**
 * P3 改写层：把审计判为 blocked / degraded 的技能正文改写成「本环境能读懂」的版本。
 *
 * 方案 §5.2 的两个动作，缺一不可：
 * 1. **映射改写**：`Read(/Write(/Edit(/MultiEdit(` 这四个括号形态是 openbot 有近似物的工具，
 *    改写成 `computer_read_file(` / `computer_write_file(`。Glob/Grep/WebFetch/Task 没有等价物，
 *    **保留原文**——伪造一个「grep 函数」只会让模型以为自己在 Linux 上（方案 §5.2 的 shim 裁定）。
 * 2. **环境事实段**：正文首部插入一段散文，说明 shell 不存在、文件读写走 computer_*、
 *    需要真执行命令时交给「在我电脑上跑」。blocked 技能的 shell 调用**原样保留**——它们是
 *    降级说明的证据，抹掉它们等于把 blocked 伪装成 full。
 *
 * 档位纪律（与 audit-toolrefs 的契约）：
 * - blocked 改写后重审计必须仍 blocked：环境事实段是散文（无括号形态、无命令词 + shell 特征），
 *   原调用逐字保留，所以档位不可能变好。这是本模块的单测钉住的契约。
 * - degraded 改写后 file-tool-call 不再命中，重审计升 full——方案 §「degraded 为 0 是改写层
 *   完成度的标志位」。若正文还有 Task/Glob 等无映射命中，仍是 degraded。
 * - full 的正文一个字符都不动：改写层只服务被审计判定的正文，没有「顺手统一格式」的职责。
 *
 * 幂等：环境事实段以标题行为标记，二次进入直接跳过插入；映射改写后 `Read(` 形态已不存在，
 * 二次扫描无命中。两路叠加，重复运行是恒等变换（单测钉住）。
 */

/** 环境事实段标题；也是幂等标记——正文里已有这段就不再插入。 */
export const ENVIRONMENT_FACTS_HEADING = "## 环境事实（移植时改写）";

/** openbot 有近似物、值得做名字映射的源环境工具 → openbot 工具名。 */
export const TOOL_REF_REWRITES: Readonly<Record<string, string>> =
  Object.freeze({
    Read: "computer_read_file",
    Write: "computer_write_file",
    Edit: "computer_write_file",
    MultiEdit: "computer_write_file",
  });

/** 没有等价物的工具：保留原文，由环境事实段点名，不伪造 shim。 */
export const UNMAPPED_TOOL_NAMES: readonly string[] = Object.freeze([
  "Glob",
  "Grep",
  "WebFetch",
  "Task",
]);

/**
 * 与 audit-toolrefs 的 file-tool-call 规则同一个词表，但**形态更严：括号必须紧跟工具名**。
 *
 * 审计侧用 `\s*\(` 是有意的——它宁可多判（`Bash (shell)`、`Write (URL scheme)` 这类散文记法会被判成
 * 调用，mapping.ts 已把这条记为「接受的假阳性」）。改写层不能用同一条形态：把 `Write (URL scheme)`
 * 这个**章节小标题**替换成 `computer_write_file (URL scheme)`，命中消失、重审计升 full，等于用「正文
 * 被改坏」换来一枚「完整可用」。2026-11-14 实测：271 条技能里只有 things-mac 一条走到这一步，而它
 * 唯一的命中就是这样一个标题，代价是整条管线在「档位不许变好」的守卫处崩掉。
 *
 * 因此：带空格的形态一律视为散文，原样保留——它仍然是 degraded（悲观但不说谎），由审计口径负责；
 * 改写层只对「确定是调用」（`Read(` / `Write(` / `Edit(` / `MultiEdit(`）动手。
 */
const MAPPED_CALL = /\b(Read|Write|Edit|MultiEdit)\(/g;

/** 环境事实段的正文。blocked 与 degraded 用同一段：散文不构成任何审计命中形态。 */
const ENVIRONMENT_FACTS_BLOCK = [
  ENVIRONMENT_FACTS_HEADING,
  "",
  "- 本环境没有 shell，也没有 `Bash` 这类工具；正文里的 shell 命令是源环境的写法，仅作参考。",
  "- 文件读写只有 `computer_read_file` / `computer_write_file`（作用于你自己的电脑，不是服务端容器）；",
  "  没有 `Glob` / `Grep` / `WebFetch`，也没有子代理 `Task`。",
  "- 需要真正执行命令时，把这一步交给「在我电脑上跑」，不要伪造执行结果。",
  "",
].join("\n");

export interface RewriteInput {
  slug: string;
  instructions: string;
}

export interface RewriteResult {
  /** 改写后的正文。full 输入原样返回。 */
  instructions: string;
  /** 本次调用是否改变了正文（幂等检查用）。 */
  changed: boolean;
  /** 被映射替换的括号调用次数。 */
  rewrittenToolCalls: number;
  /** 改写后正文仍提到的无映射工具（按出现顺序去重）。 */
  unmappedMentioned: string[];
  /** 审计判定的档位，回显给调用方（本函数不重新判定）。 */
  level: "full" | "degraded" | "blocked";
}

/**
 * Rewrite one capability body according to its audit level.
 *
 * The unmapped list is scanned **after** the rewrite, on the result text: a tool that only appeared
 * inside a rewritten call (`Read(`) must not be reported as still mentioned.
 */
export function rewriteInstructions(
  input: RewriteInput,
  level: RewriteResult["level"],
): RewriteResult {
  if (level === "full") {
    return {
      instructions: input.instructions,
      changed: false,
      rewrittenToolCalls: 0,
      unmappedMentioned: [],
      level,
    };
  }
  const { slug, instructions } = input;

  let rewrittenToolCalls = 0;
  const mapped = instructions.replace(MAPPED_CALL, (_whole, name: string) => {
    rewrittenToolCalls += 1;
    void slug;
    return `${TOOL_REF_REWRITES[name]}(`;
  });

  const unmappedMentioned = UNMAPPED_TOOL_NAMES.filter((name) =>
    new RegExp(`\\b${name}\\b`).test(mapped),
  );

  if (mapped.includes(ENVIRONMENT_FACTS_HEADING)) {
    // 幂等路径：段落已在（上一次运行插入），映射替换也必然是 0 命中。
    return {
      instructions: mapped,
      changed: mapped !== instructions,
      rewrittenToolCalls,
      unmappedMentioned,
      level,
    };
  }

  // 插在首个 H1 之后（保持文档结构）；没有 H1 时放最前面。
  const firstHeading = mapped.search(/^# .+$/m);
  let withFacts: string;
  if (firstHeading === -1) {
    withFacts = `${ENVIRONMENT_FACTS_BLOCK}${mapped}`;
  } else {
    const lineEnd = mapped.indexOf("\n", firstHeading);
    const at = lineEnd === -1 ? mapped.length : lineEnd + 1;
    withFacts = `${mapped.slice(0, at)}\n${ENVIRONMENT_FACTS_BLOCK}${mapped.slice(at)}`;
  }

  return {
    instructions: withFacts,
    changed: withFacts !== instructions,
    rewrittenToolCalls,
    unmappedMentioned,
    level,
  };
}
