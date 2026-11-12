import {
  IconBuilding,
  IconChecklist,
  IconDeviceDesktop,
  IconFolder,
  IconKey,
  IconMessage,
  IconPlug,
  IconRobot,
  IconTrash,
  IconUser,
  IconUserShield,
  IconUsersGroup,
} from "@tabler/icons-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Fragment } from "react";
import type { AuditEvent } from "@/components/audit/audit-cells";
import {
  type ReplayRow,
  ReplayRows,
} from "@/components/boundaries/dry-run-changes";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { shortName } from "@/lib/brand";
import type {
  CapabilityAnswer,
  CapabilityPreview,
  PreviewCapability,
  PreviewPerson,
} from "@/lib/capability-changes/queries";
import type {
  CapabilityChange,
  CapabilityChangeProblem,
} from "@/lib/capability-changes/translate";
import { cn } from "@/lib/utils";

/** Who a switch is for, as the Permissions page and its overrides name them. */
function scopeWords(change: CapabilityChange): string {
  if (change.scopeKind === "organization") return "所有人";
  if (change.scopeKind === "role")
    return change.scopeId === "admin" ? "管理员" : "成员";
  return `用户组：${change.scopeId}`;
}

const SCOPE_ICONS = {
  organization: IconBuilding,
  role: IconUserShield,
  group: IconUsersGroup,
};

/** What a switch is set to, in the overrides dialog's words: a group grants, the rest turn on or off. */
function settingWords(change: CapabilityChange): {
  text: string;
  className: string;
} {
  if (change.allowed === null)
    return { text: "改回继承", className: "text-muted-foreground" };
  if (!change.allowed) return { text: "关闭", className: "text-destructive" };
  return {
    text: change.scopeKind === "group" ? "授予" : "打开",
    className: "text-emerald-600 dark:text-emerald-400",
  };
}

/**
 * The switches the model wrote, one row each, in the Permissions page's own words. Any can be removed
 * before saving; what is wrong with one, as the server checks them as they stand, is said under it.
 */
