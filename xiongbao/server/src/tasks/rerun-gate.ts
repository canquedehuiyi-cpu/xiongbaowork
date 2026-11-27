/**
 * 交付时复跑核对命令（规格 2026-11-25-borrowed-improvements §5.5）。
 *
 * 员工交付时在 `rerun` 里写这张卡里跑过、能证明结果的核对命令，服务器在员工自己的电脑上再跑一次，和这张卡里
 * 最近一次的运行比：退出码从 0 变成非 0，或输出里的数字对不上，交付挡回。同一张卡因此挡回满 2 次后第 3 次照收，
 * 交付记录里留下「复核不一致」，留给本人验收时看。`checks` 或 note 里说测过、却没写 `rerun` 也没写
 * 「无法复跑：原因」的，第一次交付挡回一次（说法门，每轮最多一次）。
 *
 * 三条不越过的线：复跑从不创建审批请求（先用 `wouldAllow` 只读预判，执行时再包在 {@link withoutAsking} 里）；
 * 原来经审批才执行的命令不复跑；改动类命令不复跑（`shared/rerun.ts` 的 `isRerunnable`）。
 *
 * 判定都是纯函数，桩函数就能测；读库和接电脑的部分在下面的 {@link createRerunRunner}、{@link rerunBouncesOf}。
 */

import { type BaseEvent, EventType } from "@ag-ui/client";
import { HEADLESS_WAITING_EVENT } from "@xiongbao/toolkit/headless-tools";
import {
  claimsTested,
  isRerunnable,
  NO_RERUN_PREFIX,
  outputsAgree,
  RERUN_MAX,
  RERUN_TIMEOUT_MS,
} from "../../../shared/rerun";
import { COMMAND_TOOL, ranCheckCommand } from "../../../shared/verify";
import { XIONGBAO_WAITING_METADATA } from "../../../shared/waiting";
import type { ApprovalCandidate } from "../approvals/types";
import { currentApprovalContext } from "../approvals/types";
import type { ComputerSeat } from "../computer/computer-key";
import type { ActionActor, ComputerGateway } from "../computer/gateway";
import {
  approvalEffectOf,
  approvalScopeOf,
  intentOf,
} from "../computer/gateway";
import type { RunCommandResult } from "../computer/schema";
import type { Database } from "../db/client";
import { runAsTenant } from "../tenant/context";
import { listTaskEvents } from "./events";

export const DELIVERY_RERUN_ENV = "XIONGBAO_DELIVERY_RERUN";
export const DELIVERY_RERUN_CLAIM_GATE_ENV =
  "XIONGBAO_DELIVERY_RERUN_CLAIM_GATE";

/** 复跑不一致挡回的标记：写在挡回结果和 `bounced` 事件里，累计次数数的是它。 */
export const RERUN_BOUNCE_KEY = "rerunBounce";
/** 说法门挡回的标记：这一轮的历史里有它，就是已经挡回过一次。 */
export const CLAIM_BOUNCE_KEY = "rerunClaimBounce";

/** 同一张卡因复跑挡回满这么多次后，下一次照收。 */
export const RERUN_BOUNCES_BEFORE_ACCEPT = 2;

type Env = Record<string, string | undefined>;
const switchedOn = (env: Env, name: string) =>
  env[name]?.trim().toLowerCase() !== "off";

/** 复跑开着吗：默认开，只有明确写 `off` 才关。 */
export function deliveryRerunOn(env: Env = process.env): boolean {
  return switchedOn(env, DELIVERY_RERUN_ENV);
}

/** 说法门开着吗：默认开，只有明确写 `off` 才关。 */
export function rerunClaimGateOn(env: Env = process.env): boolean {
  return switchedOn(env, DELIVERY_RERUN_CLAIM_GATE_ENV);
}

/** 一条命令复跑的结果，写进交付记录（`DeliverableRef.reruns`）。`mismatch` 就是卡上的「复核不一致」。 */
export type RerunOutcome = {
  command: string;
  result: "passed" | "mismatch" | "unverified";
  why?: string;
};

