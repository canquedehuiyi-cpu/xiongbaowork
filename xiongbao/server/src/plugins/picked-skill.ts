/**
 * The skill a person picked for a message, and the instructions the Bot is given for it.
 *
 * A skill is picked from the composer's `/` menu, which puts a chip at the start of the message
 * that is sent as `/<command>`. The Bot has to be told what that skill says, and it has to be told
 * by this server: the browser used to send the instructions as a system row of its own, and no Bot
 * read them as instructions. A built-in Bot's runtime drops every system row, and each harness this
 * deployment runs reads a system row that is not the server's own as conversation data, which is
 * right for anything a browser can write. On the Mac Desktop a person's "Pirate haiku" skill was
 * guessed at from its name, and the Bot, asked, said it had been given no instructions.
 *
 * So the server reads the command, checks it against the skills this Bot holds, and puts that
 * skill's stored instructions into the instructions it writes for the run itself: the built-in
 * prompt, or the standing role a remote Bot is sent. Nothing a request carries becomes an
 * instruction; a command only chooses among what the Bot already holds, as typing it does.
 */
import type { RunAgentInput } from "@ag-ui/client";
import { PICKED_SKILL_PROP } from "@openbot/toolkit/run-turn";
import {
  FAST_PATH_CHECK_LABEL,
  FAST_PATH_HEADING,
  READ_SKILL_TOOL,
  REFINE_SKILL_TOOL,
  SELF_SKILL_SLUG_PREFIX,
} from "../../../shared/self-skills";
import { textOf } from "../agents/message-text";
import {
  fingerprintScore,
  MATCH_SIMILARITY,
  type SourceFingerprint,
} from "../skills/source-fingerprint";
import {
  tokensOf as diceTokensOf,
  hasSubstantiveWords,
  similarity,
} from "../text-tokens";
import { latestUserText } from "./selection";

export { PICKED_SKILL_PROP };

/** A skill as a run needs it: its command, its name, what it tells the Bot, and how usable it is. */
export type PickableSkill = {
  slug: string;
  title: string;
  /**
   * The one line the card shows. Read by the held-skills list so a Bot asked what it has can say
   * what each one is for, not only what it is called. Absent in the callers that predate it.
   */
  summary?: string;
  instructions?: string;
  /**
   * 移植时逐条审出来的档位，以及非 `full` 时「缺什么」。
   *
   * 缺省即 `full`：没被审计过的手写技能没有档位，没有档位不等于不能用。`blocked`/`degraded` 的
   * 技能正文照旧会给（人点开就能读到的东西，模型也该读到），另外加一句它在这个部署里跑不成。
   *
   * 类型跟着存储那一行走（`string | null`），认不出的值一律当作没有档位：宁可不说，也不替一条技能
   * 编一个档位出来。三个值的合法性由包加载时校验（`tenant-package.ts`）。
   */
  runnable?: string | null;
  /** 规则名（`shell-command-prose`）。`blockedReasonRef` 才是能给人读的那句。 */
  blockedReason?: string | null;
  blockedReasonRef?: string | null;
  /**
   * 员工自己写的技能：写它时的来源请求的指纹（词的哈希，不是原文），见 `skills/source-fingerprint.ts`。
   * 复盘写出的「什么时候用」很泛，同类请求的字对不上它，靠这个找到。没有就只靠技能自己的字。
   */
  sourceFingerprint?: SourceFingerprint | null;
};

/**
 * The command a message starts with, or undefined.
 *
 * Only at the very start, as the composer's `/` menu only opens there, and only a whole command
 * followed by a space, a line break or the end: "please /pirate-haiku" and "/pirate-haiku," are
 * words, not a pick. Lower-case letters, numbers and hyphens, the characters a command is made of.
 */
export function leadingSkillCommand(text: string): string | undefined {
  return /^\s*\/([a-z0-9]+(?:-+[a-z0-9]+)*)(?=\s|$)/.exec(text)?.[1];
}

