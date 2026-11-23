import { type BaseEvent, EventType, type Message } from "@ag-ui/client";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  attachments,
  groupBotThreads,
  intelligenceChannelMappings,
  taskEvents,
  tasks,
  threadRunEvents,
} from "../db/schema";
import { runAsTenant } from "../tenant/context";
import { runEventsSoFar } from "../threads/run-side-events";
import { diffSummary, editedFiles } from "./diff-summary";
import { type FileProbe, verifyWorkspaceFiles } from "./file-evidence";
import {
  type DeliverableComponent,
  type DeliverableRef,
  drawnComponents,
  producedAttachments,
} from "./projector";

/**
 * The evidence gate (spec 2026-11-15-delivery-loop §5): whether a coworker's hand-in may move its card
 * to 已交成果. The server decides, not the coworker: a card the board shows as delivered has something
 * on it a person can open.
 *
 * In order, the first failure refusing the hand-in:
 * 1. at least one item, and every item real and this card's -- an attachment in the card's thread, a
 *    component drawn in one of the card's rounds, a link that is an http(s) address, a change summary
 *    of one of the card's rounds that an external employee ran (`externalRun`: only the server's own
 *    hand-in for that employee names one, never a coworker's `deliver_task`), or a workspace file
 *    whose ref is a relative path inside the coworker Bot's own workspace and that is really there
 *    and not empty (a folder counts; on a paired personal computer it cannot be checked and the card
 *    marks it unverified);
 * 2. a words-only hand-in (only `note`s) says how it was checked: at least one `checks` line;
 * 3. when the criteria list required items (「必需：A、B、C」), each one is named by an item's title
 *    or a check line, and the refusal says which are missing.
 *
 * It does not judge whether the work is right; that is the person's 验收.
 */

export const DELIVERY_ITEM_KINDS = [
  "attachment",
  "component",
  "link",
  "diff",
  "note",
  "workspace_file",
] as const;

export type DeliveryItem = {
  kind: (typeof DELIVERY_ITEM_KINDS)[number];
  /**
   * attachment: its id (or `/api/attachments/<id>`); component: the id of the call that drew it, or
   * its name for the latest one drawn on the card; link: the address; note: the conclusion itself;
   * workspace_file: the file's path inside the coworker Bot's own workspace, relative, such as
   * `reports/对比.xlsx` -- the board reads it back as a line naming that file, so only the
   * workspace's own shape passes here.
   */
  ref: string;
  title?: string;
};

export type EvidenceVerdict =
  | { ok: true; ref: DeliverableRef }
  | { ok: false; reason: string; missing?: string[] };

export type EvidenceGate = {
  checkEvidence(input: {
    tenantId: string;
    taskId: string;
    threadRef: string | null;
    items: readonly DeliveryItem[];
    checks: readonly string[];
    criteria: string | null;
    /**
     * The external employee's round the server hands in for (agents/acp/delivery.ts): the one run a
     * `diff` item may name, its `ref` being that run's id, and only when the run is one of the card's.
     * Absent, as for every `deliver_task`, a `diff` item is refused: a change summary is the server's
     * reading of an external employee's edits, not something a coworker can report.
     */
    externalRun?: string;
    /** The employee handing in: whose workspace a `workspace_file` item is looked for in. */
    agentId?: string;
  }): Promise<EvidenceVerdict>;
};

/**
 * What the server reads off a run for a card that ends without a hand-in (`channels/dispatch.ts`): the
 * workspace files its coworker wrote. Apart from {@link EvidenceGate}, which judges a hand-in.
 */
