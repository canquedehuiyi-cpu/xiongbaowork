import type { LearningPersonalReview } from "@openbot/shared/learning";
import {
  IconCheck,
  IconChevronRight,
  IconShare,
  IconSparkles,
  IconUserCheck,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { LearnedSkillDialog } from "@/components/learning/learned-skill-dialog";
import { ProposalDialog } from "@/components/learning/proposal-dialog";
import { skillTitle } from "@/lib/learning/display";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  decideSharingMutationOptions,
  reviewPersonProposalMutationOptions,
  savePersonalReviewMutationOptions,
} from "@/lib/learning/mutations";
import {
  learnedSkillQueryOptions,
  learningSettingsQueryOptions,
  peopleProposalsQueryOptions,
  personProposalQueryOptions,
  sharingRequestsQueryOptions,
} from "@/lib/learning/queries";
import { queryClient } from "@/query-client";

const CHOICES: {
  value: LearningPersonalReview;
  title: string;
  description: string;
}[] = [
  {
    value: "admins",
    title: "管理员",
    description:
      "从某人的录制里学到的技能，要等管理员审核。",
  },
  {
    value: "people",
    title: "每个人自己审核，只用于自己的员工",
    description:
      "每个人自己审核从自己的录制里学到的技能。在管理员共享之前，这些技能只给这个人的员工用。",
  },
];

/** What a section says when the settings it depends on did not load. */
function SettingsError({ message }: { message?: string }) {
  return (
    <p className="mt-4 text-destructive text-sm" role="alert">
      {message ?? "读不到学习设置。请刷新页面。"}
    </p>
  );
}

const LABEL = "谁来审核从个人录制里学到的技能";

/** Admin, Automatic learning: who approves the skills learned from a person's own recordings. */
export function WhoApprovesSection() {
  const [open, setOpen] = useState(false);
  const settings = useQuery(learningSettingsQueryOptions());
  if (settings.isPending) return null;
  if (settings.error || !settings.data)
    return (
      <PageSection title="审核">
        <SettingsError message={settings.error?.message} />
      </PageSection>
    );
  const current = settings.data.personalReview ?? "admins";
  return (
    <PageSection title="审核">
      <PageRows>
        <Item
          render={<button onClick={() => setOpen(true)} type="button" />}
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconUserCheck />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{LABEL}</ItemTitle>
            <ItemDescription>
              {CHOICES.find((choice) => choice.value === current)?.title}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
      {open ? (
        <WhoApprovesDialog current={current} onClose={() => setOpen(false)} />
      ) : null}
    </PageSection>
  );
}