export function ChangeRows({
  changes,
  titles,
  problems,
  onRemove,
}: {
  changes: CapabilityChange[];
  /** Each permission's title, from the Permissions page's own list. */
  titles: Partial<Record<string, string>>;
  problems: CapabilityChangeProblem[];
  onRemove: (index: number) => void;
}) {
  return (
    <Field>
      <FieldLabel>改动</FieldLabel>
      <FieldDescription>
        每条改动设置一个开关。保存前可以删掉不想要的。
      </FieldDescription>
      <PageRows>
        {changes.map((change, index) => {
          const row = index + 1;
          const Icon = SCOPE_ICONS[change.scopeKind];
          const setting = settingWords(change);
          const title = titles[change.capability] ?? change.capability;
          const wrong = problems.filter((problem) => problem.change === row);
          return (
            // Index-keyed: a change has no identity apart from its place until it is saved.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <Fragment key={index}>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <Icon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{title}</ItemTitle>
                  <ItemDescription>{scopeWords(change)}</ItemDescription>
                  {wrong.map((problem) => (
                    <p className="text-destructive text-sm" key={problem.field}>
                      {problem.message}
                    </p>
                  ))}
                </ItemContent>
                <ItemActions>
                  <span
                    className={cn("font-medium text-sm", setting.className)}
                  >
                    {setting.text}
                  </span>
                  <Button
                    aria-label={`删掉改动 ${row}`}
                    onClick={() => onRemove(index)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <IconTrash />
                  </Button>
                </ItemActions>
              </Item>
              {index !== changes.length - 1 && <Separator />}
            </Fragment>
          );
        })}
      </PageRows>
    </Field>
  );
}

/** Why a person has a permission or not, after "Now" or "After this,". */
function answerWords(answer: CapabilityAnswer): string {
  const state = answer.allowed ? "打开" : "关闭";
  switch (answer.decidedBy) {
    case "default":
      return `默认${state}`;
    case "organization":
      return `对所有人${state}`;
    case "role":
      return `对${answer.scopeId === "admin" ? "管理员" : "成员"}${state}`;
    case "group":
      return `通过 ${answer.scopeId} 打开`;
  }
}

const loses = (capability: PreviewCapability) =>
  capability.before.allowed && !capability.after.allowed;
const gains = (capability: PreviewCapability) =>
  !capability.before.allowed && capability.after.allowed;

function verdictOf(person: PreviewPerson): { text: string; className: string } {
  if (person.capabilities.some(loses))
    return { text: "失去权限", className: "text-destructive" };
  if (person.capabilities.some(gains))
    return {
      text: "获得权限",
      className: "text-emerald-600 dark:text-emerald-400",
    };
  return { text: "保留权限", className: "text-muted-foreground" };
}

/** The preview in one sentence: "3 people lose access and 4 people keep it through a different switch." */
export function previewHeadline(counts: CapabilityPreview["counts"]): string {
  const parts = [
    counts.losing > 0 ? `${counts.losing} 人失去权限` : null,
    counts.gaining > 0 ? `${counts.gaining} 人获得权限` : null,
    counts.keeping > 0 ? `${counts.keeping} 人通过另一个开关保留权限` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return "没有人的权限会变。";
  return `${parts.join("，")}。`;
}

/** What a person's recent use of a permission they lose comes to, in one line. */
function activityWords(
  capability: PreviewCapability,
  unmapped: ReadonlySet<string>,
  days: number,
): string | null {
  if (!loses(capability)) return null;
  if (unmapped.has(capability.capability))
    return `${shortName()}不记录它的使用情况。`;
  const activity = capability.activity;
  if (!activity) return null;
  if (activity.count === 0) return `最近 ${days} 天没用过。`;
  return `最近 ${days} 天 ${activity.count}${activity.more ? " 次以上" : " 次"}：${activity.what}。`;
}

/** Where a past action acted, for the mark beside it. */
function mediaOf(event: AuditEvent): ReplayRow["media"] {
  if (event.targetType === "host_access")
    return { icon: <IconFolder />, label: "他们自己电脑上的文件夹" };
  if (event.eventType.startsWith("computer."))
    return { icon: <IconDeviceDesktop />, label: "电脑操作" };
  if (event.eventType.startsWith("password."))
    return { icon: <IconKey />, label: "登录" };
  if (event.eventType.startsWith("delivery."))
    return { icon: <IconMessage />, label: "聊天应用" };
  if (event.eventType.startsWith("bot."))
    return { icon: <IconRobot />, label: "员工" };
  if (event.eventType.startsWith("approval."))
    return { icon: <IconChecklist />, label: "审批规则" };
  return { icon: <IconPlug />, label: "应用调用" };
}

/**
 * Who the changes would change, worked out on the server by the rule OpenBot enforces: the headline,
 * then each person with their permissions now and after, then the recent use of what they would lose,
 * in Audit's own cells, as a boundary's preview lists what it would stop.
 */
export function PermissionsPreview({
  preview,
}: {
  preview: UseQueryResult<CapabilityPreview>;
}) {
  if (preview.isPending) return null;
  if (preview.error)
    return (
      <Field>
        <FieldLabel>会影响谁</FieldLabel>
        <p className="text-destructive text-sm" role="alert">
          {preview.error.message}
        </p>
      </Field>
    );
  const data = preview.data;
  // Changes that don't check say so on their rows; there is nothing to preview.
  if (!data.check.ok) return null;
  const unmapped = new Set(
    data.activity.unmapped.map((entry) => entry.capability),
  );
  const nameOf = (person: PreviewPerson) => person.name ?? person.email;
  const used: ReplayRow[] = data.people.flatMap((person) =>
    person.capabilities.flatMap((capability) =>
      loses(capability)
        ? (capability.activity?.recent ?? []).map((event) => ({
            id: `${person.id}:${event.id}`,
            event,
            media: mediaOf(event),
            verdict: "会被拦下",
            note: `${nameOf(person)}，${capability.title}`,
          }))
        : [],
    ),
  );
  const usedTotal = data.people.reduce(
    (sum, person) =>
      sum +
      person.capabilities.reduce(
        (inner, capability) =>
          inner + (loses(capability) ? (capability.activity?.count ?? 0) : 0),
        0,
      ),
    0,
  );
  const listed = data.counts.losing + data.counts.gaining + data.counts.keeping;

  return (
    <>
      <Field aria-labelledby="permissions-preview" aria-live="polite">
        <FieldLabel id="permissions-preview">会影响谁</FieldLabel>
        <div>
          <p className="font-medium text-sm">{previewHeadline(data.counts)}</p>
          <FieldDescription className="mt-1">
            按{shortName()}实际执行的规则，为全部 {data.counts.people}{" "}
            个人逐一算过。
            {data.counts.unchanged > 0
              ? `其中 ${data.counts.unchanged} 人不受影响。`
              : ""}
          </FieldDescription>
        </div>
        {data.warning ? (
          <p className="text-amber-600 text-sm dark:text-amber-500">
            {data.warning}
          </p>
        ) : null}
        {data.people.length > 0 ? (
          <PageRows>
            {data.people.map((person, index) => {
              const verdict = verdictOf(person);
              return (
                <Fragment key={person.id}>
                  <Item size="sm">
                    <ItemMedia
                      className="translate-y-0.5 self-start"
                      variant="icon"
                    >
                      <IconUser />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle>{nameOf(person)}</ItemTitle>
                      <ItemDescription className="line-clamp-none">
                        {person.role === "admin" ? "管理员" : "成员"}
                        {person.groups.length > 0
                          ? `，属于 ${person.groups.join("、")}`
                          : "，不属于任何用户组"}
                      </ItemDescription>
                      {person.capabilities
                        .filter(
                          (capability) =>
                            capability.before.allowed !==
                              capability.after.allowed ||
                            capability.before.decidedBy !==
                              capability.after.decidedBy ||
                            capability.before.scopeId !==
                              capability.after.scopeId,
                        )
                        .map((capability) => {
                          const activity = activityWords(
                            capability,
                            unmapped,
                            data.activity.days,
                          );
                          return (
                            <div
                              className="mt-1.5 text-sm"
                              key={capability.capability}
                            >
                              <p>
                                <span className="font-medium">
                                  {capability.title}。
                                </span>
                                现在{answerWords(capability.before)}，改动后
                                {answerWords(capability.after)}。
                              </p>
                              {activity ? (
                                <p className="text-muted-foreground text-xs">
                                  {activity}
                                </p>
                              ) : null}
                            </div>
                          );
                        })}
                    </ItemContent>
                    <ItemActions className="self-start">
                      <span
                        className={cn("font-medium text-sm", verdict.className)}
                      >
                        {verdict.text}
                      </span>
                    </ItemActions>
                  </Item>
                  {index !== data.people.length - 1 && <Separator />}
                </Fragment>
              );
            })}
          </PageRows>
        ) : null}
        {listed > data.people.length ? (
          <p className="text-muted-foreground text-xs">
            共 {listed} 人，只显示前 {data.people.length} 人。
          </p>
        ) : null}
        {data.activity.unmapped.length > 0 ? (
          <FieldDescription>
            {shortName()}不记录
            {data.activity.unmapped.map((entry) => entry.title).join("、")}
            的使用情况，所以这里不显示它最近的使用。
          </FieldDescription>
        ) : null}
      </Field>
      {used.length > 0 ? (
        <Field aria-labelledby="permissions-used">
          <FieldLabel id="permissions-used">
            最近 {data.activity.days} 天用过的
          </FieldLabel>
          <FieldDescription>
            从审计里取出的、大家最近用将要失去的权限做过的动作。
          </FieldDescription>
          <ReplayRows rows={used} total={usedTotal} />
        </Field>
      ) : null}
    </>
  );
}
