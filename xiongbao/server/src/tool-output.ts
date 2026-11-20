/**
 * 大段的工具输出：存进员工的工作区，回传里只给头、尾和文件路径（期七）。
 *
 * 为什么：评测 #713 里历史中的工具结果约占一轮 token 的七成，命令输出和读文件各到 64KB，一份大输出要在这一轮
 * 之后的每一步里再发一遍。Codex 的做法是在约 10KB 处截断；这里在 {@link OUTPUT_INLINE_BYTES} 处截，但不丢：
 * 完整内容存进工作区的 `tool-outputs/`，员工要看中间，按行段读（`computer_read_file` 的 offset/limit）或搜索
 * （`computer_grep`），看的是自己要的那几行，不是整份再发一遍。
 *
 * 目录用不带点的 `tool-outputs/`：`computer_grep` 和列目录都会跳过隐藏目录，放进 `.xxx/` 就搜不到了。
 *
 * 阈值（字节，按 UTF-8 算，更接近 token 数：16KB 的中文约 5 千字、几千 token，16KB 的代码约 4～5 千 token）：
 *  - {@link OUTPUT_INLINE_BYTES} = 16KB：不超过的原样回传，绝大多数命令输出和小文件都在它以内，不受影响。
 *    比 Codex 的 10KB 略宽：多数 `npm test` 的输出在 10～16KB 之间，尾部的失败摘要正是要看的，宁可原样给。
 *  - 超过则给头 {@link OUTPUT_HEAD_BYTES}（2KB，命令的回显、版本和第一个错误）和尾 {@link OUTPUT_TAIL_BYTES}
 *    （4KB，退出前的最后输出、测试汇总），合计约 6KB，比原来最大的 64KB 少约 9 成。
 *
 * 网页正文的上限更小：{@link WEB_FETCH_INLINE_BYTES}（8KB），经 `spill` 的 `inlineBytes` 传入；头尾的取法不变。
 *
 * 写文件走网关自己的写入（`computer_write_file` 的同一条路：策略、审批、审计都照常），在原调用的审批上下文之外
 * （这一次写没有对话可以问，要问的写入直接放弃）。写不进去（没有电脑、策略不让写、项目只读）就退回截断，
 * 并说明没存成，员工知道这份输出不完整，可以换个更窄的命令。
 */
import { outsideApprovalContext } from "./approvals/types";
import type { ComputerSeat } from "./computer/computer-key";
import type { ActionActor, ComputerGateway } from "./computer/gateway";

/** 不超过这么多字节的输出原样回传。 */
export const OUTPUT_INLINE_BYTES = 16 * 1024;
/** 超过时回传的开头和结尾各留多少字节。 */
export const OUTPUT_HEAD_BYTES = 2 * 1024;
export const OUTPUT_TAIL_BYTES = 4 * 1024;
/** 完整输出存在工作区的这个目录里。 */
export const WORKSPACE_OUTPUT_DIR = "tool-outputs";

/*
 * token 第五轮·每一步的体积：历史里的工具结果每一步都要再发一遍，一份 16KB 的命令输出（约 4～5 千 token）在最近 4 步里
 * 原样留着，后段每步就是 2～3 万 token。所以命令输出和没指定行段的读文件各自再收紧，网页正文已经是 8KB。
 * 都是环境变量可回退：设 `off` 回到 {@link OUTPUT_INLINE_BYTES}（16KB）和原来的头尾取法，设数字取那么多字节。
 */
/** `computer_run_command` 的输出不超过这么多字节原样回传（原为 16KB，用户 2026-11-20 批准降到 4KB）。部署用 `XIONGBAO_COMMAND_INLINE_BYTES` 覆盖（设 16384 或 off 回到原来的行为）。 */
export const COMMAND_INLINE_BYTES = 4 * 1024;
/** 没指定行段的 `computer_read_file` 不超过这么多字节原样回传（原为 16KB）。部署用 `XIONGBAO_READ_INLINE_BYTES` 覆盖。 */
export const READ_INLINE_BYTES = 12 * 1024;

