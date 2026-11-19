import {
  IconDeviceDesktop,
  IconFolder,
  IconLock,
  IconPlug,
  IconPlus,
  IconTrash,
  IconUsers,
} from "@tabler/icons-react";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { AuditEvent } from "@/components/audit/audit-cells";
import {
  type ReplayRow,
  ReplayRows,
} from "@/components/boundaries/dry-run-changes";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import type {
  ApprovalBacktest,
  ApprovalRulesPreview,
  BacktestChange,
} from "@/lib/approval-rules/queries";
import type { RuleRowProblem } from "@/lib/approval-rules/translate";
import { type ApprovalRuleInput, BEHAVIOUR_LABELS } from "@/lib/approvals";
import { shortName } from "@/lib/brand";
import { LabelSelect } from "./rules";

/** More than this is not one description's worth; the server refuses it too. */
export const MAX_RULES = 8;

export const BLANK_RULE: ApprovalRuleInput = {
  toolRef: "",
  effect: "*",
  scope: "*",
  botId: "*",
  behaviour: "ask",
};

const FIELDS: {
  key: "toolRef" | "effect" | "scope";
  label: string;
  placeholder: string;
}[] = [
  {
    key: "toolRef",
    label: "工具或应用",
    placeholder: "composio-gmail/*, computer_click, host/*",
  },
  { key: "effect", label: "动作类型", placeholder: "*、write、read" },
  { key: "scope", label: "目标", placeholder: "*、某个应用、某个网站" },
];

/**
 * The Bots a rule can name, by the names people know them by: every Bot, each Bot, and whatever the
 * rule names now when it is none of those (a pattern, or a Bot that is gone), as it is written.
 */
function botLabels(
  bots: readonly AgentProfile[] | undefined,
  current: string,
): Record<string, string> {
  const labels: Record<string, string> = { "*": "所有员工" };
  for (const bot of bots ?? []) labels[bot.id] = bot.name;
  if (!(current in labels)) labels[current] = current || "没有员工";
  return labels;
}

/**
 * The rules the model wrote, each a set of fields the admin can change before saving. What is wrong
 * with a field, as the server checks the rules as they stand now, is said under it.
 */
