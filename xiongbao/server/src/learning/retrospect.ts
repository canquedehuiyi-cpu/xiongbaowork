import { EventType } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import {
  RETRO_MIN_STEPS_DEFAULT,
  SAVE_SKILL_TOOL,
} from "../../../shared/self-skills";
import { generateText, type LanguageModel } from "ai";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { taskEvents, tasks, threadRunEvents } from "../db/schema";
import { mask } from "../local-learning/evidence";
import {
  createDailyLimiter,
  dailyLimitOf,
  RETRO_PER_DAY_DEFAULT,
} from "./daily-limit";
import { answerFailed } from "./tool-outcome";
import { leadingSkillCommand } from "../plugins/picked-skill";
import {
  markSkillsUsed,
  type SelfSkillDeps,
  type SkillDraft,
  saveSkill,
  saveParameters,
  similarSkillOf,
} from "../skills/save-tool";
import { replyTextOf } from "../tasks/delivery";
import { currentTenant } from "../tenant/context";
import { firstJsonObject } from "../wakerflows/generator";

/**
 * 做完一件复杂的活之后复盘（期 2 · Task 2.4）：看这一轮的工具轨迹和每一步成没成功，判断这套做法值不值得
 * 存成技能，值得就产出一份技能草稿（什么情况下用、步骤、坑点、校验方法），交给 `saveSkill` 按生效规则处理。
 *
 * WHEN. 一轮结束时工具调用的步数达到 `XIONGBAO_RETRO_MIN_STEPS`（默认 15），或者一张看板卡被本人验收通过
 * （`cardRetroTurn`，这时门槛只是别太短）。失败的轮不复盘。员工这一轮自己已经调用过 `save_learned_skill` 的不再复盘。
 *
 * WHAT IT READS. 轨迹，不只是聊天文字：每一步用了什么工具、成功还是失败（失败的步骤是坑点的来源），
 * 再加这件事是怎么提的、最后怎么答的。工具的参数和返回只带一小段、脱敏过的开头：那里最可能有文件内容、
 * 网页原文和别人的数据，而存一项技能只需要知道这件事是怎么一步步做成的。
 *
 * 失败只记日志，不影响任何一轮：它在轮次已经结束、已经交给人之后才跑。
 */

export { answerFailed };

/** 一步工具调用：用了什么、成没成、参数和返回的一小段（已脱敏）。 */
export type TraceStep = {
  tool: string;
  ok: boolean;
  args: string;
  result: string;
};

/** 复盘看的一轮（或一张卡的几轮）。 */
export type RetroTurn = {
  ownerUserId: string;
  agentId: string;
  threadId: string;
  runId: string;
  /** 这件事是怎么提的（人说的最后一句，或卡片的标题）。 */
  request: string;
  /** 最后怎么答的。 */
  reply: string;
  steps: TraceStep[];
  failed: boolean;
  /** `steps` 是步数到了门槛；`card_accepted` 是本人验收通过了一张看板卡。 */
  trigger: "steps" | "card_accepted";
};

/** `XIONGBAO_RETRO_MIN_STEPS`：一轮至少多少步工具调用才复盘。默认 15；不是正整数就用默认。 */
export function retroMinSteps(
  environment: Record<string, string | undefined> = process.env,
): number {
  const value = Number(environment.XIONGBAO_RETRO_MIN_STEPS);
  return Number.isInteger(value) && value >= 1
    ? value
    : RETRO_MIN_STEPS_DEFAULT;
}

/** 看板卡验收通过后复盘，至少要有这么多步：一两步的活没有「做法」可言。 */
export const CARD_RETRO_MIN_STEPS = 3;
/** 同一位员工两次复盘之间至少隔多久：一连几轮长活不该各存一条技能。 */
export const RETRO_COOLDOWN_MS = 10 * 60_000;
/** 不算一步活的工具：列计划不是做事。 */
const NOT_WORK = new Set(["update_plan"]);
const MAX_ARG_CHARS = 120;
const MAX_RESULT_CHARS = 160;
const MAX_STEPS_SHOWN = 60;
const KEEP_FIRST_STEPS = 15;