type Env = Record<string, string | undefined>;

/** 读一个字节数的环境变量：没设、不是正整数当没设（用默认值），`off` 回到 16KB。 */
function bytesFromEnv(raw: string | undefined, fallback: number): number {
  const text = raw?.trim().toLowerCase();
  if (!text) return fallback;
  if (text === "off") return OUTPUT_INLINE_BYTES;
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function commandInlineBytes(env: Env = process.env): number {
  return bytesFromEnv(env.XIONGBAO_COMMAND_INLINE_BYTES, COMMAND_INLINE_BYTES);
}

export function readInlineBytes(env: Env = process.env): number {
  return bytesFromEnv(env.XIONGBAO_READ_INLINE_BYTES, READ_INLINE_BYTES);
}

/** 安装、构建类命令成功时只留最后几行（`XIONGBAO_QUIET_BUILD_OUTPUT=off` 关掉）。 */
export function quietOutputOn(env: Env = process.env): boolean {
  return env.XIONGBAO_QUIET_BUILD_OUTPUT?.trim().toLowerCase() !== "off";
}

const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");

/** 超过没有：字节数超过 `limit`（默认 {@link OUTPUT_INLINE_BYTES}）。 */
export function exceedsInline(
  text: string,
  limit: number = OUTPUT_INLINE_BYTES,
): boolean {
  // 字符数乘 3 是 UTF-8 的上界，不超过它就一定不超过 limit，省掉对每段短文字数字节。
  return text.length * 3 > limit && bytesOf(text) > limit;
}

/** 前面整行整行取，不超过 `budget` 字节；第一行就超过时按字符硬切。 */
function headOf(text: string, budget: number): string {
  let used = 0;
  let end = 0;
  for (;;) {
    const next = text.indexOf("\n", end);
    const stop = next === -1 ? text.length : next + 1;
    const size = bytesOf(text.slice(end, stop));
    if (used + size > budget) break;
    used += size;
    end = stop;
    if (stop >= text.length) break;
  }
  if (end > 0) return text.slice(0, end);
  // 一整行比预算还长（压缩过的脚本、一行的 JSON）：硬切到预算以内。
  let cut = Math.min(text.length, budget);
  while (cut > 0 && bytesOf(text.slice(0, cut)) > budget) cut -= 1;
  return text.slice(0, cut);
}

/** 后面整行整行取，不超过 `budget` 字节；最后一行就超过时按字符硬切。 */
function tailOf(text: string, budget: number): string {
  let used = 0;
  let start = text.length;
  while (start > 0) {
    const previous = text.lastIndexOf("\n", start - 2);
    const from = previous === -1 ? 0 : previous + 1;
    const size = bytesOf(text.slice(from, start));
    if (used + size > budget) break;
    used += size;
    start = from;
  }
  if (start < text.length) return text.slice(start);
  let cut = Math.max(0, text.length - budget);
  while (cut < text.length && bytesOf(text.slice(cut)) > budget) cut += 1;
  return text.slice(cut);
}

const linesIn = (text: string) =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/** 头、尾和中间省略了多少的说明；够短（头尾已经盖住全文）时原样返回。 */
export function excerpt(
  text: string,
  head = OUTPUT_HEAD_BYTES,
  tail = OUTPUT_TAIL_BYTES,
): { text: string; omittedBytes: number; omittedLines: number } {
  if (bytesOf(text) <= head + tail)
    return { text, omittedBytes: 0, omittedLines: 0 };
  const first = headOf(text, head);
  const last = tailOf(text.slice(first.length), tail);
  const omittedBytes = bytesOf(text) - bytesOf(first) - bytesOf(last);
  const omittedLines = Math.max(
    0,
    linesIn(text) - linesIn(first) - linesIn(last),
  );
  return {
    text: `${first}${first.endsWith("\n") ? "" : "\n"}…（中间省略 ${omittedLines} 行，约 ${omittedBytes} 字节）…\n${last}`,
    omittedBytes,
    omittedLines,
  };
}

/** 前面最多 `budget` 字节（按字符切，不拆开多字节字符）。 */
function headBytes(text: string, budget: number): string {
  let cut = Math.min(text.length, budget);
  while (cut > 0 && bytesOf(text.slice(0, cut)) > budget) cut -= 1;
  return text.slice(0, cut);
}

/** 工作区里这份输出的路径：`tool-outputs/<时间>-<工具>-<调用编号前八位>.txt`。 */
export function outputPath(
  tool: string,
  id: string,
  now: Date = new Date(),
): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
  const name = tool.replace(/[^\w]+/g, "_").slice(0, 40) || "tool";
  const short = id.replace(/[^\w]+/g, "").slice(0, 8) || "x";
  return `${WORKSPACE_OUTPUT_DIR}/${stamp}-${name}-${short}.txt`;
}

