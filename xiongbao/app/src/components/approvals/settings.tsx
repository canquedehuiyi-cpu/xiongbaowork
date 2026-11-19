import {
  IconChecklist,
  IconEyeCheck,
  IconHandStop,
  IconTerminal2,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  approvalInboxOptions,
  approvalPreferencesMutationOptions,
  createApprovalRuleMutationOptions,
  revokeApprovalRuleMutationOptions,
  ruleCoversBot,
  updateApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { shortName } from "@/lib/brand";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import {
  ALWAYS_ASKS,
  ASK_FIRST_DESCRIPTION,
  ASK_FIRST_TITLE,
  HANDED_TO_YOU,
} from "./ask-first-copy";
import { HOST_LABELS, LabelSelect, RuleForm, RuleRow } from "./rules";

/**
 * The person's own approval settings: whether their employees ask before changing things, and the
 * rules that apply to every one of them. Team rules are listed so the person can see them, locked;
 * administrators change them in 管理 → 审批. Rules for a single employee are on that employee's page.
 *
 * What always asks (the floor) is stated in ask-first-copy.ts's words and is decided by the server
 * before any of these switches or rules is read; nothing here can loosen it.
 */
export function ApprovalSettings() {
  const inbox = useQuery(approvalInboxOptions());
  const me = useQuery(currentUserQueryOptions()).data;
  // The personal edition has no Admin to point at, and no team for team settings to govern.
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const agents = useQuery(agentListQueryOptions());
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const preferences = useMutation(
    approvalPreferencesMutationOptions(queryClient),
  );
  const addRule = useMutation(createApprovalRuleMutationOptions(queryClient));
  const changeRule = useMutation(
    updateApprovalRuleMutationOptions(queryClient),
  );
  const revoke = useMutation(revokeApprovalRuleMutationOptions(queryClient));
  const error =
    inbox.error ?? preferences.error ?? changeRule.error ?? revoke.error;
  if (inbox.isPending && !error) return null;
  const enforced = inbox.data?.team?.enforceAutoReview ?? false;
  const rulesOff = inbox.data?.team?.customRulesEnabled === false;
  const everyBot = (inbox.data?.rules ?? []).filter(
    (rule) => rule.botId === "*",
  );
  /*
   * Rules that name no Bot this person can open — a Bot since deleted, or a name typed where an id
   * belonged. They are still enforced, so they are listed here where they can be removed.
   */
  const reachable = [...(agents.data ?? []), ...(hiddenAgents.data ?? [])];
  const otherBots = (inbox.data?.rules ?? []).filter(
    (rule) =>
      rule.botId !== "*" &&
      (agents.data === undefined ||
        !reachable.some((agent) => ruleCoversBot(rule.botId, agent.id))),
  );
  const teamRules = inbox.data?.teamRules ?? [];
  const canAdd = Boolean(inbox.data?.preferences) && !rulesOff;
  const saved = teamRules.length + everyBot.length;

  return (
    <>
      {error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {me?.role === "admin" && !personal ? (
        <p className="mt-6 text-muted-foreground text-sm">
          团队设置、共享账号申请和同事替员工申请的应用，在{" "}
          <Link className="underline underline-offset-4" to="/admin/approvals">
            管理 → 审批
          </Link>
          。
        </p>
      ) : null}
      <PageSection
        description={
          /*
           * What asks whatever these settings say (server/src/approvals/policy.ts), in the same words
           * as onboarding's Welcome (ask-first-copy.ts). A Bot's own workspace is left out of what
           * always asks on purpose: deleting a file there is an ordinary change, as the last sentence
           * says.
           */
          <>
            {ALWAYS_ASKS}
            在你自己电脑上的文件夹里，每一次编辑或运行命令之前也会先问你。
            {HANDED_TO_YOU}
            员工在自己的工作区里新建、编辑和删除文件不用问你，除非你的设置或规则另有要求。
          </>
        }
        title="员工动手之前"
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconHandStop />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{ASK_FIRST_TITLE}</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {ASK_FIRST_DESCRIPTION}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={ASK_FIRST_TITLE}
                checked={inbox.data?.enabled ?? false}
                disabled={inbox.isLoading || preferences.isPending}
                onCheckedChange={(enabled) => preferences.mutate({ enabled })}
              />
            </ItemActions>
          </Item>
          {inbox.data?.preferences ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconEyeCheck />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle id="auto-review-title">自动审核</ItemTitle>
                  <ItemDescription
                    className="line-clamp-none"
                    id="auto-review-description"
                  >
                    {enforced ? "管理员要求开启。" : ""}
                    员工要做可能影响你的账号或对外分享信息的事之前，
                    {shortName()}
                    会先对照你的要求和规则检查一遍；拿不准时再来问你。
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    // Named by its title alone and described by the sentence beside it, so the name
                    // stays short however long the description grows.
                    aria-describedby="auto-review-description"
                    aria-labelledby="auto-review-title"
                    checked={enforced || inbox.data.preferences.autoReview}
                    disabled={enforced || preferences.isPending}
                    onCheckedChange={(autoReview) =>
                      preferences.mutate({ autoReview })
                    }
                  />
                </ItemActions>
              </Item>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconTerminal2 />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>在你电脑上运行命令</ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    {inbox.data.hostCommands &&
                    inbox.data.hostCommands !==
                      inbox.data.preferences.hostCommands
                      ? `管理员把这一项限定为「${HOST_LABELS[inbox.data.hostCommands]}」。`
                      : ""}
                    每条命令运行前，{shortName()}桌面端仍会先给你看。
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <LabelSelect
                    disabled={preferences.isPending}
                    label="在你电脑上运行命令"
                    labels={HOST_LABELS}
                    onChange={(hostCommands) =>
                      preferences.mutate({ hostCommands })
                    }
                    value={inbox.data.preferences.hostCommands}
                  />
                </ItemActions>
              </Item>
            </>
          ) : null}
        </PageRows>
      </PageSection>
      <PageSection
        description={
          <>
            多条规则同时匹配时，以最严格的为准：「先问」胜过「允许」。
            {personal ? "" : "团队规则已锁定。"}只针对某一位员工的规则，在
            <Link className="underline underline-offset-4" to="/bots">
              那位员工的页面
            </Link>
            上。
            {rulesOff
              ? "管理员关闭了个人规则。你的规则会保留，但暂不生效。"
              : ""}
          </>
        }
        title="对所有员工生效的规则"
      >
        {saved === 0 ? (
          <PageEmpty icon={IconChecklist} title="还没有规则" />
        ) : null}
        {saved > 0 || canAdd ? (
          <PageRows>
            {teamRules.map((rule, index) => (
              <Fragment key={rule.id}>
                {index > 0 ? <Separator /> : null}
                <RuleRow
                  disabled
                  locked
                  onChange={() => {}}
                  onRevoke={() => {}}
                  rule={rule}
                  team
                />
              </Fragment>
            ))}
            {everyBot.map((rule, index) => (
              <Fragment key={rule.id}>
                {teamRules.length + index > 0 ? <Separator /> : null}
                <RuleRow
                  disabled={revoke.isPending || changeRule.isPending}
                  locked={rulesOff}
                  onChange={(behaviour) =>
                    changeRule.mutate({ id: rule.id, behaviour })
                  }
                  onRevoke={() => revoke.mutate(rule.id)}
                  rule={rule}
                />
              </Fragment>
            ))}
            {canAdd ? (
              <>
                {saved > 0 ? <Separator /> : null}
                <RuleForm botField={false} label="添加规则" save={addRule} />
              </>
            ) : null}
          </PageRows>
        ) : null}
      </PageSection>
      {agents.data !== undefined && otherBots.length > 0 ? (
        <PageSection
          description="这些规则对不上你能打开的任何一位员工，但仍对它们匹配到的员工生效。不需要的可以移除。"
          title="其他员工的规则"
        >
          <PageRows>
            {otherBots.map((rule, index) => (
              <Fragment key={rule.id}>
                {index > 0 ? <Separator /> : null}
                <RuleRow
                  disabled={revoke.isPending || changeRule.isPending}
                  locked={rulesOff}
                  onChange={(behaviour) =>
                    changeRule.mutate({ id: rule.id, behaviour })
                  }
                  onRevoke={() => revoke.mutate(rule.id)}
                  rule={rule}
                />
              </Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
    </>
  );
}
