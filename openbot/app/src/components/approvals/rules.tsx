import { ruleTitle } from "@openbot/shared/tool-name";
import {
  IconChevronRight,
  IconLock,
  IconPlus,
  IconShieldCheck,
} from "@tabler/icons-react";
import { type UseMutationResult, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GONE_BOT, useBotNames } from "@/lib/agents/bot-names";
import {
  type ApprovalRuleInput,
  type ApprovalRuleRow,
  BEHAVIOUR_LABELS,
  type HostCommandPolicy,
  type RuleBehaviour,
} from "@/lib/approvals";
import {
  type HostFolderGrant,
  hostAccessQueryOptions,
} from "@/lib/computers/host-access";

/**
 * The tool pattern the rule form shows as its example. It has to match real tool names, which start
 * with the app as OpenBot lists it (`composio-gmail/GMAIL_SEND_EMAIL`): the earlier example,
 * `mcp/gmail/*`, matched no tool at all, so a rule typed from it never applied.
 */
export const TOOL_PATTERN_EXAMPLE = "composio-gmail/*";

export const HOST_LABELS: Record<HostCommandPolicy, string> = {
  ask: "每次都问",
  allow: "总是允许",
  never: "从不",
};

/**
 * One value from a fixed set of labelled choices: a rule's behaviour, or how commands on a computer
 * are handled. The keys of `labels` are the values, in the order they are offered.
 */
