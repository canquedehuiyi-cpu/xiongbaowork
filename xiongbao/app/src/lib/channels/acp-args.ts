/*
 * 外部员工那一步在参数里报出来的那几件事（标题、动了哪些文件、参数有没有长到没往下发），两条通道读同一份：
 * 对话里单独成行的那一步（`chat-transcript.ServerToolLine`）和步骤列表里的同名一步
 * （`tool-activity.detailsOf`）。同一件事在两处必须是同一句话，所以这句话只在这里写一次。
 *
 * 形状由服务器定（`server/src/agents/acp/translate.ts` 的 `argsOf`）：`{title, kind, locations,
 * rawInput}`；参数长到装不下时换成 `{title, kind, locations, rawInputTruncated, rawInputLength}`。这里
 * 跟着它读，读不懂的一律不写——宁缺一句说明，不编一个事实。原长度没有（这一步在 `rawInputLength` 之前
 * 存下来的）就只说省略，不补一个数。
 *
 * `kind` 不在摘要里重复：那一步是哪一类动作，行首的中文标签已经说了（「正在改文件」，见
 * `shared/tool-name.ts` 的 ACP_STEP_WORDS），协议名不上对话是那里立下的规矩。
 */

/** 标题是一行小字，不是第二段说明：太长就截给这一行看。 */
const TITLE_LIMIT = 80;
/** 文件路径比标题更容易长（一层层目录压在一起），给的宽度也窄一些。 */
const PATH_LIMIT = 60;

type Loose = Record<string, unknown>;

function record(value: unknown): Loose | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Loose)
    : null;
}

/** 一句写得出来的话：不是字符串、空串、全是空格，都算没有。 */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cut(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/** 解得开的调用参数才是对象；解不开（还在流上、没写全）就当没有。 */
function parsed(value: string): Loose | null {
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

export type AcpStepFacts = {
  /** 这一步自己起的标题（「Run bun test」）。 */
  title?: string;
  /** 这一步报它要动的文件，按它报的顺序。 */
  paths: string[];
  /** 参数太长，原样没有往上下发。 */
  truncated: boolean;
  /** 原参数有多长，只在服务器带出 `rawInputLength` 时才有。 */
  length?: number;
};

/**
 * 从调用参数里读出这几件事：给 JSON 字符串（对话那一通道）或已经解开的对象（步骤列表那一通道）都一样。
 * 读不出任何一件时为 null，画的人就不写。
 */
export function readAcpStep(value: unknown): AcpStepFacts | null {
  const args = typeof value === "string" ? parsed(value) : record(value);
  if (!args) return null;
  const title = text(args.title);
  const paths = Array.isArray(args.locations)
    ? args.locations.flatMap((location) => {
        const path = text(record(location)?.path);
        return path === undefined ? [] : [path];
      })
    : [];
  const truncated = args.rawInputTruncated === true;
  // 一样都没读出来就当这一步没报过什么：这一行不写，也不写一个空的分隔符。
  if (!title && paths.length === 0 && !truncated) return null;
  const facts: AcpStepFacts = { paths, truncated };
  if (title) facts.title = title;
  const length = args.rawInputLength;
  if (typeof length === "number" && Number.isInteger(length) && length >= 0)
    facts.length = length;
  return facts;
}

/**
 * 这一行的小字：自己起的标题，它动的文件（一个就写名字，多个写第一个加「等 N 个文件」），参数没往下发时
 * 说一句并且带上原长度。三样都没有就没有这一行。
 */
export function acpStepDetail(value: unknown): string | undefined {
  const facts = readAcpStep(value);
  if (!facts) return undefined;
  const parts: string[] = [];
  if (facts.title) parts.push(cut(facts.title, TITLE_LIMIT));
  // 路径在 `readAcpStep` 里就过了「不是空串」那一关，所以这里只当有没有。
  const first = facts.paths[0];
  if (first) {
    const name = cut(first, PATH_LIMIT);
    const files =
      facts.paths.length === 1
        ? name
        : `${name} 等 ${facts.paths.length} 个文件`;
    parts.push(files);
  }
  if (facts.truncated) {
    const omitted =
      facts.length === undefined
        ? "参数过长已省略"
        : `参数过长已省略（原长 ${facts.length} 字）`;
    parts.push(omitted);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