/**
 * The command this run was asked to use: the one a headless host stated for its turn, or the one
 * the person's latest message starts with. An earlier message's command is not this run's.
 */
export function pickedSkillCommand(
  input: Pick<RunAgentInput, "messages" | "forwardedProps">,
): string | undefined {
  const props = input.forwardedProps as Record<string, unknown> | undefined;
  const stated = props?.[PICKED_SKILL_PROP];
  if (typeof stated === "string") return stated;
  return leadingSkillCommand(latestUserText(input.messages));
}

/**
 * 这条技能在这个部署里到底能不能照做，作为一句话跟在正文后面（`blocked`/`degraded` 才有）。
 *
 * 放在正文**之后**：前面那句「Follow its instructions for this reply:」得紧挨着正文，否则读起来
 * 就成了「照这条办：<一句提醒> <正文>」。放在末尾也是模型最后读到的那一句。
 */
function gradeNote(skill: PickableSkill): string | undefined {
  const opening =
    skill.runnable === "blocked"
      ? "This deployment cannot run this skill as written."
      : skill.runnable === "degraded"
        ? "This deployment can only partly run this skill as written."
        : undefined;
  if (!opening) return undefined;
  const why = (skill.blockedReasonRef ?? skill.blockedReason)?.trim();
  return [
    opening,
    ...(why ? [`Reason: ${why}`] : []),
    "When a step needs something this deployment does not have, say what is missing rather than acting as if it had been done.",
  ].join(" ");
}

/**
 * What the Bot is told for the skill this run picked among the ones it holds, or undefined when it
 * picked none, picked one the Bot does not hold, or one with no instructions.
 */
