import {
  IconChevronRight,
  IconCopy,
  IconEyeOff,
  IconPin,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
  deleteAgentMutationOptions,
  duplicateAgentMutationOptions,
  setAgentHiddenMutationOptions,
  setAgentPinnedMutationOptions,
} from "@/lib/agents/mutations";
import type { AgentProfile } from "@/lib/agents/queries";
import { resetBotMutationOptions } from "@/lib/bot-lifecycle/mutations";
import {
  botResetPlanQueryOptions,
  type ResetPlan,
} from "@/lib/bot-lifecycle/queries";
import {
  deploymentCapabilitiesQueryOptions,
  useOffersMemory,
} from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";

/**
 * Whether this is the personal edition, where one person uses OpenBot. Nobody else has a Bots list
 * or a conversation with a Bot there, so the rows below say nothing about other people.
 */
function usePersonal(): boolean {
  return (
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal"
  );
}

/** Each count the notice lists, in the words the person reads, skipping the kinds with nothing. */
function resetLines(plan: ResetPlan): string[] {
  const lines: [number, string][] = [
    [plan.conversations, "段对话"],
    [plan.memorySources, "个记忆来源"],
    [plan.memories, "条导入的记忆"],
    [plan.routines, "个定时任务"],
    [plan.responsibilities, "个长期职责"],
    [plan.followUps, "个已排期的跟进"],
    [plan.formedMemories, "条它自己形成的记忆"],
    [plan.backgroundResearch, "项后台研究"],
    [plan.standingApprovals, "项长期许可"],
  ];
  return lines
    .filter(([count]) => count > 0)
    .map(([count, noun]) => `${count} ${noun}`);
}