/** 把一份输出存进工作区，答存到哪儿了；存不了就答空。 */
export type OutputSink = (file: {
  tool: string;
  id: string;
  contents: string;
}) => Promise<string | undefined>;

/**
 * 经网关把输出写进这位员工的工作区。写不进去（策略不让、要问人、电脑没起来、项目只读）一律答空，
 * 调用方退回截断；不抛。
 */
export function workspaceOutputSink(options: {
  gateway: Pick<ComputerGateway, "writeFile">;
  seat: ComputerSeat;
  actor: ActionActor;
  now?: () => Date;
  signal?: AbortSignal;
}): OutputSink {
  return async ({ tool, id, contents }) => {
    const path = outputPath(tool, id, (options.now ?? (() => new Date()))());
    try {
      // 在发出这一次工具调用的审批上下文之外：这一次写没有对话可以问，要问的就放弃。
      await outsideApprovalContext(() =>
        options.gateway.writeFile(
          options.seat,
          options.actor,
          { path, contents },
          options.signal,
        ),
      );
      return path;
    } catch {
      return undefined;
    }
  };
}

/** {@link workspaceOutputSink} 用在 web 工具上：到调用时才查这位员工有没有电脑可以存。 */
export function lazyWorkspaceOutputSink(
  resolve: () => Promise<
    | {
        gateway: Pick<ComputerGateway, "writeFile">;
        seat: ComputerSeat;
        actor: ActionActor;
      }
    | undefined
  >,
): OutputSink {
  return async (file) => {
    const target = await resolve().catch(() => undefined);
    return target ? workspaceOutputSink(target)(file) : undefined;
  };
}

/** 一份超过阈值的输出，处理后的样子。 */
export type Spilled = {
  /** 完整内容存在工作区的这个路径；没存成就没有。 */
  savedTo?: string;
  /** 一句话告诉员工这份输出被怎么处理了，以及怎么看全文。 */
  note: string;
  /** 回传里放进去的那一段：存了盘是头尾；没存成按 `keep` 截。输出里有几个字段，每个字段各过一遍。 */
  show: (text: string) => string;
};

/**
 * 超过 {@link OUTPUT_INLINE_BYTES} 的输出：存盘；存不了就截断并说明。没超过答 null，调用方原样回传。
 *
 * `keep`：存不了时留什么。命令输出留头和尾（结果在尾）；网页正文留开头。
 */