/** 这张卡里员工跑过的一次 `computer_run_command`：命令、退出码、存下的输出，以及它是不是经审批才执行的。 */
export type CardCommandRun = {
  command: string;
  exitCode: number;
  output: string;
  /** 存下的输出不全（电脑截断，或只留了头尾）：比较时只比两边都有的部分。 */
  truncated: boolean;
  /** 这次调用等过审批：结果是批准后才执行出来的，复跑会绕过那次批准，所以不复跑。 */
  approved: boolean;
  /** 在这张卡各轮事件里的先后位置，越大越晚。 */
  at: number;
};

type ToolEvent = BaseEvent & {
  toolCallId?: string;
  toolCallName?: string;
  delta?: string;
  content?: unknown;
  name?: string;
  value?: unknown;
  outcome?: { type?: string; interrupts?: unknown[] };
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const parsed = (text: string): Record<string, unknown> => {
  try {
    return record(JSON.parse(text));
  } catch {
    return {};
  }
};

/** 一条等人的事件里说的：等的是审批时，它挡住的是哪一次工具调用。 */
function approvalWaitOf(waiting: unknown, fallbackId?: unknown): string {
  const value = record(waiting);
  if (value.kind !== "approval") return "";
  const id =
    value.toolCallId ?? record(value.continuation).toolCallId ?? fallbackId;
  return typeof id === "string" ? id : "";
}

/**
 * 从这张卡各轮的运行事件（按先后排好）里读出员工的 `computer_run_command`：命令、退出码和存下的输出。
 *
 * 等过审批的那次调用（等人事件或运行结束时的中断写着 `approval`）记为 `approved`：它的结果是本人批准后由
 * 审批续跑执行出来的，有没有存进事件都一样不复跑。没有结果、也没等过审批的调用（还没跑完）不算跑过。
 */
export function cardCommandRuns(
  events: readonly BaseEvent[],
): CardCommandRun[] {
  const calls = new Map<string, { name: string; args: string; at: number }>();
  const results = new Map<string, string>();
  const approvals = new Set<string>();
  events.forEach((raw, index) => {
    const event = raw as ToolEvent;
    if (
      event.type === EventType.CUSTOM &&
      event.name === HEADLESS_WAITING_EVENT
    ) {
      const id = approvalWaitOf(event.value);
      if (id) approvals.add(id);
      return;
    }
    if (event.type === EventType.RUN_FINISHED) {
      for (const interrupt of event.outcome?.interrupts ?? []) {
        const value = record(interrupt);
        const id = approvalWaitOf(
          record(value.metadata)[XIONGBAO_WAITING_METADATA],
          value.toolCallId ?? value.id,
        );
        if (id) approvals.add(id);
      }
      return;
    }
    const id = event.toolCallId;
    if (!id) return;
    switch (event.type) {
      case EventType.TOOL_CALL_START:
      case EventType.TOOL_CALL_CHUNK: {
        let call = calls.get(id);
        if (!call) {
          call = { name: "", args: "", at: index };
          calls.set(id, call);
        }
        if (event.toolCallName) call.name = event.toolCallName;
        if (event.type === EventType.TOOL_CALL_CHUNK && event.delta)
          call.args += event.delta;
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        const call = calls.get(id);
        if (call && event.delta) call.args += event.delta;
        break;
      }
      case EventType.TOOL_CALL_RESULT:
        if (typeof event.content === "string") results.set(id, event.content);
        break;
    }
  });
  const runs: CardCommandRun[] = [];
  for (const [id, call] of calls) {
    if (call.name !== COMMAND_TOOL) continue;
    const command = parsed(call.args).command;
    if (typeof command !== "string" || !command.trim()) continue;
    const approved = approvals.has(id);
    const content = results.get(id);
    if (content === undefined && !approved) continue;
    const result = parsed(content ?? "");
    const exitCode =
      typeof result.exitCode === "number" && result.ok !== false
        ? result.exitCode
        : -1;
    const output =
      typeof result.stdout === "string" || typeof result.stderr === "string"
        ? outputOf(result)
        : typeof result.error === "string"
          ? result.error
          : (content ?? "");
    runs.push({
      command,
      exitCode,
      output,
      truncated:
        result.truncated === true ||
        typeof result.outputNote === "string" ||
        typeof result.outputFile === "string",
      approved,
      at: call.at,
    });
  }
  return runs.sort((a, b) => a.at - b.at);
}

/**
 * 这张卡各轮（按先后）跑过的命令：一轮一轮地读（工具调用的 id 只在它那一轮里唯一），先后位置接着排。
 */
export function cardRoundRuns(
  rounds: readonly (readonly BaseEvent[])[],
): CardCommandRun[] {
  const runs: CardCommandRun[] = [];
  let offset = 0;
  for (const events of rounds) {
    for (const run of cardCommandRuns(events))
      runs.push({ ...run, at: run.at + offset });
    offset += events.length;
  }
  return runs;
}

/** 命令的输出：标准输出，有标准错误就接在后面。 */
function outputOf(result: { stdout?: unknown; stderr?: unknown }): string {
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  return stderr ? `${stdout}\n${stderr}` : stdout;
}

/** 说法门挡回时给员工的话。 */
export const CLAIM_BOUNCE_REASON = `你在自查或结论里说测过，但没有在 rerun 里写能复跑的核对命令：把这张卡里跑过、能证明结果的命令（测试、校验脚本、统计数）原样写进 rerun 再交，服务器会在你的电脑上再跑一次核对；确实没有能复跑的，在 checks 里写一条「${NO_RERUN_PREFIX}原因」。`;

/**
 * 说法门：`rerun` 是空的、`checks` 里也没有「无法复跑：」开头的一条，而 `checks` 或 note 里说测过，就挡回，
 * 返回挡回原因；这一轮已经挡回过（`alreadyBounced`）或别的情况返回 null。只看交付里写的，不看对话。
 */
export function claimBounce(input: {
  rerun: readonly string[];
  checks: readonly string[];
  notes: readonly string[];
  alreadyBounced: boolean;
}): string | null {
  if (input.alreadyBounced) return null;
  if (input.rerun.some((command) => command.trim())) return null;
  if (input.checks.some((check) => check.trim().startsWith(NO_RERUN_PREFIX)))
    return null;
  return claimsTested([...input.checks, ...input.notes])
    ? CLAIM_BOUNCE_REASON
    : null;
}

const LATEST_FAILED = "这条命令最近一次没有成功";
const NOT_RUN = "这张卡里没跑过这条命令";
const APPROVED = "这条命令当初是经审批才执行的，复跑不再执行";
const CANNOT_EXECUTE =
  "这台电脑不能由服务器执行（配对的个人电脑、设备模式或不在线）";
const WOULD_ASK = "按现在的规则，这条命令需要审批或被禁止，复跑不提审批";
const TIMED_OUT = "复跑超时";

/** 这一轮（最后一条用户消息之后）的工具结果里有没有这个挡回标记：有就是这一轮已经挡回过。 */
export function bouncedThisTurn(
  messages: readonly unknown[],
  key: string,
): boolean {
  let start = 0;
  messages.forEach((message, index) => {
    if (record(message).role === "user") start = index + 1;
  });
  return messages.slice(start).some((message) => {
    const { role, content } = record(message);
    return (
      role === "tool" &&
      typeof content === "string" &&
      content.includes(`"${key}":true`)
    );
  });
}

/** 没法复跑时（这里接不上员工的电脑），声明的每条命令都记「未复核」。 */
export function unverifiedReruns(commands: readonly string[]): RerunOutcome[] {
  return [...new Set(commands.map((command) => command.trim()).filter(Boolean))]
    .slice(0, RERUN_MAX)
    .map((command) => ({ command, result: "unverified", why: CANNOT_EXECUTE }));
}

/** 输出末尾各至多这么多行、这么多字，写进挡回原因。 */
const TAIL_LINES = 20;
const TAIL_CHARS = 2_000;

function tailOf(output: string): string {
  const lines = output.replace(/\s+$/, "").split("\n");
  const tail = lines.slice(-TAIL_LINES).join("\n");
  return tail.length > TAIL_CHARS ? `…${tail.slice(-TAIL_CHARS)}` : tail;
}

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

/**
 * 逐条复跑员工声明的核对命令。每条先找这张卡里最近一次的运行作基准（比较方式与 `ranCheckCommand` 相同），
 * 再按次序判断：没跑过、经审批执行的、改动类的、电脑不能由服务器执行的、按规则现在要审批的，都记「未复核」，
 * 不挡回；最近一次没成功的挡回；其余的复跑，退出码或数字对不上的挡回。
 *
 * 复跑执行的是基准那次的原命令（员工写的可能少了 `cd <目录> && ` 之类的前缀），交付记录里写员工声明的命令。
 */
export async function rerunChecks(input: {
  commands: readonly string[];
  runs: readonly CardCommandRun[];
  canExecute: boolean;
  wouldAllow: (command: string) => Promise<boolean>;
  run: (command: string) => Promise<RunCommandResult>;
}): Promise<{ bounce: string | null; outcomes: RerunOutcome[] }> {
  const commands = [
    ...new Set(input.commands.map((command) => command.trim()).filter(Boolean)),
  ].slice(0, RERUN_MAX);
  const outcomes: RerunOutcome[] = [];
  const bounces: string[] = [];
  for (const command of commands) {
    const unverified = (why: string) =>
      outcomes.push({ command, result: "unverified", why });
    const matching = input.runs.filter((run) =>
      ranCheckCommand(run.command, command),
    );
    const baseline = matching.reduce<CardCommandRun | undefined>(
      (latest, run) => (!latest || run.at > latest.at ? run : latest),
      undefined,
    );
    if (!baseline) {
      unverified(NOT_RUN);
      continue;
    }
    if (baseline.approved) {
      unverified(APPROVED);
      continue;
    }
    if (baseline.exitCode !== 0) {
      outcomes.push({ command, result: "mismatch", why: LATEST_FAILED });
      bounces.push(
        `「${command}」：${LATEST_FAILED}（退出码 ${baseline.exitCode}）。先修好、再跑一次确认通过后再交。\n最近一次输出末尾：\n${tailOf(baseline.output)}`,
      );
      continue;
    }
    const verdict = isRerunnable(baseline.command);
    if (!verdict.ok) {
      unverified(verdict.why);
      continue;
    }
    if (!input.canExecute) {
      unverified(CANNOT_EXECUTE);
      continue;
    }
    if (!(await input.wouldAllow(baseline.command))) {
      unverified(WOULD_ASK);
      continue;
    }
    let again: RunCommandResult;
    try {
      again = await input.run(baseline.command);
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === "AbortError")
        throw error;
      unverified(`复跑没能执行：${errorText(error)}`);
      continue;
    }
    if (again.timedOut) {
      unverified(TIMED_OUT);
      continue;
    }
    const output = outputOf(again);
    const agreed = outputsAgree(
      { exitCode: baseline.exitCode, output: baseline.output },
      { exitCode: again.exitCode, output },
      baseline.truncated,
    );
    if (agreed.agree) {
      outcomes.push({ command, result: "passed" });
      continue;
    }
    outcomes.push({ command, result: "mismatch", why: agreed.why });
    bounces.push(
      `「${command}」：复跑结果和这张卡里最近一次不一致（${agreed.why}）。原来退出码 ${baseline.exitCode}，复跑退出码 ${again.exitCode}。\n原来输出末尾：\n${tailOf(baseline.output)}\n复跑输出末尾：\n${tailOf(output)}`,
    );
  }
  return {
    bounce:
      bounces.length > 0
        ? `服务器在你的电脑上复跑了你声明的核对命令，结果和你说的对不上：\n\n${bounces.join("\n\n")}\n\n查清原因、修好后再交；交付时 rerun 写的是能证明最终结果的那条命令。`
        : null,
    outcomes,
  };
}