function WhoApprovesDialog({
  current,
  onClose,
}: {
  current: LearningPersonalReview;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(current);
  const save = useMutation(savePersonalReviewMutationOptions(queryClient));
  return (
    <Dialog
      // Closing mid-save would unmount the dialog and lose whether it worked.
      onOpenChange={(open) => !open && !save.isPending && onClose()}
      open
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{LABEL}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          <PageRows>
            {CHOICES.map((choice, index) => (
              <Fragment key={choice.value}>
                {index > 0 ? <Separator /> : null}
                <Item
                  render={
                    <button
                      aria-pressed={draft === choice.value}
                      onClick={() => setDraft(choice.value)}
                      type="button"
                    />
                  }
                  size="sm"
                  variant="muted"
                >
                  <ItemContent>
                    <ItemTitle>{choice.title}</ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {choice.description}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {draft === choice.value ? (
                      <IconCheck
                        aria-hidden="true"
                        className="size-4 text-foreground"
                      />
                    ) : null}
                  </ItemActions>
                </Item>
              </Fragment>
            ))}
          </PageRows>
          {save.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {save.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            disabled={save.isPending}
            onClick={onClose}
            size="sm"
            variant="outline"
          >
 取消
 </Button>
          <Button
            disabled={save.isPending}
            onClick={() => save.mutate(draft, { onSuccess: onClose })}
            size="sm"
          >
            {save.isPending ? "正在保存…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Admin, Automatic learning: the skills proposed from each person's own recordings, while admins
 * are the ones who approve them. Hidden once each person approves their own.
 */
export function PeopleProposalsSection() {
  const settings = useQuery(learningSettingsQueryOptions());
  const admins = (settings.data?.personalReview ?? "admins") === "admins";
  const people = useQuery({
    ...peopleProposalsQueryOptions(),
    enabled: admins && !settings.isPending && !settings.error,
  });
  const review = useMutation(reviewPersonProposalMutationOptions(queryClient));
  const [open, setOpen] = useState<{
    userId: string;
    proposalId: string;
  } | null>(null);
  if (settings.isPending) return null;
  if (settings.error)
    return (
      <PageSection title="来自个人录制">
        <SettingsError message={settings.error.message} />
      </PageSection>
    );
  if (!admins) return null;
  const rows = (people.data?.people ?? []).flatMap((person) =>
    (person.proposals ?? [])
      .filter((proposal) => proposal.status === "pending_review")
      .map((proposal) => ({ person, proposal })),
  );
  const unreadable = (people.data?.people ?? []).filter(
    (person) => person.proposals === null,
  );
  return (
    <PageSection
      title="来自个人录制"
      description="批准一项技能，就会把它发布给教会它的那个人的员工。"
    >
      {people.isPending ? null : people.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {people.error.message}
        </p>
      ) : (
        <>
          {unreadable.map((person) => (
            <p
              className="mt-4 text-destructive text-sm"
              key={person.userId}
              role="alert"
            >
              {`读不到${person.name}的技能。请刷新页面再试。`}
            </p>
          ))}
          {rows.length === 0 ? (
            unreadable.length > 0 ? null : (
              <PageEmpty icon={IconSparkles} title="没有待审核的内容">
                从个人录制里学到的技能准备好后，会出现在这里。
              </PageEmpty>
            )
          ) : (
            <PageRows>
              {rows.map(({ person, proposal }, index) => (
                <Fragment key={`${person.userId}:${proposal.id}`}>
                  {index > 0 ? <Separator /> : null}
                  <Item
                    render={
                      <button
                        onClick={() =>
                          setOpen({
                            userId: person.userId,
                            proposalId: proposal.id,
                          })
                        }
                        type="button"
                      />
                    }
                    size="sm"
                  >
                    <ItemMedia variant="icon">
                      <IconSparkles />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        {skillTitle(proposal.title, proposal.description)}
                      </ItemTitle>
                      <ItemDescription>{person.name}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <IconChevronRight className="size-4 text-muted-foreground" />
                    </ItemActions>
                  </Item>
                </Fragment>
              ))}
            </PageRows>
          )}
        </>
      )}
      {open ? (
        <ProposalDialog
          decided={review.data?.status}
          deciding={review.isPending}
          error={review.error}
          load={personProposalQueryOptions(open.userId, open.proposalId)}
          onClose={() => {
            setOpen(null);
            review.reset();
          }}
          onDecide={(decision) => review.mutate({ ...open, decision })}
          publishedNote="已发布。对方的员工从下一段对话起就会用它。"
        />
      ) : null}
    </PageSection>
  );
}

/**
 * Admin, Automatic learning: people's requests to open a skill they learned to every Bot. Shown
 * while each person approves their own skills, and whenever a request is waiting.
 */
export function SharingRequestsSection() {
  const settings = useQuery(learningSettingsQueryOptions());
  const requests = useQuery(sharingRequestsQueryOptions());
  const decide = useMutation(decideSharingMutationOptions(queryClient));
  const [open, setOpen] = useState<{
    userId: string;
    skillName: string;
    requestedAt: string;
  } | null>(null);
  const skill = useQuery({
    ...learnedSkillQueryOptions(
      { kind: "person", userId: open?.userId ?? "" },
      open?.skillName ?? "",
    ),
    enabled: open !== null,
  });
  const rows = requests.data ?? [];
  const people = settings.data?.personalReview === "people";
  if (settings.isPending) return null;
  if (!people && rows.length === 0 && !requests.error && !settings.error)
    return null;
  // After a refused decision the list is read again; its stamp, not the one from opening, is current.
  const requestedAt =
    rows.find(
      (request) =>
        request.userId === open?.userId &&
        request.skillName === open?.skillName,
    )?.requestedAt ?? open?.requestedAt;
  // Deciding means having seen the skill, and on the version the request is about.
  const cannotDecide =
    decide.isPending || !skill.data || requests.isFetching || !requestedAt;
  const close = () => {
    setOpen(null);
    decide.reset();
  };
  return (
    <PageSection
      title="共享申请"
      description="批准申请，这项技能就会向所有员工公开。"
    >
      {settings.error ? (
        <SettingsError message={settings.error.message} />
      ) : null}
      {requests.isPending ? null : requests.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {requests.error.message}
        </p>
      ) : rows.length === 0 ? (
        <PageEmpty icon={IconShare} title="没有共享申请">
          有人申请共享技能时，申请会出现在这里。
        </PageEmpty>
      ) : (
        <PageRows>
          {rows.map((request, index) => (
            <Fragment key={`${request.userId}:${request.skillName}`}>
              {index > 0 ? <Separator /> : null}
              <Item
                render={
                  <button
                    onClick={() =>
                      setOpen({
                        userId: request.userId,
                        skillName: request.skillName,
                        requestedAt: request.requestedAt,
                      })
                    }
                    type="button"
                  />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconShare />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{skillTitle(request.skillName)}</ItemTitle>
                  <ItemDescription>{request.name}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
      <LearnedSkillDialog
        footer={
          open ? (
            <>
              {decide.error ? (
                <p className="mr-auto text-destructive text-sm" role="alert">
                  {decide.error.message}
                </p>
              ) : null}
              <Button
                disabled={cannotDecide}
                onClick={() =>
                  decide.mutate(
                    {
                      ...open,
                      requestedAt: requestedAt ?? open.requestedAt,
                      decision: "decline",
                    },
                    { onSuccess: close },
                  )
                }
                size="sm"
                variant="outline"
              >
 拒绝
 </Button>
              <Button
                disabled={cannotDecide}
                onClick={() =>
                  decide.mutate(
                    {
                      ...open,
                      requestedAt: requestedAt ?? open.requestedAt,
                      decision: "approve",
                    },
                    { onSuccess: close },
                  )
                }
                size="sm"
              >
                {decide.isPending ? "正在保存…" : "批准共享"}
              </Button>
            </>
          ) : undefined
        }
        name={open?.skillName ?? null}
        title={open ? skillTitle(open.skillName) : undefined}
        onClose={close}
        source={{ kind: "person", userId: open?.userId ?? "" }}
      />
    </PageSection>
  );
}