export function RuleRowsEditor({
  rules,
  problems,
  onChange,
}: {
  rules: ApprovalRuleInput[];
  /** From the check of the rules as they stand, which runs as they are edited. */
  problems: RuleRowProblem[];
  onChange: (rules: ApprovalRuleInput[]) => void;
}) {
  const bots = useQuery(agentListQueryOptions());
  const set = (index: number, change: Partial<ApprovalRuleInput>) =>
    onChange(
      rules.map((rule, at) => (at === index ? { ...rule, ...change } : rule)),
    );
  return (
    <Field>
      <FieldLabel>规则</FieldLabel>
      <FieldDescription>
        用 * 匹配任意内容。保存前可以改动任何一条规则。
      </FieldDescription>
      <div className="flex flex-col gap-4">
        {rules.map((rule, index) => {
          const row = index + 1;
          const id = `team-rule-${row}`;
          const problemFor = (field: keyof ApprovalRuleInput) =>
            problems.find(
              (problem) => problem.row === row && problem.field === field,
            )?.message;
          return (
            // Index-keyed: a rule has no identity apart from its place until it is saved.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <div className="flex flex-col gap-4" key={index}>
              {index > 0 ? <FieldSeparator /> : null}
              <FieldSet className="gap-3">
                <div className="flex items-center justify-between gap-2">
                  <FieldLegend className="mb-0" variant="label">
                    规则 {row}
                  </FieldLegend>
                  <Button
                    aria-label={`移除规则 ${row}`}
                    onClick={() =>
                      onChange(rules.filter((_, at) => at !== index))
                    }
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <IconTrash />
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {FIELDS.map((field) => {
                    const problem = problemFor(field.key);
                    return (
                      <Field
                        className={
                          field.key === "toolRef" ? "sm:col-span-2" : undefined
                        }
                        key={field.key}
                      >
                        <FieldLabel htmlFor={`${id}-${field.key}`}>
                          {field.label}
                        </FieldLabel>
                        <Input
                          aria-invalid={problem ? true : undefined}
                          autoCapitalize="off"
                          autoCorrect="off"
                          id={`${id}-${field.key}`}
                          onChange={(event) =>
                            set(index, { [field.key]: event.target.value })
                          }
                          placeholder={field.placeholder}
                          spellCheck={false}
                          value={rule[field.key]}
                        />
                        {problem ? (
                          <p className="text-destructive text-sm">{problem}</p>
                        ) : null}
                      </Field>
                    );
                  })}
                  <Field>
                    <FieldLabel htmlFor={`${id}-botId`}>员工</FieldLabel>
                    <LabelSelect
                      id={`${id}-botId`}
                      labels={botLabels(bots.data, rule.botId)}
                      onChange={(botId) => set(index, { botId })}
                      value={rule.botId}
                    />
                    {problemFor("botId") ? (
                      <p className="text-destructive text-sm">
                        {problemFor("botId")}
                      </p>
                    ) : null}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${id}-behaviour`}>
                      处理方式
                    </FieldLabel>
                    <LabelSelect
                      id={`${id}-behaviour`}
                      labels={BEHAVIOUR_LABELS}
                      onChange={(behaviour) => set(index, { behaviour })}
                      value={rule.behaviour}
                    />
                  </Field>
                </div>
              </FieldSet>
            </div>
          );
        })}
      </div>
      {rules.length < MAX_RULES ? (
        <div>
          <Button
            onClick={() => onChange([...rules, BLANK_RULE])}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconPlus />
            再加一条规则
          </Button>
        </div>
      ) : null}
    </Field>
  );
}

/**
 * The backtest's answer in one sentence: 「会改变 4 个决定：少问 4 次，其中 1 次有人拒绝过；多问 0 次。」
 * Safety requirements and auto-review are never counted.
 */
export function backtestHeadline(report: ApprovalBacktest): string {
  if (report.changed === 0) return "不会改变任何决定。";
  const removed =
    report.removedAsks > 0
      ? `少问 ${report.removedAsks} 次，其中 ${report.removedDenied} 次有人拒绝过`
      : `少问 ${report.removedAsks} 次`;
  const moved = report.changed - report.removedAsks - report.addedAsks;
  return `会改变 ${report.changed} 个决定：${removed}；多问 ${report.addedAsks} 次。${
    moved > 0 ? `另有 ${moved} 个会在「先问」和「交给本人」之间变动。` : ""
  }`;
}

/**
 * Under the headline: what was replayed, how much of it the rules are about, what no rule changes,
 * and, for rules that ask, what the trail could not show.
 */
export function replayWords(
  report: ApprovalBacktest,
  asksMore: boolean,
): string {
  return [
    `用${shortName()}最近检查过的 ${report.scanned} 个动作重放了一遍。`,
    report.matched === 0
      ? "这些规则跟其中任何一个都无关。"
      : `这些规则涉及其中 ${report.matched} 个。`,
    report.fixed > 0
      ? `其中 ${report.fixed} 个由安全要求、自动审核或任务决定，规则改变不了。`
      : null,
    asksMore
      ? "没经过检查就执行的动作不会被记录，所以新的「先问」可能比这里显示的管得更多。"
      : null,
  ]
    .filter(Boolean)
    .join("");
}

/** What the person said when they were asked, in their words. */
const ANSWERS: Record<NonNullable<BacktestChange["person"]>, string> = {
  allow_once: "有人允许了一次。",
  allow_conversation: "有人在那段对话里都允许了。",
  allow_always: "有人选了总是允许。",
  deny: "有人拒绝了。",
  handled: "有人自己做了。",
  waiting: "还在等人处理。",
  withdrawn: "没等到回答就撤回了。",
};

const WOULD: Record<string, string> = {
  allow: "不会再问",
  ask: "会先问",
  hand_off: "会交给本人",
};

/** The approval row a change was replayed from, so Audit's own cells draw it. */
function auditRowOf(change: BacktestChange): AuditEvent {
  return {
    id: change.id,
    actorUserId: change.ownerUserId,
    initiatorKind: change.initiator.kind,
    initiatorId: change.initiator.id,
    eventType: "approval.evaluated",
    targetType: "approval",
    targetId: change.toolRef,
    createdAt: change.createdAt,
    payload: {
      bot: change.bot,
      tool: change.toolRef,
      effect: change.effect,
      scope: change.scope,
      ...change.subject,
      outcome: { behaviour: change.was, source: change.wasSource },
    },
  };
}

/** Where an action acted, by its tool: an app, a computer, a folder, another Bot. */
export function mediaOf(toolRef: string): ReplayRow["media"] {
  if (toolRef.startsWith("computer_"))
    return { icon: <IconDeviceDesktop />, label: "电脑操作" };
  if (toolRef.startsWith("host/"))
    return { icon: <IconFolder />, label: "电脑上的文件夹" };
  if (toolRef.startsWith("bot/"))
    return { icon: <IconUsers />, label: "转交给其他员工的工作" };
  if (toolRef.startsWith("openbot/"))
    return { icon: <IconLock />, label: "私密信息" };
  return { icon: <IconPlug />, label: "应用调用" };
}

function replayRowOf(change: BacktestChange): ReplayRow {
  const answer = change.person ? ANSWERS[change.person] : null;
  const fixed = change.change === "fixed";
  return {
    id: change.id,
    event: auditRowOf(change),
    media: mediaOf(change.toolRef),
    verdict: fixed ? "不变" : (WOULD[change.would] ?? change.would),
    verdictClassName: fixed
      ? "text-muted-foreground"
      : change.change === "removes_ask"
        ? change.person === "deny"
          ? "text-destructive"
          : "text-amber-600 dark:text-amber-500"
        : "text-foreground",
    note: [fixed ? change.reason : null, answer].filter(Boolean).join(""),
  };
}

/**
 * What the rules would have changed, worked out as they are edited: the headline, then each action in
 * Audit's own cells with what it would become, the asks a person had denied first. Actions a safety
 * requirement, auto-review or a task decided are listed as unchanged, after the rest.
 */
export function RulesBacktest({
  preview,
  asksMore,
}: {
  preview: UseQueryResult<ApprovalRulesPreview>;
  /** Whether a rule asks or hands off, which can reach actions the trail never recorded. */
  asksMore: boolean;
}) {
  if (preview.isPending) return null;
  return (
    <Field aria-labelledby="rules-backtest" aria-live="polite">
      <FieldLabel id="rules-backtest">拿最近的动作试一试</FieldLabel>
      {preview.error ? (
        <p className="text-destructive text-sm" role="alert">
          {preview.error.message}
        </p>
      ) : preview.data.report.scanned === 0 ? (
        <FieldDescription>
          还没有检查过的动作可以拿来测试。员工开始干活后，就能看到这些规则会改变什么。
        </FieldDescription>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <p className="font-medium text-sm">
              {backtestHeadline(preview.data.report)}
            </p>
            <FieldDescription className="mt-1">
              {replayWords(preview.data.report, asksMore)}
            </FieldDescription>
          </div>
          {preview.data.report.changes.length > 0 ? (
            <ReplayRows
              rows={preview.data.report.changes.map(replayRowOf)}
              total={preview.data.report.changed + preview.data.report.fixed}
            />
          ) : null}
        </div>
      )}
    </Field>
  );
}
