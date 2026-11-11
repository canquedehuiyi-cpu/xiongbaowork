import { IconChecklist } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Separator } from "@/components/ui/separator";
import {
  approvalInboxOptions,
  createApprovalRuleMutationOptions,
  revokeApprovalRuleMutationOptions,
  ruleCoversBot,
  updateApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";
import { RuleForm, RuleRow } from "./rules";

/**
 * The person's approval rules for one Bot, and the team rules that reach it, locked, as one card of
 * rows ending in the row that adds one. Rules for every Bot are in 设置 › 审批. A rule's
 * `botId` is the Bot's id, or a pattern covering it.
 */
export function BotApprovalRules({ agentId }: { agentId: string }) {
  const inbox = useQuery(approvalInboxOptions());
  const addRule = useMutation(createApprovalRuleMutationOptions(queryClient));
  const changeRule = useMutation(
    updateApprovalRuleMutationOptions(queryClient),
  );
  const revoke = useMutation(revokeApprovalRuleMutationOptions(queryClient));
  const error = inbox.error ?? changeRule.error ?? revoke.error;
  if (inbox.isPending && !error) return null;
  const rulesOff = inbox.data?.team?.customRulesEnabled === false;
  // Rules naming this Bot, including a pattern that covers it; rules for every Bot are in Settings.
  const mine = (inbox.data?.rules ?? []).filter(
    (rule) => rule.botId !== "*" && ruleCoversBot(rule.botId, agentId),
  );
  const team = (inbox.data?.teamRules ?? []).filter(
    (rule) => rule.botId === "*" || rule.botId === agentId,
  );
  const canAdd = Boolean(inbox.data?.preferences) && !rulesOff;
  const saved = team.length + mine.length;

  return (
    <PageSection
      description={
        <>
          匹配的规则里最严的那条说了算：「先问我」压过「允许」。对所有员工生效的规则在
          <Link
            className="text-foreground underline underline-offset-4"
            to="/settings/approvals"
          >
            设置 › 审批
          </Link>
          里。审批底线管的动作（对外发送、删除、分享、发帖等）不受这里的规则放宽。
          {rulesOff
            ? "管理员关闭了个人规则。你的规则会保留，但暂时不生效。"
            : ""}
        </>
      }
      title="审批规则"
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {saved === 0 ? (
        <PageEmpty icon={IconChecklist} title="这位员工还没有规则" />
      ) : null}
      {saved > 0 || canAdd ? (
        <PageRows>
          {team.map((rule, index) => (
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
          {mine.map((rule, index) => (
            <Fragment key={rule.id}>
              {team.length + index > 0 ? <Separator /> : null}
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
              <RuleForm
                botField={false}
                forBot={agentId}
                label="添加规则"
                save={addRule}
              />
            </>
          ) : null}
        </PageRows>
      ) : null}
    </PageSection>
  );
}