/** 这张卡因复跑挡回过几次：数卡片历史里带 {@link RERUN_BOUNCE_KEY} 的 `bounced` 事件。 */
export async function rerunBouncesOf(
  database: Database,
  tenantId: string,
  taskId: string,
): Promise<number> {
  const events = await runAsTenant(tenantId, () =>
    listTaskEvents(database, { tenantId, taskId }),
  );
  return events.filter(
    (event) =>
      event.kind === "bounced" &&
      record(event.detail).gate === RERUN_BOUNCE_KEY,
  ).length;
}

/** 复跑要的四样：这张卡的运行事件、能不能执行、规则放不放行、真去执行。`deliveryTools` 的 `rerun` 选项。 */
export type RerunDeps = {
  /** 这张卡各轮的运行事件，一轮一组，按先后排好（证据门的 `cardRounds`）。 */
  cardRounds(tenantId: string, taskId: string): Promise<BaseEvent[][]>;
  /** 这张卡因复跑挡回过几次。 */
  rerunBounces(tenantId: string, taskId: string): Promise<number>;
  canExecute(): Promise<boolean>;
  wouldAllow(command: string): Promise<boolean>;
  run(command: string, signal?: AbortSignal): Promise<RunCommandResult>;
};

/**
 * 复跑一条命令时问审批规则的候选动作：和电脑网关替 `computer_run_command` 问的同形（`gateway.ts` 的 `govern`），
 * 这样预判和真执行时的判断是同一套输入。
 */