/** Also opened from 对你 on the employee's own page (`BotControls`), as v0.2.7 had it there. */
export function ResetDialog({
  agent,
  onOpenChange,
  open,
}: {
  agent: AgentProfile;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const plan = useQuery({
    ...botResetPlanQueryOptions(agent.id),
    enabled: open,
  });
  const reset = useMutation(resetBotMutationOptions(queryClient));
  const memory = useOffersMemory();
  const personal = usePersonal();
  const lines = plan.data ? resetLines(plan.data) : [];
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重置 {agent.name}？</DialogTitle>
          <DialogDescription>
            {personal
              ? `这会删除 ${agent.name} 与你之间的东西。删除后无法撤销。`
              : `这会删除 ${agent.name} 与你之间的东西，只限于你。别人的对话和数据不会被碰。删除后无法撤销。`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {plan.isPending ? null : plan.error ? (
            <p className="text-destructive text-sm" role="alert">
              算不出重置会删除哪些东西，请再试一次。
            </p>
          ) : reset.isSuccess ? (
            <p className="text-sm">已重置。{agent.name} 和你从头开始。</p>
          ) : (
            <div className="grid gap-2 text-sm">
              {lines.length === 0 ? (
                <p>没有属于你的东西可删。</p>
              ) : (
                <>
                  <p>将会删除：</p>
                  <ul className="list-disc pl-5">
                    {lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
              {plan.data.sharedConversationsKept > 0 ? (
                <p className="text-muted-foreground">
                  有 {plan.data.sharedConversationsKept}{" "}
                  段对话是和其他人或员工共享的，会保留。
                </p>
              ) : null}
              {/* Where memory isn't offered there are no memories to keep (see `offersMemory`). */}
              {memory ? (
                <p className="text-muted-foreground">
                  你自己的记忆——你直接告诉员工的那些——会保留。
                </p>
              ) : null}
            </div>
          )}
          {reset.error ? (
            <p className="mt-2 text-destructive text-sm" role="alert">
              {reset.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            variant="outline"
          >
            {reset.isSuccess ? "关闭" : "取消"}
          </Button>
          {reset.isSuccess ? null : (
            <Button
              disabled={!plan.data || lines.length === 0 || reset.isPending}
              onClick={() => reset.mutate(agent.id)}
              size="sm"
              variant="destructive"
            >
              {reset.isPending ? "正在重置…" : "删除并重置"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What can be done to a Bot: pin and hide (the person's own list only), duplicate, reset what it
 * has with this person, and, for whoever may manage it, delete it. The personal edition has one
 * person, so there the rows don't mention anybody else's list or conversations.
 *
 * Navigation is the caller's: hiding and deleting leave the page, duplicating opens the copy.
 */
export function ManageSection({
  agent,
  onHidden,
  onDuplicated,
  onDeleted,
}: {
  agent: AgentProfile;
  onHidden: () => void;
  onDuplicated: (copyId: string) => void;
  onDeleted: () => void;
}) {
  const setPinned = useMutation(setAgentPinnedMutationOptions(queryClient));
  const setHidden = useMutation(setAgentHiddenMutationOptions(queryClient));
  const duplicate = useMutation(duplicateAgentMutationOptions(queryClient));
  const remove = useMutation(deleteAgentMutationOptions(queryClient));
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const memory = useOffersMemory();
  const personal = usePersonal();
  // Said only where somebody else has a list of their own.
  const onlyYours = personal ? "" : "只改你自己的列表。";
  const error = setPinned.error ?? setHidden.error ?? duplicate.error;
  // An administrator put it in this person's list; it stays pinned and cannot be hidden.
  const assigned = agent.assignedToMe === true;

  return (
    <PageSection title="管理">
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconPin />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>置顶</ItemTitle>
            <ItemDescription>
              {assigned
                ? "管理员把它分配给了你，它会一直在你的员工列表顶部。"
                : agent.pinned
                  ? `在你的员工列表顶部。${onlyYours}`
                  : `让它一直在你的员工列表顶部。${onlyYours}`}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label="置顶"
              checked={agent.pinned || assigned}
              disabled={assigned || setPinned.isPending}
              onCheckedChange={(pinned) =>
                setPinned.mutate({ agentId: agent.id, pinned })
              }
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconEyeOff />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>隐藏</ItemTitle>
            <ItemDescription>
              {assigned
                ? "管理员把它分配给了你，不能隐藏。"
                : agent.hidden
                  ? `在你员工列表的「已隐藏」里。${onlyYours}`
                  : `从你的员工列表里拿掉。${onlyYours}`}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label="隐藏"
              checked={agent.hidden}
              disabled={assigned || setHidden.isPending}
              onCheckedChange={async (hidden) => {
                await setHidden.mutateAsync({ agentId: agent.id, hidden });
                if (hidden) onHidden();
              }}
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item
          render={
            <button
              disabled={duplicate.isPending}
              onClick={async () =>
                onDuplicated((await duplicate.mutateAsync(agent.id)).id)
              }
              type="button"
            />
          }
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconCopy />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>复制</ItemTitle>
            <ItemDescription>
              复制一份归你自己。它的对话和密钥不会被复制。
            </ItemDescription>
          </ItemContent>
        </Item>
        <Separator />
        <Item
          render={<button onClick={() => setResetOpen(true)} type="button" />}
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconRefresh />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>重置</ItemTitle>
            <ItemDescription>
              {/* Where memory isn't offered a Bot remembers nothing to delete (see `offersMemory`). */}
              {memory
                ? "删除你和它的对话、它为你记住的东西和它排期的工作。删除前会先列给你看。"
                : "删除你和它的对话和它排期的工作。删除前会先列给你看。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
        {agent.canManage ? (
          <>
            <Separator />
            <Item
              render={
                <button onClick={() => setDeleteOpen(true)} type="button" />
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconTrash />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>删除</ItemTitle>
                <ItemDescription>
                  {/* A deleted Bot's conversations stay readable (channel-chat.tsx says so there). */}
                  {personal
                    ? "删除它。你仍然可以查看和它的对话。删除后无法撤销。"
                    : "对所有人删除它。删除后无法撤销。"}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </>
        ) : null}
      </PageRows>
      <ResetDialog agent={agent} onOpenChange={setResetOpen} open={resetOpen} />
      <Dialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 {agent.name}？</DialogTitle>
            <DialogDescription>
              {personal
                ? "你仍然可以查看和它的对话，但它不会再回复。删除后无法撤销。"
                : "所有人都不能再用它。删除后无法撤销。"}
            </DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <DialogBody className="mt-4">
              <p className="text-destructive text-sm" role="alert">
                {remove.error.message}
              </p>
            </DialogBody>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setDeleteOpen(false)}
              size="sm"
              variant="outline"
            >
              取消
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={async () => {
                await remove.mutateAsync(agent.id);
                onDeleted();
              }}
              size="sm"
              variant="destructive"
            >
              {remove.isPending ? "正在删除…" : "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}
