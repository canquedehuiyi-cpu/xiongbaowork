import type {
  LearningSharingMode,
  PersonalLearningSharing,
} from "@openbot/shared/learning";
import {
  IconCheck,
  IconChevronRight,
  IconListCheck,
  IconLock,
  IconSparkles,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { LearnedSkillDialog } from "@/components/learning/learned-skill-dialog";
import { Button } from "@/components/ui/button";
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
import { shortName } from "@/lib/brand";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { skillTitle } from "@/lib/learning/display";
import {
  requestSkillSharingMutationOptions,
  setLearnedSkillOpenMutationOptions,
  setLearningSharingModeMutationOptions,
} from "@/lib/learning/mutations";
import { personalLearningQueryOptions } from "@/lib/learning/queries";
import { queryClient } from "@/query-client";

/** The three choices, each with the one plain line that says who sees what. */
export const SHARING_CHOICES: {
  mode: LearningSharingMode;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}[] = [
  {
    mode: "closed",
    icon: IconLock,
    title: "只给我的员工",
    description: "只有你用的员工会用到你的技能。",
  },
  {
    mode: "open",
    icon: IconUsersGroup,
    title: "所有人的员工",
    description: `${shortName()}上的每位员工都会用到你的全部技能。`,
  },
  {
    mode: "choose",
    icon: IconListCheck,
    title: "我挑选的技能",
    description:
      "每位员工都会用到你在下面公开的技能；你自己的员工会用到全部技能。",
  },
];

/**
 * What the choice says above its rows. While an administrator has not turned on Skill sharing, plainly that, and, when
 * the person chose to share before it was turned off, that their choice is kept for when it is on again.
 */
function choiceSentence(data: PersonalLearningSharing): string {
  if (data.sharingAllowed)
    return "你自己的员工总会用到从你的录制里学到的每一项技能。";
  const off =
    "管理员还没开启向所有员工共享技能，所以只有你用的员工会用到你的技能。";
  return data.mode === "closed"
    ? off
    : `${off}管理员开启后，你在下面的选择会重新生效。`;
}

/** What the Skills list says when it has none to show. */
function emptySentence(
  data: PersonalLearningSharing,
  mode: LearningSharingMode,
  personal: boolean,
): string {
  if (personal) {
    return data.skills === null
      ? "刚才没能从后端读到你的技能。请刷新页面再试。"
      : "还没有从你的录制和对话里学到技能。学到之后会显示在这里。";
  }
  if (data.unavailable === "off")
    return "管理员关闭了自动学习，所以不会从你的录制里学习技能。";
  if (data.skills === null)
    return "刚才没能从后端读到你的技能。你在上面的选择对它们仍然有效。";
  return mode === "choose"
    ? "还没有从你的录制里学到技能。学到之后，你在这里公开的每一项都会提供给所有员工。"
    : "还没有从你的录制里学到技能。学到之后会显示在这里。";
}

/** What the Your Skills section says about who draws on them, in the mode chosen. */
const SKILLS_DESCRIPTION: Record<LearningSharingMode, string> = {
  closed: "只有你用的员工会用到这些技能。",
  open: `${shortName()}上的每位员工都会用到这些技能。`,
  choose: `公开一项技能，${shortName()}上的每位员工就都能用它。`,
};

/**
 * Settings, Learning: every recording a person makes goes into their own Learning space, and the Skills learned there
 * reach every Bot they use. Here they choose who else's Bots may draw on them: none (the default), all, or the Skills
 * they open one by one. Each change takes effect when it is made; there is no save. Sharing waits for an administrator
 * (Admin, Automatic learning, Skill sharing): until then nothing can be opened, and what was opened can still be closed.
 */
export function LearningSharing() {
  const sharing = useQuery(personalLearningQueryOptions());
  const setMode = useMutation(
    setLearningSharingModeMutationOptions(queryClient),
  );
  const setOpen = useMutation(setLearnedSkillOpenMutationOptions(queryClient));
  const requestShare = useMutation(
    requestSkillSharingMutationOptions(queryClient),
  );
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const [reading, setReading] = React.useState<string | null>(null);
  // Which edition decides the layout, so nothing draws until it is known. A failed read counts as the team edition.
  if (sharing.isPending || capabilities.isPending) return null;
  const personal = capabilities.data?.edition === "personal";
  if (sharing.error) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        {sharing.error.message}
      </p>
    );
  }
  const data = sharing.data;
  // Shown at once while the save is on its way, as a switch is.
  const mode = (setMode.isPending ? setMode.variables : undefined) ?? data.mode;
  const failure = setMode.error ?? setOpen.error ?? requestShare.error;
  // The dialog shows the title its row did.
  const readingSkill = data.skills?.find((skill) => skill.name === reading);
  const readingTitle = readingSkill
    ? skillTitle(readingSkill.name, readingSkill.description)
    : undefined;

  if (personal) {
    // One person, one computer: nobody to share with, so every row simply opens its Skill.
    const none = data.skills === null || data.skills.length === 0;
    return (
      <PageSection
        title="你的技能"
        // Said only over skills to open: above the empty state it would point at nothing.
        description={none ? undefined : "打开一项技能，看看它做什么。"}
      >
        {data.skills === null || data.skills.length === 0 ? (
          <PageEmpty>{emptySentence(data, mode, true)}</PageEmpty>
        ) : (
          <PageRows>
            {data.skills.map((skill, index) => (
              <React.Fragment key={skill.name}>
                {index > 0 ? <Separator /> : null}
                <Item
                  size="sm"
                  render={
                    <button
                      onClick={() => setReading(skill.name)}
                      type="button"
                    />
                  }
                >
                  <ItemMedia variant="icon">
                    <IconSparkles />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      {skillTitle(skill.name, skill.description)}
                    </ItemTitle>
                    <ItemDescription>{skill.description}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </React.Fragment>
            ))}
          </PageRows>
        )}
        <LearnedSkillDialog
          name={reading}
          title={readingTitle}
          onClose={() => setReading(null)}
          source={{ kind: "personal" }}
        />
      </PageSection>
    );
  }

  return (
    <>
      <PageSection
        title="还有谁的员工能用你的技能"
        description={choiceSentence(data)}
      >
        <PageRows>
          {/* One pressed button of three, as Admin, Boundaries draws its enforcement choice. */}
          {SHARING_CHOICES.map((choice, index) => (
            <React.Fragment key={choice.mode}>
              {index > 0 ? <Separator /> : null}
              <Item
                size="sm"
                render={
                  <button
                    aria-pressed={mode === choice.mode}
                    disabled={
                      setMode.isPending ||
                      (!data.sharingAllowed && choice.mode !== "closed")
                    }
                    onClick={() => {
                      if (mode !== choice.mode) setMode.mutate(choice.mode);
                    }}
                    type="button"
                  />
                }
              >
                <ItemMedia variant="icon">
                  <choice.icon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{choice.title}</ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    {choice.description}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {mode === choice.mode ? (
                    <IconCheck
                      aria-hidden="true"
                      className="size-4 text-foreground"
                    />
                  ) : null}
                </ItemActions>
              </Item>
            </React.Fragment>
          ))}
        </PageRows>
      </PageSection>
      <PageSection
        title="你的技能"
        description={SKILLS_DESCRIPTION[data.sharingAllowed ? mode : "closed"]}
      >
        {data.skills === null || data.skills.length === 0 ? (
          <PageEmpty>{emptySentence(data, mode, false)}</PageEmpty>
        ) : (
          <PageRows>
            {data.skills.map((skill, index) => {
              const open =
                (setOpen.isPending && setOpen.variables?.name === skill.name
                  ? setOpen.variables.open
                  : undefined) ?? skill.open;
              // A skill the person approved reaches other Bots only once an admin approves sharing it.
              const needsAdmin =
                mode !== "closed" &&
                skill.approvedBy === "person" &&
                skill.sharing !== "approved";
              return (
                <React.Fragment key={skill.name}>
                  {index > 0 ? <Separator /> : null}
                  {mode === "choose" || needsAdmin ? (
                    // The row opens the Skill; the Switch sits beside that button, not inside it.
                    <Item size="sm">
                      <button
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => setReading(skill.name)}
                        type="button"
                      >
                        <ItemMedia variant="icon">
                          <IconSparkles />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle>
                            {skillTitle(skill.name, skill.description)}
                          </ItemTitle>
                          <ItemDescription>
                            {[
                              needsAdmin ||
                              (mode === "choose" &&
                                !(open && data.sharingAllowed))
                                ? "只有你的员工会用它。"
                                : mode === "choose"
                                  ? "所有员工都可以用它。"
                                  : null,
                              skill.description,
                            ]
                              .filter(Boolean)
                              .join(" ")}
                          </ItemDescription>
                        </ItemContent>
                      </button>
                      <ItemActions>
                        {mode === "choose" ? (
                          <>
                            {needsAdmin && skill.sharing === "requested" ? (
                              <span className="text-muted-foreground text-sm">
                                已申请共享
                              </span>
                            ) : null}
                            <Switch
                              aria-label={`向所有人公开「${skillTitle(skill.name, skill.description)}」`}
                              checked={open}
                              // An open Skill can always be closed; opening one waits for an admin.
                              disabled={
                                setOpen.isPending ||
                                requestShare.isPending ||
                                (!data.sharingAllowed && !open)
                              }
                              onCheckedChange={(checked) => {
                                if (
                                  checked &&
                                  needsAdmin &&
                                  skill.sharing !== "requested"
                                ) {
                                  // Switching on a skill an admin has yet to approve also asks for that approval.
                                  setOpen
                                    .mutateAsync({
                                      name: skill.name,
                                      open: true,
                                    })
                                    .then(() => requestShare.mutate(skill.name))
                                    .catch(() => {});
                                  return;
                                }
                                setOpen.mutate({
                                  name: skill.name,
                                  open: checked,
                                });
                              }}
                            />
                          </>
                        ) : skill.sharing === "requested" ? (
                          <span className="text-muted-foreground text-sm">
                            已申请共享
                          </span>
                        ) : (
                          <Button
                            disabled={requestShare.isPending}
                            onClick={() => requestShare.mutate(skill.name)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            申请共享
                          </Button>
                        )}
                      </ItemActions>
                    </Item>
                  ) : (
                    // No switch here, so the whole row opens the Skill.
                    <Item
                      size="sm"
                      render={
                        <button
                          onClick={() => setReading(skill.name)}
                          type="button"
                        />
                      }
                    >
                      <ItemMedia variant="icon">
                        <IconSparkles />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          {skillTitle(skill.name, skill.description)}
                        </ItemTitle>
                        <ItemDescription>{skill.description}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <IconChevronRight className="size-4 text-muted-foreground" />
                      </ItemActions>
                    </Item>
                  )}
                </React.Fragment>
              );
            })}
          </PageRows>
        )}
        <LearnedSkillDialog
          name={reading}
          title={readingTitle}
          onClose={() => setReading(null)}
          source={{ kind: "personal" }}
        />
      </PageSection>
      {failure ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : null}
    </>
  );
}