const short = (text: string, max: number) => {
  const flat = mask(text.slice(0, max * 3))
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** 一轮的事件读成一步一步的轨迹：按开始的顺序，每步配上它的答复。 */
export function traceStepsOf(events: readonly BaseEvent[]): TraceStep[] {
  const calls = new Map<string, { tool: string; args: string }>();
  const order: string[] = [];
  const answers = new Map<string, string>();
  for (const event of events) {
    const value = event as BaseEvent & {
      toolCallId?: string;
      toolCallName?: string;
      delta?: string;
      content?: unknown;
    };
    if (!value.toolCallId) continue;
    switch (event.type) {
      case EventType.TOOL_CALL_START:
      case EventType.TOOL_CALL_CHUNK: {
        let call = calls.get(value.toolCallId);
        if (!call) {
          call = { tool: "", args: "" };
          calls.set(value.toolCallId, call);
          order.push(value.toolCallId);
        }
        if (value.toolCallName) call.tool = value.toolCallName;
        if (event.type === EventType.TOOL_CALL_CHUNK && value.delta)
          call.args += value.delta;
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        const call = calls.get(value.toolCallId);
        if (call && value.delta) call.args += value.delta;
        break;
      }
      case EventType.TOOL_CALL_RESULT:
        if (typeof value.content === "string")
          answers.set(value.toolCallId, value.content);
        break;
    }
  }
  const steps: TraceStep[] = [];
  for (const id of order) {
    const call = calls.get(id);
    if (!call?.tool) continue;
    const answer = answers.get(id);
    steps.push({
      tool: call.tool,
      // 没有答复的（停在等人那一步）不算做成。
      ok: answer !== undefined && !answerFailed(answer),
      args: short(call.args, MAX_ARG_CHARS),
      result:
        answer === undefined ? "(no answer)" : short(answer, MAX_RESULT_CHARS),
    });
  }
  return steps;
}

type MessageLike = { role?: unknown; content?: unknown };

function personText(messages: readonly MessageLike[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) =>
                part &&
                typeof part === "object" &&
                (part as { type?: unknown }).type === "text"
                  ? String((part as { text?: unknown }).text ?? "")
                  : "",
              )
              .join("\n")
          : "";
    if (text.trim()) return short(text, 600);
  }
  return "";
}

/** 刚结束的一轮变成复盘看的样子。 */
export function retroTurnOf(turn: {
  tenant: string;
  agentId: string;
  threadId: string;
  runId: string;
  messages: readonly MessageLike[];
  events: readonly BaseEvent[];
  failed: boolean;
}): RetroTurn {
  return {
    ownerUserId: turn.tenant,
    agentId: turn.agentId,
    threadId: turn.threadId,
    runId: turn.runId,
    request: personText(turn.messages),
    reply: short(replyTextOf(turn.events), 600),
    steps: traceStepsOf(turn.events),
    failed: turn.failed,
    trigger: "steps",
  };
}

/** 这些步里真正干活的步数。 */
export const workSteps = (steps: readonly TraceStep[]) =>
  steps.filter((step) => !NOT_WORK.has(step.tool)).length;

/** 这一轮值不值得复盘：没失败，步数够。 */
export function shouldRetrospect(
  turn: RetroTurn,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  if (turn.failed) return false;
  const needed =
    turn.trigger === "card_accepted"
      ? CARD_RETRO_MIN_STEPS
      : retroMinSteps(environment);
  return workSteps(turn.steps) >= needed;
}