export type RunFiles = {
  workspaceFilesOf(input: {
    tenantId: string;
    /** The run the card was opened under (`tasks.run_ref`). */
    runRef: string;
  }): Promise<string[]>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The attachment id an item names: the id itself, or the path the chat links it by. */
function attachmentIdOf(ref: string): string | undefined {
  const id = ref
    .trim()
    .replace(/^.*\/api\/attachments\//, "")
    .replace(/[/?#].*$/, "");
  return UUID.test(id) ? id.toLowerCase() : undefined;
}

function httpAddress(ref: string): string | undefined {
  try {
    const url = new URL(ref.trim());
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

const nameOf = (item: DeliveryItem) => item.title?.trim() || item.ref.trim();

/**
 * The path a `workspace_file` item names, relative to the coworker Bot's own workspace, or
 * undefined.
 *
 * The card reads this row back as a file of that workspace, which is the same shape the chat
 * checks before it draws a saved-file link. So an absolute path, a home path, a drive letter or
 * any `..` segment is refused here rather than stored as an output nobody can reach; empty
 * segments (`//`, a leading `./`) are joined away, and separators are read whichever way the
 * coworker's machine wrote them.
 */
function workspaceFilePathOf(ref: string): string | undefined {
  const path = ref.trim();
  if (path === "") return undefined;
  if (path.startsWith("/") || path.startsWith("~")) return undefined;
  if (/^[A-Za-z]:/.test(path)) return undefined;
  const segments: string[] = [];
  for (const segment of path.split(/[/\\]/)) {
    if (segment === "" || segment === ".") continue;
    // A segment that IS `..`, not one that merely starts with it: `..notes.md` is an ordinary name.
    if (segment === "..") return undefined;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : undefined;
}

/** The tools whose successful call leaves a file in the coworker's workspace: a whole file, or one passage of it. */
const FILE_WRITING_TOOLS = new Set([
  "computer_write_file",
  "computer_edit_file",
]);

/** How many written files a card that ends without a hand-in carries as its evidence. */
export const AUTO_DELIVERY_FILE_LIMIT = 20;

/** Whether a tool's answer says the call did what it was asked: the computer tools answer `{ok: true, ...}`. */
function answeredOk(content: string | undefined): boolean {
  if (content === undefined) return false;
  try {
    const answer: unknown = JSON.parse(content);
    return (
      typeof answer === "object" &&
      answer !== null &&
      (answer as { ok?: unknown }).ok === true
    );
  } catch {
    // Not JSON: a refusal in words, or nothing a computer tool says when it worked.
    return false;
  }
}

/**
 * The workspace files a run wrote or changed, from its events: the calls of `computer_write_file` and
 * `computer_edit_file` that were answered `ok`, in the order they began, each file once.
 *
 * A call that failed, was refused, or is still waiting on a person wrote nothing, and a path is kept
 * only when it is a workspace-relative one by the same reading the evidence gate gives a
 * `workspace_file` item ({@link workspaceFilePathOf}): an absolute path, a home path or one that leaves
 * the workspace is not something the card can name. At most `limit` files: the first ones written.
 */
export function workspaceFilesWritten(
  events: readonly BaseEvent[],
  limit = AUTO_DELIVERY_FILE_LIMIT,
): string[] {
  const calls = new Map<string, { name: string; args: string }>();
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
        const call = calls.get(value.toolCallId) ?? { name: "", args: "" };
        if (value.toolCallName) call.name = value.toolCallName;
        if (event.type === EventType.TOOL_CALL_CHUNK && value.delta)
          call.args += value.delta;
        calls.set(value.toolCallId, call);
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
  const files = new Set<string>();
  for (const [toolCallId, call] of calls) {
    if (files.size >= limit) break;
    if (!FILE_WRITING_TOOLS.has(call.name)) continue;
    if (!answeredOk(answers.get(toolCallId))) continue;
    let path: unknown;
    try {
      path = (JSON.parse(call.args || "{}") as { path?: unknown } | null)?.path;
    } catch {
      continue;
    }
    const file =
      typeof path === "string" ? workspaceFilePathOf(path) : undefined;
    if (file) files.add(file);
  }
  return [...files];
}

/**
 * The required items criteria list after 「必需：」 (or 「必需:」), split on punctuation (、，, / and the
 * like), and on 「和」「及」 only when they stand apart, spaces on both sides: inside a word they are
 * part of it -- 「涉及金额」 is one item, not 「涉」 and 「金额」, and a one-character item would be
 * too easy to meet. Empty when the criteria name none.
 */
export function requiredItemsOf(criteria: string | null | undefined): string[] {
  const marked = /必需\s*[：:]\s*([^。\n；;]*)/.exec(criteria ?? "");
  if (!marked) return [];
  return (marked[1] ?? "")
    .split(/[、，,／/]|\s+(?:和|及)\s+/)
    .map((item) => item.trim().replace(/等$/, "").trim())
    .filter((item) => item.length > 0);
}

/**
 * The attachments a round produced: those its own assistant messages carry, a message being the
 * round's own when the round streamed it (an event of the round names its id). What the person
 * attached, and what an earlier round said, ride in the same snapshots and are not counted.
 */
export function attachmentsProduced(events: readonly BaseEvent[]): string[] {
  const own = new Set<string>();
  for (const event of events) {
    const value = event as BaseEvent & {
      messageId?: unknown;
      parentMessageId?: unknown;
    };
    if (typeof value.messageId === "string") own.add(value.messageId);
    if (typeof value.parentMessageId === "string")
      own.add(value.parentMessageId);
  }
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== EventType.MESSAGES_SNAPSHOT) continue;
    const messages =
      (event as BaseEvent & { messages?: Message[] }).messages ?? [];
    for (const id of producedAttachments(
      messages.filter((message) => own.has(message.id)),
    ))
      ids.add(id.toLowerCase());
  }
  return [...ids];
}

/** 小写，去掉所有不是字母、数字的字符：标点、括号、引号、空格都不影响比对。 */
const comparable = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * 一个必需项有没有对上：`named` 是所有交付物标题、ref 和自查拼成的一整段。
 * (a) 整项比对后是它的子串；或 (b) 把必需项按空白和标点拆段，比对后长度 >= 2 的段全都出现在里面
 * （单个汉字或字母的段丢掉；一段都不剩就只按 (a) 判）。
 */
export function requiredItemMet(
  required: string,
  named: string,
  segments: readonly string[] = [],
): boolean {
  if (isTestKind(required) && segments.some(testEvidenceFor(required)))
    return true;
  const whole = comparable(named);
  const item = comparable(required);
  // 整项全是标点：没有什么可比的，和原来一样算对上。
  if (whole.includes(item)) return true;
  const parts = required
    .split(/[^\p{L}\p{N}]+/u)
    .map(comparable)
    .filter((part) => [...part].length >= 2);
  return parts.length > 0 && parts.every((part) => partMet(part, whole));
}

/** 必需项里点了名的测试命令。 */
const TEST_COMMAND =
  /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bvitest\b|\bjest\b/gi;

/** 必需项是「测试 / 校验 / 验证 / 核对」这一类：含这些词之一，或点了名的测试命令。 */
export function isTestKind(required: string): boolean {
  if (/测试|校验|验证|核对|自测/.test(required)) return true;
  if (/\b(?:tests?|check|verify|verified)\b/i.test(required)) return true;
  return namedTestCommands(required).length > 0;
}

function namedTestCommands(text: string): string[] {
  return (text.match(TEST_COMMAND) ?? []).map((command) =>
    command.toLowerCase().replace(/\s+/g, " "),
  );
}

const TEST_WORD =
  /\b(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test|pytest|go\s+test|cargo\s+test|vitest|jest|tests?)\b|测试|校验|验证|核对|复现/i;
const PASS_WORD =
  /\bpass(?:ed)?\b|\b0\s+fail(?:ed|s)?\b|\bexit\s*(?:code)?\s*[=:]?\s*0\b|退出码\s*[=:：]?\s*0|通过|全绿|\bok\b/i;
const FAIL_WORD =
  /(?:[1-9]\d*)\s+(?:fail(?:ed|s|ures?)?)\b|\b(?:fail(?:ed|ures?)?)\s*[:=]\s*[1-9]|未通过|没通过|不通过|失败|\bfailed\b(?!\s*[:=]?\s*0\b)/i;

/**
 * 一段文字（一条自查或一个交付物标题）里有没有测试或校验通过的证据：有测试/校验命令或词，
 * 同时有通过的字样（pass、0 fail、exit 0、退出码 0、通过、全绿、ok），且没有失败字样
 * （非零的 fail、failed、未通过、失败）。
 */
export function passEvidenceIn(text: string): boolean {
  if (!TEST_WORD.test(text) || !PASS_WORD.test(text)) return false;
  // 「0 fail」「0 failed」是通过的写法，先拿掉再查失败字样。
  const rest = text.replace(/\b0\s+fail(?:ed|s|ures?)?\b/gi, "");
  return !FAIL_WORD.test(rest);
}

/**
 * 必需项点了名的测试命令时，证据那一段要出现同一个命令，或者 test / 测试 也行；没点名命令就只要是测试证据。
 */
function testEvidenceFor(required: string): (segment: string) => boolean {
  const commands = namedTestCommands(required);
  return (segment) => {
    if (!passEvidenceIn(segment)) return false;
    if (commands.length === 0) return true;
    const lower = segment.toLowerCase().replace(/\s+/g, " ");
    return (
      commands.some((command) => lower.includes(command)) ||
      /\btests?\b|测试/i.test(segment)
    );
  };
}

/** 至少这么多比例的相邻两字出现，一段中文才算对上。 */
export const CJK_PAIR_SHARE = 0.6;

/**
 * 一段（已比对化）有没有出现：整段是子串就算；含汉字、又不是整段出现时，中文没有空格可拆，
 * 就拆成相邻两字，至少 {@link CJK_PAIR_SHARE} 的两字出现在里面才算（「五个项目小节齐全且数据有出处」
 * 对「五个项目小节都在，数据附了出处」）。不含汉字的段（英文、数字、文件名）仍要整段出现。
 */
function partMet(part: string, whole: string): boolean {
  if (whole.includes(part)) return true;
  if (!/\p{Script=Han}/u.test(part)) return false;
  const chars = [...part];
  const pairs = chars.slice(1).map((char, index) => `${chars[index]}${char}`);
  const met = pairs.filter((pair) => whole.includes(pair)).length;
  return met / pairs.length >= CJK_PAIR_SHARE;
}

export function createEvidenceGate(
  database: Database,
  options: { fileProbe?: FileProbe } = {},
): EvidenceGate & RunFiles {
  /** Every run the card has had: the one that opened it, the one on it now, and each in its history. */
  async function runsOf(tenantId: string, taskId: string): Promise<string[]> {
    const [card] = await database
      .select({ runRef: tasks.runRef, activeRunRef: tasks.activeRunRef })
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
      .limit(1);
    const logged = await database
      .selectDistinct({ runId: sql<string>`${taskEvents.detail}->>'runId'` })
      .from(taskEvents)
      .where(
        and(
          eq(taskEvents.tenantId, tenantId),
          eq(taskEvents.taskId, taskId),
          sql`${taskEvents.detail}->>'runId' is not null`,
        ),
      );
    return [
      ...new Set(
        [
          card?.runRef,
          card?.activeRunRef,
          ...logged.map((row) => row.runId),
        ].filter((id): id is string => typeof id === "string" && id !== ""),
      ),
    ];
  }

  /** Each of the card's rounds, as its events: the stored runs, and the run still open here. */
  async function roundsOf(
    tenantId: string,
    taskId: string,
  ): Promise<{ runId: string; events: BaseEvent[] }[]> {
    const runIds = await runsOf(tenantId, taskId);
    if (runIds.length === 0) return [];
    const stored = await database
      .select({ runId: threadRunEvents.runId, event: threadRunEvents.event })
      .from(threadRunEvents)
      .where(
        and(
          eq(threadRunEvents.tenantId, tenantId),
          inArray(threadRunEvents.runId, runIds),
        ),
      )
      .orderBy(threadRunEvents.runId, threadRunEvents.seq);
    const byRun = new Map<string, BaseEvent[]>();
    for (const row of stored) {
      const event =
        typeof row.event === "string"
          ? (JSON.parse(row.event) as BaseEvent)
          : (row.event as unknown as BaseEvent);
      const list = byRun.get(row.runId) ?? [];
      list.push(event);
      byRun.set(row.runId, list);
    }
    return runIds.map((runId) => ({
      runId,
      events: [...(byRun.get(runId) ?? []), ...runEventsSoFar(runId)],
    }));
  }

  /**
   * Which of these attachments are this tenant's and in the card's thread (its channel, or its
   * group's channel): the second check, behind "produced in one of the card's rounds".
   */
  async function attachmentsInThread(
    tenantId: string,
    threadRef: string | null,
    ids: string[],
  ): Promise<Set<string>> {
    if (!threadRef || ids.length === 0) return new Set();
    const channelsOfThread = sql`(
      select ${intelligenceChannelMappings.channelId} from ${intelligenceChannelMappings}
      where ${intelligenceChannelMappings.threadId} = ${threadRef}
      union
      select ${groupBotThreads.channelId} from ${groupBotThreads}
      where ${groupBotThreads.threadId} = ${threadRef}
    )`;
    const rows = await database
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.tenantId, tenantId),
          inArray(attachments.id, ids),
          sql`${attachments.channelId} in ${channelsOfThread}`,
        ),
      );
    return new Set(rows.map((row) => row.id.toLowerCase()));
  }

  return {
    workspaceFilesOf: ({ tenantId, runRef }) =>
      runAsTenant(tenantId, async () => {
        // The card this run opened; the files are those of the card's own rounds, never another card's.
        const [card] = await database
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.tenantId, tenantId), eq(tasks.runRef, runRef)))
          .limit(1);
        if (!card) return [];
        const rounds = await roundsOf(tenantId, card.id);
        // Round by round: a tool call id is only unique within its own run.
        const files = new Set<string>();
        for (const { events } of rounds)
          for (const file of workspaceFilesWritten(events)) files.add(file);
        return [...files].slice(0, AUTO_DELIVERY_FILE_LIMIT);
      }),

    checkEvidence: (input) =>
      runAsTenant(input.tenantId, async (): Promise<EvidenceVerdict> => {
        const items = input.items;
        const checks = input.checks
          .map((check) => check.trim())
          .filter((check) => check.length > 0);
        if (items.length === 0)
          return {
            ok: false,
            reason:
              "没有交付物：至少交一项（附件、组件、链接或文字结论），再写上你怎么查过的。",
          };

        const ref: DeliverableRef = { kind: "deliverable" };
        const components: DeliverableComponent[] = [];
        const attachmentIds: string[] = [];
        const links: { url: string; title: string }[] = [];
        const notes: string[] = [];
        const workspaceFiles: string[] = [];

        const wantedAttachments = items
          .filter((item) => item.kind === "attachment")
          .map((item) => attachmentIdOf(item.ref))
          .filter((id): id is string => id !== undefined);
        const inThread = await attachmentsInThread(
          input.tenantId,
          input.threadRef,
          wantedAttachments,
        );
        const rounds = items.some(
          (item) =>
            item.kind === "component" ||
            item.kind === "attachment" ||
            (item.kind === "diff" && input.externalRun !== undefined),
        )
          ? await roundsOf(input.tenantId, input.taskId)
          : [];
        const drawn = rounds.flatMap(({ events }) => drawnComponents(events));
        const produced = new Set(
          rounds.flatMap(({ events }) => attachmentsProduced(events)),
        );
        const diffs: NonNullable<DeliverableRef["diffs"]> = [];

        for (const item of items) {
          const name = nameOf(item);
          switch (item.kind) {
            case "attachment": {
              const id = attachmentIdOf(item.ref);
              /*
               * Produced by the coworker in one of this card's rounds, and this card's thread's: a
               * file the person uploaded, an older one, another member's, or one staged and never
               * sent is input or somebody else's, not this work's output.
               */
              if (!id || !produced.has(id) || !inThread.has(id))
                return {
                  ok: false,
                  reason: `附件「${name}」不是你在这件活里做出来的文件，交不了。对方上传的原件、这件活以前的文件、别人的文件都不能当交付物。`,
                  missing: [name],
                };
              attachmentIds.push(id);
              break;
            }
            case "component": {
              const wanted = item.ref.trim();
              const found =
                drawn.find((component) => component.toolCallId === wanted) ??
                drawn.findLast((component) => component.name === wanted);
              if (!found)
                return {
                  ok: false,
                  reason: `组件「${name}」不是这件活里画的，交不了。先在这件活里把它画出来再交。`,
                  missing: [name],
                };
              components.push({ name: found.name, args: found.args });
              break;
            }
            case "link": {
              const url = httpAddress(item.ref);
              if (!url)
                return {
                  ok: false,
                  reason: `链接「${name}」不是 http(s) 地址。`,
                  missing: [name],
                };
              links.push({ url, title: item.title?.trim() || url });
              break;
            }
            case "diff": {
              const runId = item.ref.trim();
              const round =
                input.externalRun !== undefined && runId === input.externalRun
                  ? rounds.find((candidate) => candidate.runId === runId)
                  : undefined;
              if (!round)
                return {
                  ok: false,
                  reason: "改动汇总只能来自外部员工的轮次，不能自己报。",
                  missing: [name],
                };
              const files = editedFiles(round.events);
              if (files.length === 0)
                return {
                  ok: false,
                  reason: "这一轮没有改动任何文件，没有改动汇总可交。",
                  missing: [name],
                };
              diffs.push({ ...diffSummary(files), ref: runId });
              break;
            }
            case "note": {
              const text = item.ref.trim() || item.title?.trim() || "";
              if (!text)
                return { ok: false, reason: "文字结论是空的。", missing: [] };
              notes.push(text);
              break;
            }
            case "workspace_file": {
              /*
               * The shape first: a path outside the workspace is refused with the same reasoning the
               * chat refuses to draw a link for it. Whether the file is really there is asked after
               * the loop, of every named path at once.
               */
              const path = workspaceFilePathOf(item.ref);
              if (!path)
                return {
                  ok: false,
                  reason: `工作区文件「${name}」的路径不是工作区内的相对路径，交不了。要写文件时用的那个路径本身；绝对路径和越出工作区的都不算。`,
                  missing: [name],
                };
              workspaceFiles.push(path);
              break;
            }
            default:
              return {
                ok: false,
                reason: `不认识的交付物类型「${String((item as { kind: unknown }).kind)}」。`,
              };
          }
        }

        let unverifiedFiles: string[] = [];
        if (options.fileProbe && input.agentId && workspaceFiles.length > 0) {
          const { failures, unverified } = await verifyWorkspaceFiles({
            tenantId: input.tenantId,
            agentId: input.agentId,
            paths: [...new Set(workspaceFiles)],
            probe: options.fileProbe,
          });
          if (failures.length > 0) {
            const names = failures.map((failure) => failure.path);
            return {
              ok: false,
              reason: `工作区文件「${names.join("」「")}」不存在或是空的，先把它真正存到工作区再交。`,
              missing: names,
            };
          }
          unverifiedFiles = unverified;
        }

        if (items.every((item) => item.kind === "note") && checks.length === 0)
          return {
            ok: false,
            reason:
              "只有文字结论时，至少写一条你怎么查过的（checks），比如核对了哪些数据、跑了什么测试。",
          };

        const named = [
          ...items.flatMap((item) => [item.title ?? "", item.ref]),
          ...checks,
        ].join(" ");
        // 测试类必需项的证据只认同一条 check 或同一个交付物标题，不跨条拼。
        const segments = [
          ...items.map((item) => `${item.title ?? ""} ${item.ref}`),
          ...checks,
        ];
        const missing = requiredItemsOf(input.criteria).filter(
          (required) => !requiredItemMet(required, named, segments),
        );
        if (missing.length > 0)
          return {
            ok: false,
            reason: `验收标准里的必需项没对上：缺 ${missing.join("、")}。在交付物标题或自查里逐一写到再交。`,
            missing,
          };

        if (components.length) ref.components = components;
        if (attachmentIds.length) ref.attachments = [...new Set(attachmentIds)];
        if (links.length) ref.links = links;
        if (workspaceFiles.length)
          ref.workspaceFiles = [...new Set(workspaceFiles)];
        if (unverifiedFiles.length) ref.unverifiedFiles = unverifiedFiles;
        if (diffs.length) ref.diffs = diffs;
        if (notes.length) ref.notes = notes;
        if (checks.length) ref.checks = checks;
        return { ok: true, ref };
      }),
  };
}
