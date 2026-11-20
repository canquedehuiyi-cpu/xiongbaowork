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
  REFINE_SKILL_TOOL,
  SELF_SKILL_SLUG_PREFIX,
} from "../../../shared/self-skills";
import { textOf } from "../agents/message-text";
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

/**
 * 这件事和哪几条员工自己写的技能对得上：按技能的「什么时候用」和标题里的词有多少出现在这件事的说法里排，
 * 够多才算，最多 `limit` 条。只看员工自己写的（`auto-`），也只看有正文的。
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
    const keys = tokensOf(whenOf(skill));
    if (keys.size === 0) continue;
    let shared = 0;
    for (const key of keys) if (wanted.has(key)) shared += 1;
    const score = shared / keys.size;
    if (shared >= MIN_SHARED_TOKENS && score >= MIN_SHARED_RATIO)
      scored.push({ skill, score });
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
    const shown =
      body.length > RELATED_SKILL_CHARS
        ? `${body.slice(0, RELATED_SKILL_CHARS)}…\n(cut short: call ${REFINE_SKILL_TOOL} with only the id "${skill.slug}" to read the whole skill)`
        : body;
    return `### ${skill.title || skill.slug} (id: ${skill.slug})\n${shown}`;
  });
  return [
    "You have done this kind of work before and wrote down how. The skills below are your own and match what you were just asked; they are already here, nobody needs to send a command for them. Follow their steps and checks where they fit, and skip what this task does not need.",
    `If a step is wrong or something is missing, correct it afterwards with ${REFINE_SKILL_TOOL} (the id and one sentence on what to change).`,
    ...sections,
  ].join("\n\n");
}

/**
 * 这一轮交给员工的技能指引：人点了命令就是那一条；没点，就是员工自己写过、和这件事对得上的那一两条。
 */
export function skillGuidanceFor(
  input: Pick<RunAgentInput, "messages" | "forwardedProps">,
  held: readonly PickableSkill[],
): string | undefined {
  return pickedSkillGuidance(input, held) ?? relatedSkillsGuidance(input, held);
}
