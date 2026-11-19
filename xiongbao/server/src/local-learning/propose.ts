import { generateText, type LanguageModel } from "ai";
import { firstJsonObject } from "../wakerflows/generator";
import type { EvidenceThread } from "./evidence";

/** 模型提出、校验过的一条技能草案，以及它依据的对话。 */
export type ProposedLocalSkill = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  reason: string;
  evidence: EvidenceThread[];
};

/** 和 `POST /api/plugins/skills` 同一条规则：小写字母、数字和连字符，2 到 40 个字符。 */
const SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
/** 一位员工一次最多提几条。少而准：每一条都要本人花时间看。 */
export const MAX_PROPOSALS_PER_AGENT = 2;
/** 至少要有几段对话才学：一次性的请求不是一种做法。 */
export const MIN_THREADS_PER_AGENT = 2;
/** 一次最多给模型看几段对话。 */
const MAX_THREADS_IN_PROMPT = 8;

/**
 * What the model is told. In English like every other text written for a model here; the skill it
 * writes is in Chinese, because it is for a Chinese-speaking person's Bot and they review it.
 */
export const SYSTEM = `You help a person improve one of their AI coworkers ("Bot"). Below are recent conversations between the person and this Bot, shortened and with personal details masked.
Find the things the person repeatedly asks this Bot to do whose method can be fixed, and write each as a "skill": the steps the Bot follows the next time it is asked to do that thing.

Propose a skill only on clear evidence: the same kind of task in at least two conversations, or the person explicitly correcting how the Bot did something (then the skill must contain the corrected way).
Do not propose: one-off requests, small talk, general knowledge the Bot already has, or anything that needs the person's private details to carry out.
Do not repeat a skill that already exists.

Write the instructions to the Bot, in the imperative: what to do first and next, what to do when a step finds nothing, what the final answer must contain, and why the key steps matter.
Never put a specific name, email address, phone number, account, key or file content into a skill; say "the other party", "this file" and so on instead.

Write title, summary, instructions and reason in Simplified Chinese. The slug is lower-case ASCII.

Reply with one JSON object and nothing else:
{"skills":[{"slug":"lower-case letters, digits and hyphens, 2 to 40 characters","title":"Chinese name, at most 20 characters","summary":"one sentence, at most 60 characters","instructions":"Chinese steps","reason":"why this one, citing conversation numbers, at most 60 characters","evidence":[conversation numbers]}]}
If nothing is worth proposing, reply {"skills":[]}. At most ${MAX_PROPOSALS_PER_AGENT} skills.`;

/** 给模型的那段话（英文）：员工是谁、已有哪些技能、对话。导出给测试看模型到底读到了什么。 */
export function proposalPrompt(input: {
  agentName: string;
  existingSkills: string[];
  threads: EvidenceThread[];
}): string {
  const existing =
    input.existingSkills.length > 0
      ? input.existingSkills.map((name) => `- ${name}`).join("\n")
      : "(none yet)";
  const conversations = input.threads
    .slice(-MAX_THREADS_IN_PROMPT)
    .map(
      (thread, index) =>
        `### Conversation ${index + 1}${thread.name ? ` (${thread.name})` : ""}\n${thread.transcript}`,
    )
    .join("\n\n");
  return `Bot: ${input.agentName}\n\nExisting skills:\n${existing}\n\n${conversations}`;
}

export type ProposalCall = (input: {
  model: LanguageModel;
  system: string;
  prompt: string;
  abortSignal: AbortSignal;
}) => Promise<{ text: string }>;

const defaultCall: ProposalCall = (input) =>
  generateText({
    model: input.model,
    system: input.system,
    prompt: input.prompt,
    abortSignal: input.abortSignal,
    // 一次请求就是一次：不确定的失败后重试等于再收一次钱。
    maxRetries: 0,
  });

/**
 * 请模型从一位员工的对话里提技能，校验后返回。
 *
 * 模型的输出整条不信：每一项都按字段检查，不合格的那一项丢掉，不影响别的项；对话编号只认真的
 * 编号。`taken` 是这个人已有的命令名和还在待审的草案名，重名的丢掉。抛错表示模型这次没答上来。
 */
export async function proposeSkills(input: {
  model: LanguageModel;
  agentName: string;
  existingSkills: string[];
  taken: ReadonlySet<string>;
  threads: EvidenceThread[];
  call?: ProposalCall;
  timeoutMs?: number;
}): Promise<ProposedLocalSkill[]> {
  const shown = input.threads.slice(-MAX_THREADS_IN_PROMPT);
  const answer = await (input.call ?? defaultCall)({
    model: input.model,
    system: SYSTEM,
    prompt: proposalPrompt({
      agentName: input.agentName,
      existingSkills: input.existingSkills,
      threads: shown,
    }),
    abortSignal: AbortSignal.timeout(input.timeoutMs ?? 90_000),
  });
  return parseProposals(answer.text, shown, input.taken);
}

/** 模型的回答变成草案；导出给测试。 */
export function parseProposals(
  text: string,
  shown: EvidenceThread[],
  taken: ReadonlySet<string>,
): ProposedLocalSkill[] {
  const parsed = firstJsonObject(text) as { skills?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.skills)) return [];
  const proposals: ProposedLocalSkill[] = [];
  const seen = new Set(taken);
  for (const raw of parsed.skills) {
    if (proposals.length >= MAX_PROPOSALS_PER_AGENT) break;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const skill = raw as Record<string, unknown>;
    const slug = stringOf(skill.slug).toLowerCase();
    const title = stringOf(skill.title);
    const summary = stringOf(skill.summary);
    const instructions = stringOf(skill.instructions);
    const reason = stringOf(skill.reason);
    if (!SLUG.test(slug) || seen.has(slug)) continue;
    if (!title || title.length > 60) continue;
    if (summary.length > 200) continue;
    if (instructions.length < 40 || instructions.length > 6_000) continue;
    const evidence = (Array.isArray(skill.evidence) ? skill.evidence : [])
      .map((n) => (typeof n === "number" ? shown[n - 1] : undefined))
      .filter((thread): thread is EvidenceThread => thread !== undefined);
    // 说不出依据哪段对话的，不算证据充分。
    if (evidence.length === 0) continue;
    seen.add(slug);
    proposals.push({
      slug,
      title,
      summary: summary || title,
      instructions,
      reason: reason.slice(0, 200),
      evidence: [...new Map(evidence.map((t) => [t.threadId, t])).values()],
    });
  }
  return proposals;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