export async function spill(input: {
  tool: string;
  id: string;
  /** 要存的完整内容。 */
  full: string;
  /** 判断超不超的那份文字，默认就是 `full`。 */
  measured?: string;
  sink?: OutputSink;
  keep?: "head-and-tail" | "head";
  /** 内联上限（字节），默认 {@link OUTPUT_INLINE_BYTES}；网页正文用更小的。 */
  inlineBytes?: number;
  /** 存了盘时回传的头和尾各留多少字节，默认 {@link OUTPUT_HEAD_BYTES}、{@link OUTPUT_TAIL_BYTES}。 */
  head?: number;
  tail?: number;
}): Promise<Spilled | null> {
  const limit = input.inlineBytes ?? OUTPUT_INLINE_BYTES;
  const measured = input.measured ?? input.full;
  if (!exceedsInline(measured, limit)) return null;
  const size = bytesOf(measured);
  const savedTo = await input.sink?.({
    tool: input.tool,
    id: input.id,
    contents: input.full,
  });
  if (savedTo)
    return {
      savedTo,
      note: `完整内容（约 ${size} 字节）已存到工作区的 ${savedTo}，这里只给了开头和结尾。要看中间，用 computer_read_file 读这个文件，offset 和 limit 按行段读；要找什么，用 computer_grep 在里面搜索。`,
      show: (text) => excerpt(text, input.head, input.tail).text,
    };
  if (input.keep === "head")
    return {
      note: `内容约 ${size} 字节，超过了 ${limit} 字节，已截断，只留下开头；这位员工没有电脑可以存全文。需要后面的部分，请换一个更具体的来源。`,
      show: (text) => headBytes(text, limit),
    };
  return {
    note: `输出约 ${size} 字节，超过了 ${limit} 字节，已截断，只留下开头和结尾，完整内容没能存下来。需要中间的部分，请换一个只输出那部分的命令（加 grep、head、tail 之类）。`,
    show: (text) => excerpt(text, limit / 4, (limit * 3) / 4).text,
  };
}

/** 命令输出收紧后，存了盘时头和尾各留多少：4KB 的线留 1KB 头加 2.5KB 尾，回退到 16KB 时用原来的 2KB 加 4KB。 */
function commandExcerptBytes(limit: number): { head?: number; tail?: number } {
  if (limit >= OUTPUT_INLINE_BYTES) return {};
  return { head: Math.floor(limit / 4), tail: Math.floor((limit * 5) / 8) };
}

/** 一段命令算安装或构建：包管理器的安装、构建脚本、make、cargo/go 构建、tsc。 */
const QUIET_SEGMENT =
  /^(?:cd\s+\S+|(?:npm|pnpm|yarn|bun)\s+(?:(?:install|i|ci|add)\b|(?:run\s+)?build\b)|(?:pip3?|python3?\s+-m\s+pip|uv\s+pip)\s+install\b|(?:sudo\s+)?apt(?:-get)?\s+install\b|cargo\s+(?:build|install|fetch)\b|go\s+(?:build|mod\s+download)\b|make\b|tsc\b|poetry\s+install\b|uv\s+sync\b)/;

/**
 * 整条命令都是安装或构建（用 `&&` 连起来的每一段都是）：成功时只有最后几行有用，前面是一长串下载和编译进度。
 * 带管道、`;`、`||`，或者后面还跑了别的脚本的不算：那些命令的输出就是员工要看的结果。
 */