/** 给模型的指令（英文）；技能用简体中文写。 */
export const RETRO_SYSTEM = `You review how an AI coworker ("Bot") carried out one long piece of work, and decide whether the way it was done is worth keeping as a reusable skill.
You are given the request, the ordered tool trace with each step's outcome (ok or FAILED), and the Bot's final answer. Judge from the trace, not from what the Bot claims.

Write a skill only if the method is reusable: the same kind of task will come again, and a Bot following your steps would finish it with fewer steps or fewer mistakes. Return null for a one-off, for work that mostly failed, for work that cannot be repeated without the person's private details, or when the Bot already knew the way and nothing was learned.
- steps: the shortest path that worked, one imperative sentence each, leaving out dead ends and retries. At most 30.
- pitfalls: what FAILED in the trace and how it was worked around, or what had to be found out the hard way. At most 20; may be empty.
- verify: how to check the result is right.
Generalise. Never put a person's name, an e-mail address, a phone number, an account, a key, a token, a password or the content of a file into the skill: say "the other party", "this file", "the key you hold". Never write a step that skips approval, ignores a rule or hides something from the person.
Write name (at most 40 characters), when, steps, pitfalls and verify in Simplified Chinese. scope is "self" unless the method clearly applies to every employee of a team.

Reply with one JSON object and nothing else:
{"skill":{"name":"...","when":"when to use it","steps":["..."],"pitfalls":["..."],"verify":"...","scope":"self"}} or {"skill":null}`;