export function LabelSelect<T extends string>({
  id,
  label,
  labels,
  value,
  disabled,
  onChange,
}: {
  id?: string;
  /** The trigger's accessible name, where no visible label names it. */
  label?: string;
  labels: Record<T, string>;
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next as T);
      }}
      value={value}
    >
      <SelectTrigger aria-label={label} id={id}>
        <SelectValue>{labels[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(labels) as T[]).map((key) => (
          <SelectItem key={key} value={key}>
            {labels[key]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The behaviours a team rule is offered under, each saying it is the team's. */
const TEAM_BEHAVIOUR_LABELS = Object.fromEntries(
  Object.entries(BEHAVIOUR_LABELS).map(([key, label]) => [
    key,
    `${label}（团队规则）`,
  ]),
) as Record<RuleBehaviour, string>;

/** What kind of action a rule covers, in words. Any other kind is left unsaid. */
const EFFECT_WORDS: Record<string, string> = {
  read: "读取",
  write: "修改",
  destructive: "删除",
  delegate: "转交工作",
};

/** "员工 报销助手"; nothing until the names arrive, so a Bot is never named by its id. */
function forBot(name: string): string | null {
  if (!name) return null;
  return name === GONE_BOT ? GONE_BOT : `员工 ${name}`;
}

/** A rule saved from a folder's card is on the id OpenBot gave that folder (`host-access/broker.ts`). */
const FOLDER_GRANT = "host-grant-";

/**
 * A folder rule's place by the folder's name, as Settings → Computer shows it: "in share". A grant
 * ends when OpenBot stops, so a rule on one that is gone says so rather than naming its id.
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

/**
 * 上游 main 的版本（fork 曾删掉，审批设置画在 inbox.tsx 里），中文化后留给第二阶段的员工详情和管理页接上。
 *
 * One saved rule, as a row: what it matches, and what a Bot does about it. A locked rule — a team
 * rule seen by a member, or a personal rule the team has switched off — states its behaviour and
 * offers nothing to change.
 */
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
  const labels = team ? TEAM_BEHAVIOUR_LABELS : BEHAVIOUR_LABELS;
  // The action in its approval card's words is the title ("Click", "Any action on Gmail"); the rest
  // of what the rule matches is the line beneath, never clamped, since two rules for one action
  // differ only there. The title already names an app's rule's place.
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
    // A rule saved for one of several accounts at the app covers that account only.
    rule.account ? `账号 ${rule.account}` : null,
    rule.botId === "*"
      ? null
      : rule.botId.includes("*")
        ? `名字匹配 ${rule.botId} 的员工`
        : forBot(botName(rule.botId)),
  ]
    .filter(Boolean)
    .join("，");
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {locked ? <IconLock /> : <IconShieldCheck />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        {match ? (
          <ItemDescription className="line-clamp-none break-all">
            {match}
          </ItemDescription>
        ) : null}
        {locked ? <ItemDescription>已锁定</ItemDescription> : null}
      </ItemContent>
      <ItemActions>
        {locked ? (
          <span className="text-muted-foreground text-sm">
            {labels[rule.behaviour]}
          </span>
        ) : (
          <>
            <LabelSelect
              disabled={disabled}
              label={`「${title}」的处理方式`}
              labels={labels}
              onChange={onChange}
              value={rule.behaviour}
            />
            <Button
              disabled={disabled}
              onClick={onRevoke}
              size="sm"
              variant="outline"
            >
              移除
            </Button>
          </>
        )}
      </ItemActions>
    </Item>
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
 * An action class and a behaviour, added from a row that opens a dialog. `*` matches anything, so
 * `composio-gmail/*` is every Gmail tool and a target of `*.example.com` is every page on that site.
 */
export function RuleForm({
  label,
  save,
  botField = true,
  forBot,
}: {
  label: string;
  /** The write that adds the rule. The dialog closes when it succeeds and shows why when it fails. */
  save: UseMutationResult<unknown, Error, ApprovalRuleInput>;
  /** Off where the rule applies to every Bot, so there is no Bot to name. */
  botField?: boolean;
  /** The Bot every rule from this form is for, already known from the page it is on. */
  forBot?: string;
}) {
  const blank = forBot ? { ...EMPTY_RULE, botId: forBot } : EMPTY_RULE;
  const [rule, setRule] = useState<ApprovalRuleInput>(blank);
  const [open, setOpen] = useState(false);
  const id = useId();
  // Closing without saving drops what was typed, so the dialog opens blank next time.
  const close = () => {
    setOpen(false);
    setRule(blank);
  };
  // Opening starts clean: the last attempt's failure belongs to the draft it was about.
  const show = () => {
    save.reset();
    setOpen(true);
  };
  const field = (key: keyof ApprovalRuleInput, title: string, hint: string) => (
    <Field>
      <FieldLabel htmlFor={`${id}-${key}`}>{title}</FieldLabel>
      <Input
        id={`${id}-${key}`}
        onChange={(event) => {
          // Read before the updater runs: React restores a controlled input's DOM value first.
          const value = event.target.value;
          setRule((prior) => ({ ...prior, [key]: value }));
        }}
        placeholder={hint}
        value={rule[key]}
      />
    </Field>
  );
  return (
    <>
      <Item render={<button onClick={show} type="button" />} size="sm">
        <ItemMedia variant="icon">
          <IconPlus />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{label}</ItemTitle>
          <ItemDescription>
            一个工具或应用，以及员工用它之前要怎么做。
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={(next) => (next ? show() : close())} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              用 * 匹配任意内容。应用的工具以应用名开头，所以{" "}
              {TOOL_PATTERN_EXAMPLE} 表示所有 Gmail 工具。目标写
              *.example.com 表示这个网站的所有页面。
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
                direct child of DialogContent and keeps scrolling. */}
            <form
              id={id}
              onSubmit={(event) => {
                event.preventDefault();
                // A failed save keeps the dialog and the draft, so the person can correct it.
                save.mutate(rule, { onSuccess: close });
              }}
            >
              <FieldGroup>
                {field(
                  "toolRef",
                  "工具或应用",
                  `${TOOL_PATTERN_EXAMPLE}, computer_click, host/*`,
                )}
                {field("effect", "动作类型", "*、write、read、delegate")}
                {field("scope", "目标", "*、某个网站、某个文件夹、某位员工")}
                {botField ? field("botId", "员工", "* 表示所有员工") : null}
                <Field>
                  <FieldLabel htmlFor={`${id}-behaviour`}>处理方式</FieldLabel>
                  <LabelSelect
                    id={`${id}-behaviour`}
                    labels={BEHAVIOUR_LABELS}
                    onChange={(behaviour) =>
                      setRule((prior) => ({ ...prior, behaviour }))
                    }
                    value={rule.behaviour}
                  />
                </Field>
              </FieldGroup>
            </form>
            {save.error ? (
              <p className="mt-4 text-destructive text-sm" role="alert">
                {save.error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={close} size="sm" variant="outline">
              取消
            </Button>
            <Button
              disabled={save.isPending || !rule.toolRef.trim()}
              form={id}
              size="sm"
              type="submit"
            >
              {save.isPending ? "正在保存…" : "保存规则"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
