import { IconLock } from "@tabler/icons-react";
import { ruleTitle } from "@openbot/shared/tool-name";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CARD_FACE, Tag } from "@/components/resources/resource-kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { GONE_BOT, useBotNames } from "@/lib/agents/bot-names";
import {
  type ApprovalDecision,
  type ApprovalRuleInput,
  type ApprovalRuleRow,
  answerPersonQuestion,
  approvalInboxOptions,
  BEHAVIOUR_LABELS,
  createApprovalRule,
  createTeamApprovalRule,
  decideApproval,
  type HostCommandPolicy,
  offersStandingRule,
  POLICY_SOURCE_LABELS,
  type RuleBehaviour,
  revokeApprovalRule,
  revokeTeamApprovalRule,
  setApprovalEnabled,
  setApprovalPreferences,
  setTeamApprovalSettings,
  updateApprovalRule,
  updateTeamApprovalRule,
} from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  type HostFolderGrant,
  hostAccessQueryOptions,
} from "@/lib/computers/host-access";
import { approvalTargetName } from "./inline-approval";
import { afterChinese } from "./waiting";

const HOST_LABELS: Record<HostCommandPolicy, string> = {
  ask: "每次都问",
  allow: "总是允许",
  never: "从不",
};
/*
 * docs/design/ios-studio: the workbench's 32px control on a dark plate, graphite cards on a hairline,
 * and the red plate only for what waits on the person.
 */
const selectClass =
  "h-[32px] min-w-0 rounded-[9px] border border-border bg-muted px-[9px] text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[oklch(0.196_0.002_286.2)]";
/** Something that waits on the person: the red plate, with a red hairline. */
const ATTENTION_CARD =
  "rounded-[13px] border border-signal/40 bg-signal-soft shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]";
/** One setting: its name and what it means on the left, its control on the right. */
const SETTING_ROW =
  "flex items-center justify-between gap-4 px-[14px] py-[12px] cursor-pointer";