export function rerunCandidate(input: {
  actor: ActionActor;
  seat: ComputerSeat;
  command: string;
}): ApprovalCandidate {
  const continuation = currentApprovalContext();
  return {
    actorId: input.actor.id,
    botId: input.seat.botId,
    toolRef: COMMAND_TOOL,
    effect: approvalEffectOf(intentOf(COMMAND_TOOL, undefined)),
    scope: approvalScopeOf({ command: input.command, pageUrl: "" }),
    args: continuation?.args ?? { command: input.command },
    target: { pageUrl: "" },
    subject: { command: input.command, runner: false },
    ...(continuation ? { continuation } : {}),
  };
}

/**
 * 把电脑网关和审批服务接成复跑要的 `canExecute`、`wouldAllow`、`run`。`resolve` 给出员工自己的座位和身份，
 * 没有电脑或这个人不能用这台电脑时给 undefined（那就不能执行）。
 *
 * 能不能执行，和证据门判断文件「未核实」用的是同一问（`file-evidence.ts`）：配对的个人电脑、设备模式答 null，
 * 电脑不在线抛错，这两种都不能执行。真执行时包在 `withoutAsking` 里：万一规则在预判之后变了，网关的审批门
 * 也只会拒绝，不会开审批请求。
 */
export function createRerunRunner(options: {
  gateway: Pick<ComputerGateway, "statFile" | "runCommand">;
  resolve: () => Promise<
    { seat: ComputerSeat; actor: ActionActor } | undefined
  >;
  wouldAllow: (candidate: ApprovalCandidate) => Promise<boolean>;
  withoutAsking: <T>(work: () => Promise<T>) => Promise<T>;
}): Pick<RerunDeps, "canExecute" | "wouldAllow" | "run"> {
  const { gateway } = options;
  const seated = async () => {
    const found = await options.resolve();
    if (!found) throw new Error("这位员工在这里没有可用的电脑。");
    return found;
  };
  return {
    async canExecute() {
      try {
        const found = await options.resolve();
        if (!found) return false;
        return (await gateway.statFile(found.seat, { path: "." })) !== null;
      } catch {
        return false;
      }
    },
    async wouldAllow(command) {
      try {
        const { seat, actor } = await seated();
        return await options.wouldAllow(
          rerunCandidate({ actor, seat, command }),
        );
      } catch {
        return false;
      }
    },
    async run(command, signal) {
      const { seat, actor } = await seated();
      return options.withoutAsking(() =>
        gateway.runCommand(
          seat,
          actor,
          { command, timeoutMs: RERUN_TIMEOUT_MS },
          signal,
        ),
      );
    },
  };
}