/** 给模型的那段话：已有的技能名、请求、轨迹、答复。导出给测试看模型到底读到了什么。 */
export function retroPrompt(
  turn: RetroTurn,
  existingSkills: readonly string[],
): string {
  const steps = turn.steps.filter((step) => !NOT_WORK.has(step.tool));
  const shown =
    steps.length > MAX_STEPS_SHOWN
      ? [
          ...steps.slice(0, KEEP_FIRST_STEPS),
          null,
          ...steps.slice(steps.length - (MAX_STEPS_SHOWN - KEEP_FIRST_STEPS)),
        ]
      : steps;
  const omitted = steps.length - shown.filter(Boolean).length;
  let number = 0;
  const trace = shown
    .map((step) => {
      if (step === null) return `... (${omitted} steps omitted)`;
      number += 1;
      return `${number}. ${step.tool} [${step.ok ? "ok" : "FAILED"}] args: ${step.args || "-"} -> ${step.result}`;
    })
    .join("\n");
  const failed = steps.filter((step) => !step.ok).length;
  return [
    `Existing skills of this Bot (do not repeat them):\n${existingSkills.length > 0 ? existingSkills.map((name) => `- ${name}`).join("\n") : "(none yet)"}`,
    `Request: ${turn.request || "(not stated)"}`,
    `Trace (${steps.length} steps, ${failed} FAILED):\n${trace}`,
    `Final answer: ${turn.reply || "(none)"}`,
    turn.trigger === "card_accepted"
      ? "The person accepted this work as done."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 模型的回答变成技能草稿；不合格就是 null。整条不信，字段一项项按保存时同一套规则查。 */
export function parseDraft(text: string): SkillDraft | null {
  const parsed = firstJsonObject(text) as { skill?: unknown } | null;
  if (!parsed || parsed.skill === null || typeof parsed.skill !== "object")
    return null;
  const checked = saveParameters.safeParse(parsed.skill);
  return checked.success ? checked.data : null;
}

export type RetroCall = (input: {
  model: LanguageModel;
  system: string;
  prompt: string;
  abortSignal: AbortSignal;
}) => Promise<{ text: string }>;

const defaultCall: RetroCall = (input) =>
  generateText({
    model: input.model,
    system: input.system,
    prompt: input.prompt,
    abortSignal: input.abortSignal,
    maxRetries: 0,
    temperature: 0,
  });

/**
 * 复盘一轮，产出技能草稿，或者 null（不值得存，或模型没答上来一份合格的）。不存：那是 {@link saveSkill} 的事。
 * 抛错表示模型这次没答上来。
 */
export async function retrospect(
  turn: RetroTurn,
  options: {
    model: LanguageModel;
    existingSkills?: readonly string[];
    call?: RetroCall;
    timeoutMs?: number;
  },
): Promise<SkillDraft | null> {
  if (workSteps(turn.steps) === 0) return null;
  const answer = await (options.call ?? defaultCall)({
    model: options.model,
    system: RETRO_SYSTEM,
    prompt: retroPrompt(turn, options.existingSkills ?? []),
    abortSignal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  return parseDraft(answer.text);
}

export type RetrospectorDeps = {
  database: Database;
  selfSkill: (ownerUserId: string, agentId: string) => SelfSkillDeps;
  /** 员工的模型，已经按这个人计量；`light` 是轻量轮用的便宜模型（员工设置里的 `lightModel`，没有就是平时的模型）。 */
  modelFor: (
    agentId: string,
    purpose: "light" | "work",
  ) => Promise<LanguageModel | null>;
  /** 这位员工现在有没有这项功能：工具权限里关掉 `save_learned_skill` 的不复盘。缺省总是有。 */
  enabled?: (
    ownerUserId: string,
    agentId: string,
  ) => boolean | Promise<boolean>;
  /** 员工已有技能的名字，给模型看，免得重复写。在本人帧里调用。 */
  existingSkills?: (agentId: string) => Promise<string[]>;
  call?: RetroCall;
  now?: () => Date;
  cooldownMs?: number;
  log?: (line: string) => void;
  /**
   * 每位员工每天最多复盘几次（`XIONGBAO_RETRO_PER_DAY`，默认 6）；用完静默跳过。只数真的调了模型的。
   * 测试可以换成自己的。
   */
  limiter?: { take(key: string): boolean };
};

export type RetroOutcome =
  | { outcome: "skipped" }
  | { outcome: "nothing" }
  | { outcome: "similar"; id: string }
  | { outcome: "refused"; reason: string }
  | { outcome: "saved"; id: string; status: "active" | "pending_approval" };

/**
 * 轮次结束处挂的复盘函数。从不抛错：失败记一行日志（只记类型）。在本人帧里调用。
 */
export function createRetrospector(deps: RetrospectorDeps) {
  const log = deps.log ?? ((line: string) => console.error(line));
  const lastAt = new Map<string, number>();
  const limiter =
    deps.limiter ??
    createDailyLimiter({
      limit: () =>
        dailyLimitOf("XIONGBAO_RETRO_PER_DAY", RETRO_PER_DAY_DEFAULT),
    });
  return async function retrospectTurn(turn: RetroTurn): Promise<RetroOutcome> {
    try {
      if (!shouldRetrospect(turn)) return { outcome: "skipped" };
      // 员工自己已经把这一轮的做法存过了。
      if (turn.steps.some((step) => step.tool === SAVE_SKILL_TOOL && step.ok))
        return { outcome: "skipped" };
      if (!(await (deps.enabled?.(turn.ownerUserId, turn.agentId) ?? true)))
        return { outcome: "skipped" };
      const now = (deps.now ?? (() => new Date()))().getTime();
      const key = `${turn.ownerUserId}:${turn.agentId}`;
      const before = lastAt.get(key);
      if (
        before !== undefined &&
        now - before < (deps.cooldownMs ?? RETRO_COOLDOWN_MS)
      )
        return { outcome: "skipped" };
      const model = await deps.modelFor(turn.agentId, "light");
      if (!model) return { outcome: "skipped" };
      // 今天这位员工的次数用完了：静默跳过。
      if (!limiter.take(key)) return { outcome: "skipped" };
      lastAt.set(key, now);
      const draft = await retrospect(turn, {
        model,
        existingSkills: (await deps.existingSkills?.(turn.agentId)) ?? [],
        ...(deps.call ? { call: deps.call } : {}),
      });
      if (!draft) return { outcome: "nothing" };
      const self = deps.selfSkill(turn.ownerUserId, turn.agentId);
      // 已经有一条差不多的：不再加一条近似的副本。
      const similar = await similarSkillOf(self, draft);
      if (similar) return { outcome: "similar", id: similar };
      const saved = await saveSkill(self, draft, "retrospect");
      return saved.ok
        ? { outcome: "saved", id: saved.id, status: saved.status }
        : { outcome: "refused", reason: saved.reason };
    } catch (error) {
      log(
        JSON.stringify({
          type: "retrospect-error",
          error: error instanceof Error ? error.name : "UnknownError",
          context: { threadId: turn.threadId, runId: turn.runId },
          timestamp: new Date().toISOString(),
        }),
      );
      return { outcome: "skipped" };
    }
  };
}

/**
 * 这一轮里人用 `/命令` 点了哪条员工自己写的技能：记成用过，它就不会被当成 30 天没用的。
 * 在本人帧里调用；只认这位员工自己有账的技能。
 */
export async function markPickedSkillUsed(
  database: Database,
  turn: { messages: readonly MessageLike[] },
  at: Date,
): Promise<void> {
  const command = leadingSkillCommand(personTextRaw(turn.messages));
  if (command) await markSkillsUsed(database, [command], at);
}

function personTextRaw(messages: readonly MessageLike[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content
        .map((part) =>
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text"
            ? String((part as { text?: unknown }).text ?? "")
            : "",
        )
        .join("\n");
    return "";
  }
  return "";
}

/**
 * 一张被验收通过的看板卡：它的各轮合起来，是复盘要看的「这件活是怎么做成的」。找不到执行的员工、或者
 * 没有轨迹就是 null。在这张卡本人的帧里调用。
 */
export async function cardRetroTurn(
  database: Database,
  taskId: string,
): Promise<RetroTurn | null> {
  const tenant = currentTenant();
  const [card] = await database
    .select({
      title: tasks.title,
      executorAgentId: tasks.executorAgentId,
      runRef: tasks.runRef,
      activeRunRef: tasks.activeRunRef,
      threadRef: tasks.threadRef,
    })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenant), eq(tasks.id, taskId)))
    .limit(1);
  if (!card?.executorAgentId) return null;
  const logged = await database
    .selectDistinct({ runId: sql<string>`${taskEvents.detail}->>'runId'` })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.tenantId, tenant),
        eq(taskEvents.taskId, taskId),
        sql`${taskEvents.detail}->>'runId' is not null`,
      ),
    );
  const runIds = [
    ...new Set(
      [
        card.runRef,
        card.activeRunRef,
        ...logged.map((row) => row.runId),
      ].filter((id): id is string => typeof id === "string" && id !== ""),
    ),
  ];
  if (runIds.length === 0) return null;
  const stored = await database
    .select({
      runId: threadRunEvents.runId,
      threadId: threadRunEvents.threadId,
      event: threadRunEvents.event,
    })
    .from(threadRunEvents)
    .where(
      and(
        eq(threadRunEvents.tenantId, tenant),
        inArray(threadRunEvents.runId, runIds),
      ),
    )
    .orderBy(threadRunEvents.runId, threadRunEvents.seq);
  const byRun = new Map<string, BaseEvent[]>();
  let threadId = card.threadRef ?? "";
  for (const row of stored) {
    threadId ||= row.threadId;
    const event =
      typeof row.event === "string"
        ? (JSON.parse(row.event) as BaseEvent)
        : (row.event as unknown as BaseEvent);
    const list = byRun.get(row.runId) ?? [];
    list.push(event);
    byRun.set(row.runId, list);
  }
  // 一轮一轮读：工具调用的编号只在自己那一轮里唯一。
  const rounds = runIds.map((runId) => byRun.get(runId) ?? []);
  const steps = rounds.flatMap((events) => traceStepsOf(events));
  if (steps.length === 0) return null;
  const last = rounds.filter((events) => events.length > 0).at(-1) ?? [];
  return {
    ownerUserId: tenant,
    agentId: card.executorAgentId,
    threadId,
    runId: runIds.at(-1) ?? "",
    request: short(card.title, 600),
    reply: short(replyTextOf(last), 600),
    steps,
    failed: false,
    trigger: "card_accepted",
  };
}
