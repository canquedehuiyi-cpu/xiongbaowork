import {
  IconChecklist,
  IconChevronRight,
  IconCreditCard,
  IconEyeCheck,
  IconKey,
  IconLock,
  IconNotes,
  IconSend,
  IconShare,
  IconSparkles,
  IconShieldExclamation,
  IconSpeakerphone,
  IconTerminal2,
  IconTrash,
  IconUserCog,
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
import {
  type ActionKind,
  type ActionKindPolicy,
  approvalInboxOptions,
  createTeamApprovalRuleMutationOptions,
  revokeTeamApprovalRuleMutationOptions,
  teamApprovalSettingsMutationOptions,
  updateTeamApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { reviewerGuidanceQueryOptions } from "@/lib/reviewer-guidance/queries";
import { queryClient } from "@/query-client";
import { HOST_LABELS, LabelSelect, RuleForm, RuleRow } from "./rules";

/**
 * The kinds of action Bots ask about by name, in the order members meet them.
 *
 * 本部署的审批底线（#398）不随上游 #1394 打开：删除、对外发送、分享、公开发布每次都问，只能「允许
 * 一次」；付款、改凭据、改安全设置总是交给成员本人（`handedOff`）。管理员的设置只能让它更严
 * （server/src/approvals/policy.ts 的 `closedKind`），所以交给本人的三类没有可选项。
 */
const ACTION_KIND_ROWS: {
  kind: ActionKind;
  title: string;
  icon: typeof IconSend;
  handedOff?: true;
}[] = [
  { kind: "sending", title: "对外发送", icon: IconSend },
  { kind: "deleting", title: "删除", icon: IconTrash },
  { kind: "sharing", title: "分享与授权", icon: IconShare },
  {
    kind: "publishing",
    title: "公开发布",
    icon: IconSpeakerphone,
  },
  {
    kind: "payments",
    title: "付款和购买",
    icon: IconCreditCard,
    handedOff: true,
  },
  {
    kind: "security_settings",
    title: "安全与访问设置",
    icon: IconLock,
    handedOff: true,
  },
  {
    kind: "credentials",
    title: "密码和登录信息",
    icon: IconKey,
    handedOff: true,
  },
];

/**
 * What members can do about one kind of action. `open` is the deployment's floor (Allow once and
 * Deny only), which `ask` does not widen either; only `hand_off` makes it stricter.
 */
const ACTION_KIND_LABELS: Record<ActionKindPolicy, string> = {
  open: "按默认（只能允许一次）",
  ask: "每次都问",
  hand_off: "交给成员自己做",
};

/**
 * 上游 main 的版本（fork 曾删掉，团队设置画在 inbox.tsx 里），中文化后留给第二阶段的管理页接上。
 *
 * What every member's Bots must do, set by an administrator: the team-wide controls, the rules that
 * apply to everyone, and requests to use a shared account. Members read the team rules, locked, in
 * Settings → Approvals.
 */
export function TeamApprovalSettings() {
  const inbox = useQuery(approvalInboxOptions());
  const guidance = useQuery(reviewerGuidanceQueryOptions());
  const team = useMutation(teamApprovalSettingsMutationOptions(queryClient));
  const addTeamRule = useMutation(
    createTeamApprovalRuleMutationOptions(queryClient),
  );
  const changeTeamRule = useMutation(
    updateTeamApprovalRuleMutationOptions(queryClient),
  );
  const revokeTeam = useMutation(
    revokeTeamApprovalRuleMutationOptions(queryClient),
  );
  const error =
    inbox.error ?? team.error ?? changeTeamRule.error ?? revokeTeam.error;
  if (inbox.isPending && !error) return null;
  const settings = inbox.data?.team;
  const teamRules = inbox.data?.teamRules ?? [];

  return (
    <>
      {error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {settings ? (
        <PageSection title="团队设置">
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconEyeCheck />
              </ItemMedia>
              <ItemContent>
                <ItemTitle id="enforce-auto-review-title">
                  要求所有人开启自动审查
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-labelledby="enforce-auto-review-title"
                  checked={settings.enforceAutoReview}
                  disabled={team.isPending}
                  onCheckedChange={(enforceAutoReview) =>
                    team.mutate({ enforceAutoReview })
                  }
                />
              </ItemActions>
            </Item>
            <Separator />
            <Item render={<Link to="/admin/approvals/guidance" />} size="sm">
              <ItemMedia variant="icon">
                <IconNotes />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>自动审查的指引</ItemTitle>
                <ItemDescription>
                  {guidance.isPending
                    ? null
                    : guidance.error
                      ? "读不到指引。"
                      : (guidance.data ??
                        "还没有。告诉审查哪些事在你的组织里需要人来拍板。")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconUserCog />
              </ItemMedia>
              <ItemContent>
                <ItemTitle id="custom-rules-title">
                  允许成员设置个人规则
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-labelledby="custom-rules-title"
                  checked={settings.customRulesEnabled}
                  disabled={team.isPending}
                  onCheckedChange={(customRulesEnabled) =>
                    team.mutate({ customRulesEnabled })
                  }
                />
              </ItemActions>
            </Item>
            <Separator />
            {/* fork 的团队开关（SEC1 D10），服务端仍收 `enforceDangerousCommands`；上游这页没有它。 */}
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconShieldExclamation />
              </ItemMedia>
              <ItemContent>
                <ItemTitle id="enforce-dangerous-commands-title">
                  强制危险命令审批
                </ItemTitle>
                <ItemDescription>
                  所有员工运行危险命令前都要先问，员工自己的开关关不掉。
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-labelledby="enforce-dangerous-commands-title"
                  checked={settings.enforceDangerousCommands === true}
                  disabled={team.isPending}
                  onCheckedChange={(enforceDangerousCommands) =>
                    team.mutate({ enforceDangerousCommands })
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
                <ItemTitle>成员电脑上执行命令的上限</ItemTitle>
                <ItemDescription>成员自己更严格的设置仍然生效。</ItemDescription>
              </ItemContent>
              <ItemActions>
                <LabelSelect
                  disabled={team.isPending}
                  label="成员电脑上执行命令的上限"
                  labels={HOST_LABELS}
                  onChange={(hostCommandsCap) =>
                    team.mutate({ hostCommandsCap })
                  }
                  value={settings.hostCommandsCap}
                />
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}
      {settings ? (
        <PageSection
          description="员工做这些事之前都会先问。删除、对外发送、分享、公开发布只能「允许一次」或拒绝，没有「在这段对话里都允许」和「总是允许」；付款、改安全设置、改密码和登录信息总是交给成员本人。这里只能改得更严。"
          title="总要先问的操作"
        >
          <PageRows>
            {ACTION_KIND_ROWS.map(({ kind, title, icon: Icon, handedOff }, index) => (
              <Fragment key={kind}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <Icon />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{title}</ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    {handedOff ? (
                      <span className="text-muted-foreground text-sm">
                        总是交给成员本人
                      </span>
                    ) : (
                      <LabelSelect
                        disabled={team.isPending}
                        label={title}
                        labels={ACTION_KIND_LABELS}
                        onChange={(policy) =>
                          team.mutate({ actionKinds: { [kind]: policy } })
                        }
                        value={settings.actionKinds?.[kind] ?? "open"}
                      />
                    )}
                  </ItemActions>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
      <PageSection
        description="这些规则对每位成员的员工都生效，成员改不了。"
        title="团队规则"
      >
        {teamRules.length === 0 ? (
          <PageEmpty icon={IconChecklist} title="还没有团队规则" />
        ) : null}
        <PageRows>
          {teamRules.map((rule) => (
            <Fragment key={rule.id}>
              <RuleRow
                disabled={revokeTeam.isPending || changeTeamRule.isPending}
                onChange={(behaviour) =>
                  changeTeamRule.mutate({ id: rule.id, behaviour })
                }
                onRevoke={() => revokeTeam.mutate(rule.id)}
                rule={rule}
                team
              />
              <Separator />
            </Fragment>
          ))}
          <Item render={<Link to="/admin/approvals/describe" />} size="sm">
            <ItemMedia variant="icon">
              <IconSparkles />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>用一句话描述</ItemTitle>
              <ItemDescription>
                说出员工该怎么做，由你的模型写成规则。
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
          <Separator />
          <RuleForm label="添加团队规则" save={addTeamRule} />
        </PageRows>
      </PageSection>
      {/*
       * M5b 第二阶段：上游这里接着画 `SharedUseRequests`（./shared-use-requests，共享账号的使用申请），
       * fork 还没有这个组件，接管理页时一并补上。
       */}
    </>
  );
}