export function ApprovalInbox() {
  const cache = useQueryClient();
  const inbox = useQuery(approvalInboxOptions());
  const refresh = () => cache.invalidateQueries({ queryKey: ["approvals"] });
  const decision = useMutation({
    mutationFn: ({ id, choice }: { id: string; choice: ApprovalDecision }) =>
      decideApproval(id, choice),
    onSuccess: refresh,
  });
  const preference = useMutation({
    mutationFn: setApprovalEnabled,
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: revokeApprovalRule,
    onSuccess: refresh,
  });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const answer = useMutation({
    mutationFn: ({ id, response }: { id: string; response: string }) =>
      answerPersonQuestion(id, response),
    onSuccess: refresh,
  });
  const { data: me } = useQuery(currentUserQueryOptions());
  const botName = useBotNames();
  const isAdmin = me?.role === "admin";
  const preferences = useMutation({
    mutationFn: setApprovalPreferences,
    onSuccess: refresh,
  });
  const addRule = useMutation({
    mutationFn: createApprovalRule,
    onSuccess: refresh,
  });
  const team = useMutation({
    mutationFn: setTeamApprovalSettings,
    onSuccess: refresh,
  });
  const addTeamRule = useMutation({
    mutationFn: createTeamApprovalRule,
    onSuccess: refresh,
  });
  const changeRule = useMutation({
    mutationFn: ({ id, behaviour }: { id: string; behaviour: RuleBehaviour }) =>
      updateApprovalRule(id, { behaviour }),
    onSuccess: refresh,
  });
  const changeTeamRule = useMutation({
    mutationFn: ({ id, behaviour }: { id: string; behaviour: RuleBehaviour }) =>
      updateTeamApprovalRule(id, { behaviour }),
    onSuccess: refresh,
  });
  const revokeTeam = useMutation({
    mutationFn: revokeTeamApprovalRule,
    onSuccess: refresh,
  });
  const error =
    inbox.error ??
    decision.error ??
    preference.error ??
    revoke.error ??
    answer.error ??
    preferences.error ??
    addRule.error ??
    team.error ??
    addTeamRule.error ??
    revokeTeam.error ??
    changeRule.error ??
    changeTeamRule.error;
  const enforced = inbox.data?.team?.enforceAutoReview ?? false;
  const rulesOff = inbox.data?.team?.customRulesEnabled === false;
  const pending =
    inbox.data?.requests.filter((request) => request.status === "pending") ??
    [];
  const rulesEmpty = !inbox.data?.rules.length && !inbox.data?.teamRules.length;
  return (
    <div className="flex flex-col gap-[28px]">
      {error ? (
        <p
          role="alert"
          className="rounded-[13px] border border-signal/40 bg-signal-soft px-4 py-3 text-[13px] text-signal-ink"
        >
          {error.message}
        </p>
      ) : null}

      {/*
       * What is waiting comes first: on this page the person's job is to answer. Each waiting item is
       * drawn on the red plate (docs/design/ios-studio: red only for what needs attention), with the
       * one primary verb in white and the others outlined.
       */}
      <section aria-labelledby="approvals-waiting" className="flex flex-col">
        <SectionTitle
          count={
            inbox.isLoading
              ? undefined
              : pending.length + (inbox.data?.questions.length ?? 0)
          }
          id="approvals-waiting"
          title="等你处理"
        />
        <div className="flex flex-col gap-[9px]">
          {inbox.data?.questions.map((question) => (
            <article
              key={question.id}
              className={`${ATTENTION_CARD} flex flex-col gap-3 p-[14px]`}
            >
              <div className="flex items-start gap-[10px]">
                <Tag tone="warning">提问</Tag>
                <h3 className="min-w-0 font-semibold text-[14px] leading-[20px]">
                  {botName(question.botId)} 问：{question.question}
                </h3>
              </div>
              {question.why ? (
                <p className="text-[13px] text-muted-foreground">
                  {question.why}
                </p>
              ) : null}
              <Textarea
                aria-label="你的回答"
                placeholder="你的回答"
                value={answers[question.id] ?? ""}
                onChange={(event) =>
                  setAnswers((prior) => ({
                    ...prior,
                    [question.id]: event.target.value,
                  }))
                }
              />
              <div>
                <Button
                  disabled={answer.isPending || !answers[question.id]?.trim()}
                  onClick={() =>
                    answer.mutate({
                      id: question.id,
                      response: answers[question.id] ?? "",
                    })
                  }
                >
                  {answer.isPending ? "正在发送…" : "发送回答"}
                </Button>
              </div>
            </article>
          ))}
          {inbox.isLoading ? (
            <div
              aria-label="正在读取审批"
              className="flex flex-col gap-[9px]"
              role="status"
            >
              <p className="sr-only">正在读取审批…</p>
              <Skeleton className="h-[132px] rounded-[13px]" />
            </div>
          ) : pending.length === 0 ? (
            <p className="rounded-[13px] border border-border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">
              没有需要你批准的动作。
            </p>
          ) : (
            pending.map((request) => (
              <article
                className={`${ATTENTION_CARD} flex flex-col gap-3 p-[14px]`}
                key={request.id}
              >
                <div className="flex flex-col gap-[4px]">
                  <div className="flex flex-wrap items-center gap-[8px]">
                    <Tag tone="warning">
                      {request.action.policy?.behaviour === "hand_off"
                        ? "需要你来做"
                        : "待批准"}
                    </Tag>
                    <h3 className="min-w-0 font-semibold text-[14px] leading-[20px]">
                      {botName(request.action.botId)} 想要
                      {afterChinese(
                        request.action.toolRef
                          .replace(/^computer_|^host\//, "")
                          .replaceAll("_", " "),
                      )}
                    </h3>
                  </div>
                  <p className="text-[12px] text-muted-foreground">
                    {approvalTargetName(request.action)}
                  </p>
                  {request.action.policy ? (
                    <p className="text-[13px]">
                      {request.action.policy.behaviour === "hand_off"
                        ? "交给你："
                        : ""}
                      {request.action.policy.reason}
                      {POLICY_SOURCE_LABELS[request.action.policy.source] ? (
                        <span className="ml-2 text-muted-foreground">
                          （来源：
                          {POLICY_SOURCE_LABELS[request.action.policy.source]}）
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                </div>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-[9px] border border-border bg-background p-3 font-mono text-[12px]">
                  {JSON.stringify(request.action.args, null, 2)}
                </pre>
                {request.action.policy?.behaviour === "hand_off" ? (
                  <div className="flex flex-wrap gap-[7px]">
                    <Button
                      disabled={decision.isPending}
                      onClick={() =>
                        decision.mutate({ id: request.id, choice: "handled" })
                      }
                    >
                      我自己做了
                    </Button>
                    <Button
                      variant="outline"
                      disabled={decision.isPending}
                      onClick={() =>
                        decision.mutate({ id: request.id, choice: "deny" })
                      }
                    >
                      别做
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-[7px]">
                    <Button
                      disabled={decision.isPending}
                      onClick={() =>
                        decision.mutate({
                          id: request.id,
                          choice: "allow_once",
                        })
                      }
                    >
                      允许一次
                    </Button>
                    {/* 删除类和对外发送底线问的动作每次都要问，存下的规则用不上，所以不画这个按钮。 */}
                    {!offersStandingRule(request.action.policy) ? null : (
                      <Button
                        variant="outline"
                        disabled={decision.isPending}
                        onClick={() =>
                          decision.mutate({
                            id: request.id,
                            choice: "allow_always",
                          })
                        }
                      >
                        在这里总是允许
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={decision.isPending}
                      onClick={() =>
                        decision.mutate({ id: request.id, choice: "deny" })
                      }
                    >
                      拒绝
                    </Button>
                  </div>
                )}
              </article>
            ))
          )}
        </div>
      </section>

      <section aria-labelledby="approvals-mine" className="flex flex-col">
        <SectionTitle id="approvals-mine" title="你的设置" />
        <div className={`${CARD_FACE} flex flex-col divide-y divide-border`}>
          <label htmlFor="ask-before-changes" className={SETTING_ROW}>
            <span className="min-w-0">
              <span className="block font-semibold text-[14px]">
                改动前先问我
              </span>
              <span className="text-[13px] text-muted-foreground">
                员工改动网站、已连接的应用和文件之前，先给你过目。
              </span>
            </span>
            <Switch
              id="ask-before-changes"
              aria-label="改动前先问我"
              checked={inbox.data?.enabled ?? false}
              disabled={inbox.isLoading || preference.isPending}
              onCheckedChange={(enabled) => preference.mutate(enabled)}
            />
          </label>
          {inbox.data?.preferences ? (
            <>
              <label htmlFor="auto-review" className={SETTING_ROW}>
                <span className="min-w-0">
                  <span
                    id="auto-review-title"
                    className="block font-semibold text-[14px]"
                  >
                    自动审查
                  </span>
                  <span
                    id="auto-review-description"
                    className="text-[13px] text-muted-foreground"
                  >
                    {enforced ? "团队要求开启。" : ""}
                    在可能影响你的账户或对外分享信息的动作之前，会有一个模型对照你的要求、你的规则和安全要求检查一遍；它拿不准时会来问你。
                  </span>
                </span>
                <Switch
                  id="auto-review"
                  // Named by its title alone and described by the sentence under it, so the name does
                  // not depend on how a label wrapping a composite control is resolved.
                  aria-labelledby="auto-review-title"
                  aria-describedby="auto-review-description"
                  checked={enforced || inbox.data.preferences.autoReview}
                  disabled={enforced || preferences.isPending}
                  onCheckedChange={(autoReview) =>
                    preferences.mutate({ autoReview })
                  }
                />
              </label>
              <label htmlFor="host-commands" className={SETTING_ROW}>
                <span className="min-w-0">
                  <span className="block font-semibold text-[14px]">
                    在你电脑上执行命令
                  </span>
                  <span className="text-[13px] text-muted-foreground">
                    {inbox.data.hostCommands &&
                    inbox.data.hostCommands !==
                      inbox.data.preferences.hostCommands
                      ? `团队把这一项限定为「${HOST_LABELS[inbox.data.hostCommands]}」。`
                      : ""}
                    桌面客户端仍会在每条命令于你电脑上执行前先给你看。
                  </span>
                </span>
                <select
                  id="host-commands"
                  aria-label="在你电脑上执行命令"
                  className={selectClass}
                  value={inbox.data.preferences.hostCommands}
                  disabled={preferences.isPending}
                  onChange={(event) =>
                    preferences.mutate({
                      hostCommands: event.target.value as HostCommandPolicy,
                    })
                  }
                >
                  {(Object.keys(HOST_LABELS) as HostCommandPolicy[]).map(
                    (key) => (
                      <option key={key} value={key}>
                        {HOST_LABELS[key]}
                      </option>
                    ),
                  )}
                </select>
              </label>
            </>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="approvals-rules" className="flex flex-col">
        <SectionTitle id="approvals-rules" title="规则" />
        <p className="-mt-[3px] mb-[10px] max-w-[80ch] text-pretty text-[13px] text-muted-foreground leading-[1.6]">
          匹配到的规则里最严格的一条生效，所以「先问」会压过「允许」。团队规则已锁定。修改密码、安全设置和付款永远交给你来做。
          {rulesOff ? "团队关闭了个人规则，它们会保留但不生效。" : ""}
        </p>
        {rulesEmpty ? (
          <p className="rounded-[13px] border border-border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">
            还没有保存的规则。
          </p>
        ) : (
          /*
           * A table you scan: one rule per row, what it covers said in words beside how it is handled. On a phone
           * the card scrolls sideways inside itself instead of widening the page.
           */
          <div className={`${CARD_FACE} overflow-x-auto`}>
            <table className="w-full min-w-[520px] border-collapse text-left text-[13px]">
              <caption className="sr-only">审批规则</caption>
              <thead>
                <tr className="border-border border-b text-[11px] text-faint uppercase tracking-[0.06em]">
                  <th className="px-[14px] py-[9px] font-medium" scope="col">
                    处理方式
                  </th>
                  <th className="px-[10px] py-[9px] font-medium" scope="col">
                    规则
                  </th>
                  <th
                    className="px-[14px] py-[9px] text-right font-medium"
                    scope="col"
                  >
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {inbox.data?.teamRules.map((rule) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    locked={!isAdmin}
                    disabled={revokeTeam.isPending || changeTeamRule.isPending}
                    onRevoke={() => revokeTeam.mutate(rule.id)}
                    onChange={(behaviour) =>
                      changeTeamRule.mutate({ id: rule.id, behaviour })
                    }
                    team
                  />
                ))}
                {inbox.data?.rules.map((rule) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    locked={rulesOff}
                    disabled={revoke.isPending || changeRule.isPending}
                    onRevoke={() => revoke.mutate(rule.id)}
                    onChange={(behaviour) =>
                      changeRule.mutate({ id: rule.id, behaviour })
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {inbox.data?.preferences && !rulesOff ? (
          <RuleForm
            label="添加规则"
            pending={addRule.isPending}
            onSave={(input) => addRule.mutate(input)}
          />
        ) : null}
      </section>

      {isAdmin && inbox.data?.team ? (
        <section aria-labelledby="approvals-team" className="flex flex-col">
          <SectionTitle id="approvals-team" title="团队设置" />
          <div className={`${CARD_FACE} flex flex-col divide-y divide-border`}>
            <label htmlFor="enforce-auto-review" className={SETTING_ROW}>
              <span
                id="enforce-auto-review-title"
                className="font-semibold text-[14px]"
              >
                要求所有人开启自动审查
              </span>
              <Switch
                id="enforce-auto-review"
                aria-labelledby="enforce-auto-review-title"
                checked={inbox.data.team.enforceAutoReview}
                disabled={team.isPending}
                onCheckedChange={(enforceAutoReview) =>
                  team.mutate({ enforceAutoReview })
                }
              />
            </label>
            <label htmlFor="custom-rules" className={SETTING_ROW}>
              <span
                id="custom-rules-title"
                className="font-semibold text-[14px]"
              >
                允许成员设置个人规则
              </span>
              <Switch
                id="custom-rules"
                aria-labelledby="custom-rules-title"
                checked={inbox.data.team.customRulesEnabled}
                disabled={team.isPending}
                onCheckedChange={(customRulesEnabled) =>
                  team.mutate({ customRulesEnabled })
                }
              />
            </label>
            <label htmlFor="enforce-dangerous-commands" className={SETTING_ROW}>
              <span className="min-w-0">
                <span
                  id="enforce-dangerous-commands-title"
                  className="block font-semibold text-[14px]"
                >
                  强制危险命令审批
                </span>
                <span className="text-[13px] text-muted-foreground">
                  所有员工运行危险命令前都要先问，员工自己的开关关不掉。
                </span>
              </span>
              <Switch
                id="enforce-dangerous-commands"
                aria-labelledby="enforce-dangerous-commands-title"
                checked={inbox.data.team.enforceDangerousCommands === true}
                disabled={team.isPending}
                onCheckedChange={(enforceDangerousCommands) =>
                  team.mutate({ enforceDangerousCommands })
                }
              />
            </label>
            <label htmlFor="host-commands-cap" className={SETTING_ROW}>
              <span className="min-w-0">
                <span className="block font-semibold text-[14px]">
                  成员电脑上执行命令的上限
                </span>
                <span className="text-[13px] text-muted-foreground">
                  成员自己更严格的设置仍然生效。
                </span>
              </span>
              <select
                id="host-commands-cap"
                aria-label="成员电脑上执行命令的上限"
                className={selectClass}
                value={inbox.data.team.hostCommandsCap}
                disabled={team.isPending}
                onChange={(event) =>
                  team.mutate({
                    hostCommandsCap: event.target.value as HostCommandPolicy,
                  })
                }
              >
                {(Object.keys(HOST_LABELS) as HostCommandPolicy[]).map(
                  (key) => (
                    <option key={key} value={key}>
                      {HOST_LABELS[key]}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>
          <RuleForm
            label="添加团队规则"
            pending={addTeamRule.isPending}
            onSave={(input) => addTeamRule.mutate(input)}
          />
        </section>
      ) : null}
    </div>
  );
}

/** A section's heading, with how many items wait in it when that is a number worth saying. */
function SectionTitle({
  id,
  title,
  count,
}: {
  id: string;
  title: string;
  count?: number;
}) {
  return (
    <div className="mb-[9px] flex min-h-[26px] items-center gap-[8px]">
      <h2
        className="font-bold text-[17px] leading-[26px] tracking-[-0.02em]"
        id={id}
      >
        {title}
      </h2>
      {count !== undefined && count > 0 ? (
        <Tag tone="warning">{count} 项</Tag>
      ) : null}
    </div>
  );
}

/** What kind of action a rule covers, in words. Any other kind is left unsaid. */
const EFFECT_WORDS: Record<string, string> = {
  read: "读取",
  write: "修改",
  destructive: "删除",
  delegate: "转交工作",
};

/** A rule saved from a folder's card is on the id OpenBot gave that folder (`host-access/broker.ts`). */
const FOLDER_GRANT = "host-grant-";

/**
 * A folder rule's place by the folder's name, as the computer settings show it: 「在 share 中」. A
 * grant ends when OpenBot stops, so a rule on one that is gone says so rather than naming its id.
 */
function folderWords(
  grantId: string,
  grants: readonly HostFolderGrant[] | undefined,
): string {
  if (!grants) return "在一个文件夹中";
  const grant = grants.find((candidate) => candidate.id === grantId);
  return grant && !grant.revoked
    ? `在 ${grant.displayName} 中`
    : "在一个已不再共享的文件夹中";
}

/** 「员工 Expenses」; nothing until the names arrive, so an employee is never named by its id. */
function forBot(name: string): string | null {
  if (!name) return null;
  return name === GONE_BOT ? GONE_BOT : `员工 ${name}`;
}

/**
 * What a saved rule matches beyond its title, in words: the kind of action, the place, the employee.
 * Never the id OpenBot gave a folder (`host-grant-…`), an employee's id, or the raw kind of action.
 */
export function useRuleMatch(rule: ApprovalRuleRow): {
  title: string;
  match: string;
} {
  const { title, place } = ruleTitle(rule);
  const botName = useBotNames();
  const folderRule = rule.scope.startsWith(FOLDER_GRANT);
  const folders = useQuery({
    ...hostAccessQueryOptions(),
    refetchInterval: false,
    enabled: folderRule,
  });
  const match = [
    EFFECT_WORDS[rule.effect] ?? null,
    rule.scope === "*" || place
      ? null
      : folderRule
        ? folderWords(rule.scope, folders.data?.grants)
        : `在 ${rule.scope} 上`,
    rule.botId === "*"
      ? null
      : rule.botId.includes("*")
        ? `名字匹配 ${rule.botId} 的员工`
        : forBot(botName(rule.botId)),
  ]
    .filter(Boolean)
    .join("，");
  return { title, match };
}

export function RuleRow({
  rule,
  team,
  locked,
  disabled,
  onRevoke,
  onChange,
}: {
  rule: ApprovalRuleRow;
  team?: boolean;
  locked?: boolean;
  disabled: boolean;
  onRevoke: () => void;
  onChange: (behaviour: RuleBehaviour) => void;
}) {
  const label = `${BEHAVIOUR_LABELS[rule.behaviour]}${team ? "（团队规则）" : ""}`;
  const { title, match } = useRuleMatch(rule);
  return (
    <tr className="align-middle">
      <td className="px-[14px] py-[10px]">
        {locked ? (
          <span className="flex items-center gap-[6px] font-medium">
            <IconLock
              aria-hidden="true"
              className="size-[13px] shrink-0 text-faint"
            />
            {label}
          </span>
        ) : (
          <select
            aria-label={`「${title}」的处理方式`}
            className={selectClass}
            value={rule.behaviour}
            disabled={disabled}
            onChange={(event) => {
              const behaviour = event.target.value as RuleBehaviour;
              onChange(behaviour);
            }}
          >
            {(Object.keys(BEHAVIOUR_LABELS) as RuleBehaviour[]).map((key) => (
              <option key={key} value={key}>
                {BEHAVIOUR_LABELS[key]}
                {team ? "（团队规则）" : ""}
              </option>
            ))}
          </select>
        )}
      </td>
      <td className="px-[10px] py-[10px]">
        <p className="font-medium">{title}</p>
        {match ? (
          <p className="break-all text-[12px] text-muted-foreground">{match}</p>
        ) : null}
      </td>
      <td className="px-[14px] py-[10px] text-right">
        {locked ? (
          <Tag>已锁定</Tag>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={onRevoke}
          >
            移除
          </Button>
        )}
      </td>
    </tr>
  );
}

const EMPTY_RULE: ApprovalRuleInput = {
  botId: "*",
  toolRef: "",
  effect: "*",
  scope: "*",
  behaviour: "ask",
};

/**
 * An action class and a behaviour. `*` matches anything, so `mcp/gmail/*` is every Gmail tool and a
 * target of `*.example.com` is every page on that site.
 */
function RuleForm({
  label,
  pending,
  onSave,
}: {
  label: string;
  pending: boolean;
  onSave: (input: ApprovalRuleInput) => void;
}) {
  const [rule, setRule] = useState<ApprovalRuleInput>(EMPTY_RULE);
  const field = (key: keyof ApprovalRuleInput, title: string, hint: string) => (
    <label className="grid min-w-0 gap-[5px] text-[13px]">
      <span className="font-medium">{title}</span>
      <input
        aria-label={title}
        className={`${selectClass} font-mono placeholder:font-sans placeholder:text-faint`}
        placeholder={hint}
        value={rule[key]}
        onChange={(event) => {
          // Read before the updater runs: React restores a controlled input's DOM value first.
          const value = event.target.value;
          setRule((prior) => ({ ...prior, [key]: value }));
        }}
      />
    </label>
  );
  return (
    <form
      className={`${CARD_FACE} mt-[9px] grid gap-3 p-[14px] sm:grid-cols-2`}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(rule);
        setRule(EMPTY_RULE);
      }}
    >
      <h3 className="font-semibold text-[14px] sm:col-span-2">{label}</h3>
      {field("toolRef", "工具或应用", "mcp/gmail/*, computer_click, host/*")}
      {field("effect", "动作类型", "*、write、read、delegate")}
      {field("scope", "目标", "*、某个网站、某个文件夹、某位员工")}
      {field("botId", "员工", "* 表示所有员工")}
      <label className="grid min-w-0 gap-[5px] text-[13px]">
        <span className="font-medium">处理方式</span>
        <select
          aria-label="处理方式"
          className={selectClass}
          value={rule.behaviour}
          onChange={(event) => {
            const behaviour = event.target.value as RuleBehaviour;
            setRule((prior) => ({ ...prior, behaviour }));
          }}
        >
          {(Object.keys(BEHAVIOUR_LABELS) as RuleBehaviour[]).map((key) => (
            <option key={key} value={key}>
              {BEHAVIOUR_LABELS[key]}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-end">
        <Button type="submit" disabled={pending || !rule.toolRef.trim()}>
          {pending ? "正在保存…" : "保存规则"}
        </Button>
      </div>
    </form>
  );
}