export function isQuietCommand(command: string): boolean {
  if (/[|;\n`$]|\|\|/.test(command)) return false;
  const segments = command
    .split("&&")
    .map((part) => part.trim())
    .filter(Boolean);
  return (
    segments.length > 0 && segments.every((part) => QUIET_SEGMENT.test(part))
  );
}

/** 成功的安装或构建命令回传的行数，和低于这个字节数不动。 */
const QUIET_KEEP_LINES = 12;
const QUIET_MIN_BYTES = 1_500;

const lastLines = (text: string, count: number) => {
  const all = text.split("\n");
  const trailing = all[all.length - 1] === "" ? 1 : 0;
  const kept = all.slice(Math.max(0, all.length - trailing - count));
  return {
    text: kept.join("\n"),
    omitted: Math.max(0, all.length - trailing - count),
  };
};

/** `computer_run_command` 的结果里，超过阈值的输出换成头尾，并说明完整内容在哪儿。 */
export async function offloadCommandResult<
  T extends {
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  },
>(
  result: T,
  context: { id: string; sink?: OutputSink },
): Promise<T & { outputFile?: string; outputNote?: string }> {
  const full = [
    `$ ${result.command}`,
    `[exit ${result.exitCode}]`,
    "--- stdout ---",
    result.stdout,
    ...(result.stderr ? ["--- stderr ---", result.stderr] : []),
  ].join("\n");
  // 安装、构建成功了：前面的进度没人看，只留最后几行，完整的存盘。
  if (
    result.exitCode === 0 &&
    quietOutputOn() &&
    isQuietCommand(result.command) &&
    bytesOf(result.stdout) + bytesOf(result.stderr) > QUIET_MIN_BYTES
  ) {
    const out = lastLines(result.stdout, QUIET_KEEP_LINES);
    const err = lastLines(result.stderr, QUIET_KEEP_LINES);
    if (out.omitted + err.omitted > 0) {
      const savedTo = await context.sink?.({
        tool: "computer_run_command",
        id: context.id,
        contents: full,
      });
      const marker = (omitted: number) =>
        omitted > 0 ? `…（前面省略 ${omitted} 行）…\n` : "";
      return {
        ...result,
        stdout: `${marker(out.omitted)}${out.text}`,
        stderr: `${marker(err.omitted)}${err.text}`,
        ...(savedTo ? { outputFile: savedTo } : {}),
        outputNote: savedTo
          ? `命令成功（退出码 0），安装或构建的进度输出只留了最后 ${QUIET_KEEP_LINES} 行；完整内容存到工作区的 ${savedTo}，要看用 computer_read_file 按行段读。`
          : `命令成功（退出码 0），安装或构建的进度输出只留了最后 ${QUIET_KEEP_LINES} 行，前面的没有存下来；要看完整输出，换一个只输出那部分的命令。`,
      };
    }
  }
  const limit = commandInlineBytes();
  const spilled = await spill({
    tool: "computer_run_command",
    id: context.id,
    measured: `${result.stdout}${result.stderr}`,
    full,
    inlineBytes: limit,
    ...commandExcerptBytes(limit),
    ...(context.sink ? { sink: context.sink } : {}),
  });
  if (!spilled) return result;
  return {
    ...result,
    stdout: spilled.show(result.stdout),
    stderr: spilled.show(result.stderr),
    ...(spilled.savedTo ? { outputFile: spilled.savedTo } : {}),
    outputNote: spilled.savedTo
      ? `${spilled.note}文件里 stdout 在 --- stdout --- 之后，stderr 在 --- stderr --- 之后。`
      : spilled.note,
  };
}

/**
 * 没指定行段的 `computer_read_file`：结果超过阈值（{@link READ_INLINE_BYTES}）时只给头尾，并说明共多少行、怎么按行段读。
 * 文件本来就在工作区里，不再抄一份；读的是只读文件夹（`root`）里的文件也一样，提示里带上 root。指定了 offset 或 limit
 * 的读，员工自己选了范围，原样给。
 */
export async function shrinkFileRead<
  T extends { path: string; text: string; bytes: number },
>(
  result: T,
  asked: {
    root?: string | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
  },
): Promise<T & { outputNote?: string }> {
  if (asked.offset !== undefined || asked.limit !== undefined) return result;
  const limit = readInlineBytes();
  if (!exceedsInline(result.text, limit)) return result;
  const where = asked.root ? `（root 同样填 ${asked.root}）` : "";
  // 收紧之后头多尾少（文件的开头比结尾有用）；回退到 16KB 时用原来的取法。
  const shown =
    limit >= OUTPUT_INLINE_BYTES
      ? excerpt(result.text)
      : excerpt(result.text, Math.floor(limit * 0.375), Math.floor(limit / 8));
  return {
    ...result,
    text: shown.text,
    outputNote: `这个文件有 ${result.bytes} 字节、共 ${linesIn(result.text)} 行，这里只给了开头和结尾。要看中间，用 computer_read_file 读 ${result.path}${where}，offset 和 limit 按行段读；要找什么，用 computer_grep 搜索。`,
  };
}
