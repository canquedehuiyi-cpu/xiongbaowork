import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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

const HOST_LABELS: Record<HostCommandPolicy, string> = {
  ask: "每次都问",
  allow: "总是允许",
  never: "从不",
};
const selectClass =
  "h-9 rounded-md border bg-background px-2 text-sm disabled:opacity-50";

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
  return (
    <div className="space-y-6">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      <label
        htmlFor="ask-before-changes"
        className="flex items-center justify-between gap-4 rounded-lg border p-4"
      >
        <span>
          <span className="block font-medium">改动前先问我</span>
          <span className="text-sm text-muted-foreground">
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
          <label
            htmlFor="auto-review"
            className="flex items-center justify-between gap-4 rounded-lg border p-4"
          >
            <span>
              <span id="auto-review-title" className="block font-medium">
                自动审查
              </span>
              <span
                id="auto-review-description"
                className="text-sm text-muted-foreground"
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
          <label
            htmlFor="host-commands"
            className="flex items-center justify-between gap-4 rounded-lg border p-4"
          >
            <span>
              <span className="block font-medium">在你电脑上执行命令</span>
              <span className="text-sm text-muted-foreground">
                {inbox.data.hostCommands &&
                inbox.data.hostCommands !== inbox.data.preferences.hostCommands
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
              {(Object.keys(HOST_LABELS) as HostCommandPolicy[]).map((key) => (
                <option key={key} value={key}>
                  {HOST_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      <div className="space-y-3">
        <h2 className="font-medium">等你处理</h2>
        {inbox.data?.questions.map((question) => (
          <article
            key={question.id}
            className="space-y-3 rounded-lg border p-4"
          >
            <h3 className="font-medium">
              {question.botId} 问：{question.question}
            </h3>
            {question.why ? (
              <p className="text-sm text-muted-foreground">{question.why}</p>
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
            <Button
              disabled={answer.isPending || !answers[question.id]?.trim()}
              onClick={() =>
                answer.mutate({
                  id: question.id,
                  response: answers[question.id] ?? "",
                })
              }
            >
              发送回答
            </Button>
          </article>
        ))}
        {inbox.isLoading ? (
          <p className="text-sm text-muted-foreground">正在读取审批…</p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            没有需要你批准的动作。
          </p>
        ) : (
          pending.map((request) => (
            <article
              className="space-y-3 rounded-lg border p-4"
              key={request.id}
            >
              <div>
                <h3 className="font-medium">
                  {request.action.botId} 想要{" "}
                  {request.action.toolRef
                    .replace(/^computer_|^host\//, "")
                    .replaceAll("_", " ")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {request.action.scope}
                </p>
                {request.action.policy ? (
                  <p className="text-sm">
                    {request.action.policy.behaviour === "hand_off"
                      ? "交给你："
                      : ""}
                    {request.action.policy.reason}
                  </p>
                ) : null}
              </div>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                {JSON.stringify(request.action.args, null, 2)}
              </pre>
              {request.action.policy?.behaviour === "hand_off" ? (
                <div className="flex flex-wrap gap-2">
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
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={decision.isPending}
                    onClick={() =>
                      decision.mutate({ id: request.id, choice: "allow_once" })
                    }
                  >
                    允许一次
                  </Button>
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
      <div className="space-y-3">
        <h2 className="font-medium">规则</h2>
        <p className="text-sm text-muted-foreground">
          匹配到的规则里最严格的一条生效，所以「先问」会压过「允许」。团队规则已锁定。修改密码、安全设置和付款永远交给你来做。
          {rulesOff ? "团队关闭了个人规则，它们会保留但不生效。" : ""}
        </p>
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
        {!inbox.data?.rules.length && !inbox.data?.teamRules.length ? (
          <p className="text-sm text-muted-foreground">还没有保存的规则。</p>
        ) : null}
        {inbox.data?.preferences && !rulesOff ? (
          <RuleForm
            label="添加规则"
            pending={addRule.isPending}
            onSave={(input) => addRule.mutate(input)}
          />
        ) : null}
      </div>
      {isAdmin && inbox.data?.team ? (
        <div className="space-y-3">
          <h2 className="font-medium">团队设置</h2>
          <label
            htmlFor="enforce-auto-review"
            className="flex items-center justify-between gap-4 rounded-lg border p-4"
          >
            <span id="enforce-auto-review-title" className="font-medium">
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
          <label
            htmlFor="custom-rules"
            className="flex items-center justify-between gap-4 rounded-lg border p-4"
          >
            <span id="custom-rules-title" className="font-medium">
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
          <label
            htmlFor="host-commands-cap"
            className="flex items-center justify-between gap-4 rounded-lg border p-4"
          >
            <span>
              <span className="block font-medium">
                成员电脑上执行命令的上限
              </span>
              <span className="text-sm text-muted-foreground">
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
              {(Object.keys(HOST_LABELS) as HostCommandPolicy[]).map((key) => (
                <option key={key} value={key}>
                  {HOST_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
          <RuleForm
            label="添加团队规则"
            pending={addTeamRule.isPending}
            onSave={(input) => addTeamRule.mutate(input)}
          />
        </div>
      ) : null}
    </div>
  );
}

function RuleRow({
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
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
      <div className="space-y-1">
        {locked ? (
          <p className="text-sm font-medium">{label}</p>
        ) : (
          <select
            aria-label={`「${rule.toolRef}」的处理方式`}
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
        <p className="text-sm text-muted-foreground">
          {rule.toolRef}
          {rule.effect !== "*" ? `，${rule.effect}` : ""}
          {rule.scope !== "*" ? `，目标 ${rule.scope}` : ""}
          {rule.botId !== "*" ? `，员工 ${rule.botId}` : ""}
        </p>
      </div>
      {locked ? (
        <span className="text-sm text-muted-foreground">已锁定</span>
      ) : (
        <Button variant="outline" disabled={disabled} onClick={onRevoke}>
          移除
        </Button>
      )}
    </div>
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
    <label className="grid gap-1 text-sm">
      <span>{title}</span>
      <input
        aria-label={title}
        className="h-9 rounded-md border bg-background px-2"
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
      className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(rule);
        setRule(EMPTY_RULE);
      }}
    >
      <h3 className="font-medium sm:col-span-2">{label}</h3>
      {field("toolRef", "工具或应用", "mcp/gmail/*, computer_click, host/*")}
      {field("effect", "动作类型", "*、write、read、delegate")}
      {field("scope", "目标", "*、某个网站、某个文件夹、某位员工")}
      {field("botId", "员工", "* 表示所有员工")}
      <label className="grid gap-1 text-sm">
        <span>处理方式</span>
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
          保存规则
        </Button>
      </div>
    </form>
  );
}