export function pickedSkillGuidance(
  input: Pick<RunAgentInput, "messages" | "forwardedProps">,
  held: readonly PickableSkill[],
): string | undefined {
  const command = pickedSkillCommand(input);
  if (!command) return undefined;
  const skill = held.find((candidate) => candidate.slug === command);
  const instructions = skill?.instructions?.trim();
  if (!skill || !instructions) return undefined;
  return [
    `The person picked the skill "${skill.title || skill.slug}" (/${skill.slug}) for their latest message. Follow its instructions for this reply:`,
    instructions,
    gradeNote(skill),
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

/**
 * What this Bot holds, as an index it can read: one line per skill.
 *
 * A Bot that was never told what it holds answered "I have no tool that reads a skill catalogue"
 * while holding a hundred and nine of them. Its instructions only arrive when a message starts with
 * the command, which is the right boundary — a hundred and nine bodies would cost more than the
 * conversation — but the index was never sent at all, so it could not say what it could do, and the
 * person could not ask which command to use.
 *
 * So the index goes in and the bodies stay out. Sorted by command, so the same set of grants is the
 * same bytes every run and a provider can cache the prefix. A skill's grade is one short note here;
 * the reason it cannot run waits for the skill that is actually picked (`gradeNote`).
 */
export function heldSkillsGuidance(
  held: readonly PickableSkill[],
): string | undefined {
  const seen = new Set<string>();
  const lines: string[] = [];
  const byCommand = [...held].sort((one, two) =>
    one.slug < two.slug ? -1 : one.slug > two.slug ? 1 : 0,
  );
  for (const skill of byCommand) {
    if (seen.has(skill.slug)) continue;
    seen.add(skill.slug);
    const summary = skill.summary?.trim();
    lines.push(
      [
        `- /${skill.slug} — ${skill.title || skill.slug}${summary ? `: ${summary}` : ""}`,
        shortGrade(skill),
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  if (lines.length === 0) return undefined;
  return [
    /*
     * 「什么时候给正文」这一句必须说清正文去哪儿了。只说「消息以命令开头才给」，模型会在真的以
     * 命令开头、正文就排在后面的时候仍旧答「我读不到正文」——本地 deepseek 真跑过一次，它列完
     * 清单、把被选那条的正文读进了上下文，却回人一句「我手里只有名字和用途」。所以这句既说条件，
     * 也指出满足条件之后正文在哪一段。
     */
    "These are the skills you hold. Each line is one command you can be given the instructions for. A skill's instructions reach you only when the person's message starts with its command (`/slug`); when that happens they arrive in a section after this one, named picked_skill, and you follow them. Until then you have its name and what it is for, not what it says. When the person asks which skills you have, answer from this list. When what they want is one of them and their message did not start with its command, ask them to send it that way so its instructions reach you.",
    ...lines,
  ].join("\n");
}

/** The one line a list can carry about a skill's grade; the reason waits for the picked one. */
function shortGrade(skill: PickableSkill): string | undefined {
  return skill.runnable === "blocked"
    ? "(this deployment cannot run it as written)"
    : skill.runnable === "degraded"
      ? "(this deployment can only partly run it)"
      : undefined;
}

/** 一轮里最多把几条相关的自写技能直接放进上下文。 */
export const RELATED_SKILL_LIMIT = 2;
/** 每条放进上下文的技能正文最多多少字符；更长的只放开头，全文用 `refine_skill` 只带 id 读出。 */
export const RELATED_SKILL_CHARS = 1400;
/** 技能的「适用场景」里至少有这么多个词（单字词组、英文词）出现在这件事的说法里才算相关。 */
const MIN_SHARED_TOKENS = 4;
/** 技能的「适用场景」里至少这一成的词出现在这件事的说法里才算相关。 */
const MIN_SHARED_RATIO = 0.3;

/** 员工自己写的技能：命令名带 `auto-`。人写的、部署自带的不在这里，它们照旧要点命令才给正文。 */
export const isSelfWrittenSkill = (skill: { slug: string }) =>
  skill.slug.startsWith(SELF_SKILL_SLUG_PREFIX);

/**
 * 一段话拆成的「词」：英文和数字按词，汉字按相邻两字（中文没有空格，两字是最小的有意思的单位）。
 * 文件名里的点和下划线也切开，`actions.csv` 是 `actions` 和 `csv`。
 */
export function tokensOf(text: string): Set<string> {
  const tokens = new Set<string>();
  const lowered = text.normalize("NFKC").toLowerCase();
  for (const word of lowered.match(/[a-z0-9]{2,}/g) ?? []) tokens.add(word);
  for (const run of lowered.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.add(run);
    for (let index = 0; index + 1 < run.length; index += 1)
      tokens.add(run.slice(index, index + 2));
  }
  return tokens;
}

/**
 * 这一轮是在做什么事：最后一条人说的话；那是一句很短的「继续」「好」时，加上第一条，这样追问的那几轮
 * 也认得出还是同一件事。
 */
export function requestTextOf(
  messages: readonly { role?: string; content?: unknown }[],
): string {
  const latest = latestUserText(messages);
  if (latest.length >= 40) return latest;
  const first = messages.find((message) => message.role === "user");
  const opening = first ? textOf(first.content) : "";
  return opening && opening !== latest ? `${opening}\n${latest}` : latest;
}

/** 技能的「什么时候用」：存下来的正文第一段是「适用场景：…」，没有就用摘要。 */
function whenOf(skill: PickableSkill): string {
  const instructions = skill.instructions ?? "";
  const line = /^适用场景：(.*)$/m.exec(instructions)?.[1];
  return `${skill.title} ${line ?? skill.summary ?? ""}`;
}

/** 技能正文第一段「适用场景：…」那一行，没有就是摘要。 */
function whenLineOf(skill: PickableSkill): string {
  return (
    /^适用场景：(.*)$/m.exec(skill.instructions ?? "")?.[1] ??
    skill.summary ??
    ""
  );
}

/**
 * 这条技能和这件事有多对得上，0 到 1，不够格就是 0。两条路，哪条够格取哪条的分：
 * - 词：技能的「什么时候用」和标题里有 {@link MIN_SHARED_TOKENS} 个以上、{@link MIN_SHARED_RATIO} 以上的词出现在
 *   这件事的说法里（原来的规则，分是共有词占技能那边的比例）；
 * - 相似度：来源请求的指纹、「什么时候用」、标题三样，各自和这件事算 Dice 相似度（`text-tokens.ts`，期 1 记忆排序
 *   用的那套），取最高，达到 {@link MATCH_SIMILARITY} 算数。复盘写的「什么时候用」很泛，同类请求的词对不上它，
 *   来源请求的指纹才是比得上的那一样（`skills/source-fingerprint.ts`）。
 */
export function selfSkillScore(
  text: string,
  skill: PickableSkill,
  wanted = tokensOf(text),
): number {
  const keys = tokensOf(whenOf(skill));
  let shared = 0;
  for (const key of keys) if (wanted.has(key)) shared += 1;
  const byWords =
    keys.size > 0 &&
    shared >= MIN_SHARED_TOKENS &&
    shared / keys.size >= MIN_SHARED_RATIO
      ? shared / keys.size
      : 0;
  const request = diceTokensOf(text);
  const best = Math.max(
    skill.sourceFingerprint
      ? fingerprintScore(skill.sourceFingerprint, text)
      : 0,
    similarity(diceTokensOf(whenLineOf(skill)), request),
    similarity(diceTokensOf(skill.title), request),
  );
  return Math.max(byWords, best >= MATCH_SIMILARITY ? best : 0);
}

/**
 * 这件事和哪几条员工自己写的技能对得上（`selfSkillScore`），按分高的在前，最多 `limit` 条。只看员工自己写的
 * （`auto-`），也只看有正文的。
 */
export function relatedSelfSkills<T extends PickableSkill>(
  text: string,
  held: readonly T[],
  limit = RELATED_SKILL_LIMIT,
): T[] {
  const wanted = tokensOf(text);
  if (wanted.size === 0) return [];
  const scored: { skill: T; score: number }[] = [];
  for (const skill of held) {
    if (!isSelfWrittenSkill(skill) || !skill.instructions?.trim()) continue;
    const score = selfSkillScore(text, skill, wanted);
    if (score > 0) scored.push({ skill, score });
  }
  return scored
    .sort((one, two) =>
      two.score !== one.score
        ? two.score - one.score
        : one.skill.slug < two.skill.slug
          ? -1
          : 1,
    )
    .slice(0, limit)
    .map((entry) => entry.skill);
}

/** 技能正文各段的开头（`skills/save-tool.ts` 的 `renderSkill` 写的固定标题），按它切段。 */
const SECTION_START = new RegExp(
  `^(?=适用场景：|${FAST_PATH_HEADING}（|步骤：|注意（踩过的坑）：|怎么确认做对了：|修正记录：)`,
  "m",
);
/** 放不下全文时各段留下的先后：「什么时候用」、快路径（含前提和校验命令）、校验，然后才是步骤、坑点、修正。 */
const SECTION_PRIORITY = [
  "适用场景：",
  `${FAST_PATH_HEADING}（`,
  "怎么确认做对了：",
  "步骤：",
  "注意（踩过的坑）：",
  "修正记录：",
];
/** 别的段只剩这么点位置时就不放半截了；快路径例外，它是要紧的那一段。 */
const MIN_PART_CHARS = 120;

/**
 * 技能正文的简短形式：放得下就是全文。放不下时，带快路径的技能按 {@link SECTION_PRIORITY} 的先后留段（快路径
 * 和校验优先，其次才是步骤和坑点），留下的段仍按原来的次序排；没有快路径的技能照旧只取开头。被截过的结尾带
 * 「…」，调用方据此说明全文怎么读。
 */
export function shortSkillBody(body: string, limit: number): string {
  if (body.length <= limit) return body;
  const parts = body.split(SECTION_START).filter((part) => part.trim());
  const fast = parts.findIndex((part) => part.startsWith(FAST_PATH_HEADING));
  if (fast === -1) return `${body.slice(0, limit)}…`;
  const rank = (part: string) =>
    SECTION_PRIORITY.findIndex((start) => part.startsWith(start));
  const kept = new Set<number>();
  let left = limit;
  const order = parts
    .map((_, index) => index)
    .sort((one, two) => rank(parts[one] ?? "") - rank(parts[two] ?? ""));
  const texts = new Map<number, string>();
  for (const index of order) {
    const part = (parts[index] ?? "").trim();
    const joint = kept.size > 0 ? 2 : 0;
    if (part.length + joint <= left) {
      kept.add(index);
      texts.set(index, part);
      left -= part.length + joint;
    } else if (index === fast || left - joint >= MIN_PART_CHARS) {
      kept.add(index);
      texts.set(index, part.slice(0, Math.max(0, left - joint)));
      left = 0;
    }
  }
  const shown = [...kept]
    .sort((one, two) => one - two)
    .map((index) => texts.get(index) ?? "")
    .join("\n\n");
  return `${shown}…`;
}

/** 注入的技能文字里，技能自带的校验命令（`快路径校验命令：…` 一行），一条一项。 */
export function fastPathChecksIn(text: string): string[] {
  const checks: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith(FAST_PATH_CHECK_LABEL)) continue;
    const check = line.slice(FAST_PATH_CHECK_LABEL.length).trim();
    if (check && !checks.includes(check)) checks.push(check);
  }
  return checks;
}

/**
 * 技能带了快路径时多说的一段：先按快路径做，别从头摸索。第二次没有更快的原因就在这里——只给步骤，员工
 * 照样先逐个打开文件看一遍。校验命令跑过就算校验过，也不必为这件事再单独列计划。
 */
export const FAST_PATH_ADVICE = `这件事你做过。技能里有「${FAST_PATH_HEADING}」的，先按技能的快路径做：把它的脚本一步写好并运行（目录、文件名换成这次的），不要先逐个打开文件探索（请求里写着「先读某个文件」也一样：技能里已经有这类事的做法，要看的东西用一条命令一次查齐，不要一个文件一个文件地读）；技能正文末尾标了「cut short」也不必先去读全文，快路径和校验已经在下面；脚本要填的值得先看一眼的，用一条命令一次查齐（列目录、看输入文件的头几行、看配置），再一步改完并运行。技能已经给了做法，不必去翻以前做过的任务目录，也不要另写请求没要求的说明文件或核对脚本。跑完就运行它自带的${FAST_PATH_CHECK_LABEL.replace("：", "")}，通过就直接交付，不必再多做别的检查，也不必为此单独列计划。快路径对不上这次的输入，或者报错了，再摸索。`;

/**
 * 员工自己写过、和这一轮的事对得上的技能，以简短的形式直接放进上下文（不必等人点命令，也不必等员工想起来去读）：
 * 一条一段，正文超长只放开头，全文用 `refine_skill` 只带 id 读出。没有对得上的就是 undefined。
 */
export function relatedSkillsGuidance(
  input: Pick<RunAgentInput, "messages">,
  held: readonly PickableSkill[],
): string | undefined {
  const related = relatedSelfSkills(requestTextOf(input.messages), held);
  if (related.length === 0) return undefined;
  const sections = related.map((skill) => {
    const body = (skill.instructions ?? "").trim();
    const cut = shortSkillBody(body, RELATED_SKILL_CHARS);
    const shown =
      cut === body
        ? body
        : `${cut}\n(cut short: call ${REFINE_SKILL_TOOL} with only the id "${skill.slug}" to read the whole skill)`;
    return `### ${skill.title || skill.slug} (id: ${skill.slug})\n${shown}`;
  });
  return [
    "You have done this kind of work before and wrote down how. The skills below are your own and match what you were just asked; they are already here, nobody needs to send a command for them. Follow their steps and checks where they fit, and skip what this task does not need.",
    `If a step is wrong or something is missing, correct it afterwards with ${REFINE_SKILL_TOOL} (the id and one sentence on what to change).`,
    ...(related.some((skill) =>
      (skill.instructions ?? "").includes(`${FAST_PATH_HEADING}（`),
    )
      ? [FAST_PATH_ADVICE]
      : []),
    ...sections,
  ].join("\n\n");
}

/** 员工自己写的技能不超过这么多条时，没对上的也把清单放进上下文，让它自己判断。 */
export const SELF_SKILL_LIST_MAX = 5;
/** 清单里每条的「什么时候用」最多放多少字符。 */
const LIST_WHEN_CHARS = 160;

/**
 * 员工自己写的技能不多、这一轮又没有哪条对得上时，给它一份清单：一条一行，标题、id、什么时候用。正文不放，
 * 它觉得对得上就用 `refine_skill` 只带 id 读全文。自动匹配可能漏（请求只是一句指路的话），技能又只有几条，
 * 清单的代价很小，交给员工自己判断。
 *
 * 只随这一条人说的话走（放在 `picked_skill` 那一段，在稳定前缀之后）：同一条消息的每一轮字节相同，前缀不变。
 * 人只回了「继续」「好的」这类没有实词的短话时不放：话题没变，上一条消息那一轮已经放过。
 */
export function selfSkillListGuidance(
  input: Pick<RunAgentInput, "messages">,
  held: readonly PickableSkill[],
): string | undefined {
  const own = held
    .filter((skill) => isSelfWrittenSkill(skill) && skill.instructions?.trim())
    .sort((one, two) =>
      one.slug < two.slug ? -1 : one.slug > two.slug ? 1 : 0,
    );
  if (own.length === 0 || own.length > SELF_SKILL_LIST_MAX) return undefined;
  if (!hasSubstantiveWords(latestUserText(input.messages))) return undefined;
  const lines = own.map((skill) => {
    const when = whenLineOf(skill).replace(/\s+/g, " ").trim();
    return `- ${skill.title || skill.slug} (id: ${skill.slug}) — ${when.length > LIST_WHEN_CHARS ? `${when.slice(0, LIST_WHEN_CHARS)}…` : when}`;
  });
  return [
    `You have written down how you did these kinds of work before. None of them clearly matched what you were just asked, so their steps are not here. If one of them fits this task, read it whole with ${REFINE_SKILL_TOOL} (only its id) and follow it where it fits; if none fits, ignore this list.`,
    ...lines,
  ].join("\n");
}

/**
 * 这一轮交给员工的技能指引：人点了命令就是那一条；没点，就是员工自己写过、和这件事对得上的那一两条；
 * 都没有，员工自己写的技能不多时是一份清单（`selfSkillListGuidance`）。
 */
export function skillGuidanceFor(
  input: Pick<RunAgentInput, "messages" | "forwardedProps">,
  held: readonly PickableSkill[],
): string | undefined {
  return (
    pickedSkillGuidance(input, held) ??
    relatedSkillsGuidance(input, held) ??
    selfSkillListGuidance(input, held)
  );
}

/** 清单里最多放几条员工自己写的技能；超过这个数，没有对得上的就不放清单（它们在持有技能的索引里）。 */
export const OWN_SKILL_LIST_MAX = 8;
/** 清单里每一条（标题、id、什么时候用、标记）最多多少字符。 */
export const OWN_SKILL_LINE_CHARS = 160;
/** 清单里对得上这件事的那条后面的标记。 */
const MATCH_MARK = " [MATCH]";

/**
 * 员工自己写的技能，以一份清单放进系统提示（正文不放）：一条一行，标题、id、什么时候用；和这件事对得上的
 * （`relatedSelfSkills`）排在最前并标 MATCH，告诉员工先读它。要用哪条就用 `read_skill` 只带 id 读全文，读出的
 * 全文和快路径的做法提示留在对话历史里（{@link readSkillText}），不再每一步都带着正文。
 *
 * 放在 `picked_skill` 那一段（稳定前缀之后），同一条消息的每一步字节相同。技能不超过 {@link OWN_SKILL_LIST_MAX} 条
 * 时没对上的也列出来，让员工自己判断（人只回「继续」这类没有实词的短话时，没有对上的就不放）；更多时只放对上的。
 */
export function ownSkillsGuidance(
  input: Pick<RunAgentInput, "messages">,
  held: readonly PickableSkill[],
): string | undefined {
  const own = held
    .filter((skill) => isSelfWrittenSkill(skill) && skill.instructions?.trim())
    .sort((one, two) =>
      one.slug < two.slug ? -1 : one.slug > two.slug ? 1 : 0,
    );
  if (own.length === 0) return undefined;
  const matched = relatedSelfSkills(requestTextOf(input.messages), own);
  if (matched.length === 0) {
    if (own.length > OWN_SKILL_LIST_MAX) return undefined;
    if (!hasSubstantiveWords(latestUserText(input.messages))) return undefined;
  }
  const shown =
    own.length > OWN_SKILL_LIST_MAX
      ? matched
      : [...matched, ...own.filter((skill) => !matched.includes(skill))];
  const lines = shown.map((skill) => {
    const mark = matched.includes(skill) ? MATCH_MARK : "";
    const head = `- ${skill.title || skill.slug} (id: ${skill.slug}) — `;
    const room = Math.max(0, OWN_SKILL_LINE_CHARS - head.length - mark.length);
    const when = whenLineOf(skill).replace(/\s+/g, " ").trim();
    return `${head}${when.length > room ? `${when.slice(0, Math.max(0, room - 1))}…` : when}${mark}`;
  });
  return [
    `Skills you wrote down from earlier work. None is loaded: read one in full with ${READ_SKILL_TOOL} (only its id).`,
    matched.length > 0
      ? `The ones marked MATCH fit this request: read them first and follow their steps and checks where they fit, skipping what this task does not need. If a step is wrong or missing, correct it afterwards with ${REFINE_SKILL_TOOL} (the id and one sentence on what to change).`
      : "None clearly fits this request: if one does, read it and follow it where it fits; otherwise ignore the list.",
    ...lines,
  ].join("\n");
}

/**
 * 员工用 `read_skill` 读一条自己的技能时得到的：技能全文；带快路径的，再加上先按快路径做的提示
 * （{@link FAST_PATH_ADVICE}），一并留在对话历史里，不必再每一步放进提示。
 */
export function readSkillText(skill: {
  slug: string;
  title: string;
  instructions: string;
}): string {
  const body = skill.instructions.trim();
  return [
    `### ${skill.title || skill.slug} (id: ${skill.slug})`,
    "This is your own skill, written from earlier work. Follow its steps and checks where they fit, and skip what this task does not need.",
    ...(body.includes(`${FAST_PATH_HEADING}（`) ? [FAST_PATH_ADVICE] : []),
    body,
  ].join("\n\n");
}

/**
 * 这一轮对得上的员工自己写的技能里带的校验命令（`快路径校验命令：…`），由服务器从技能里算出来，不看提示里写了什么：
 * 技能正文不再放进提示，改完文件后「跑过技能自带的校验就算验过」仍要认得它们。
 */
export function matchedSkillChecks(
  input: Pick<RunAgentInput, "messages">,
  held: readonly PickableSkill[],
): string[] {
  const checks: string[] = [];
  for (const skill of relatedSelfSkills(requestTextOf(input.messages), held))
    for (const check of fastPathChecksIn(skill.instructions ?? ""))
      if (!checks.includes(check)) checks.push(check);
  return checks;
}

/**
 * 内置员工这一轮的技能指引：人点了命令就是那一条（正文照旧给）；没点，就是员工自己写的技能清单
 * （{@link ownSkillsGuidance}）。
 */
export function builtInSkillGuidanceFor(
  input: Pick<RunAgentInput, "messages" | "forwardedProps">,
  held: readonly PickableSkill[],
): string | undefined {
  return pickedSkillGuidance(input, held) ?? ownSkillsGuidance(input, held);
}
