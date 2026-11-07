import { IconPlus } from "@tabler/icons-react";
import { useMutation, type useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  createCrewMutationOptions,
  retireCrewMutationOptions,
  setCrewMembersMutationOptions,
} from "@/lib/waker-groups/mutations";
import type { WakerGroup } from "@/lib/waker-groups/queries";

type QueryClient = ReturnType<typeof useQueryClient>;

/** Why a group exists and what it does not do, said wherever a person is about to make one. */
const CREW_MEANING =
  "群组是一串排好顺序的员工的名字，可以一起被叫来干活。它不授予任何权限——每位员工仍然只对它自己已获授权的那件事负责。";

/**
 * Making a group: a name and an optional purpose (`POST /api/waker-groups`). One dialog behind the
 * header's 新建群组, the grid's create card and the empty state's button, so all three are the same
 * flow and a refused name comes back as the server's own sentence in the same place.
 */
export function CreateCrewDialog({
  open,
  onOpenChange,
  queryClient,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryClient: QueryClient;
}) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation(createCrewMutationOptions(queryClient));
  const close = (next: boolean) => {
    if (!next) setProblem(null);
    onOpenChange(next);
  };
  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || create.isPending) return;
            setProblem(null);
            create.mutate(
              { name, description: purpose },
              {
                onSuccess: () => {
                  setName("");
                  setPurpose("");
                  close(false);
                },
                onError: (thrown: Error) => setProblem(thrown.message),
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>新建群组</DialogTitle>
            <DialogDescription>{CREW_MEANING}</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="群组名称"
            autoFocus
            onChange={(event) => setName(event.target.value)}
            placeholder="群组名称"
            value={name}
          />
          <Input
            aria-label="这个群组是做什么的（可选）"
            onChange={(event) => setPurpose(event.target.value)}
            placeholder="这个群组是做什么的（可选）"
            value={purpose}
          />
          {problem ? (
            <p className="text-destructive text-sm" role="alert">
              {problem}
            </p>
          ) : null}
          <DialogFooter>
            <Button onClick={() => close(false)} type="button" variant="ghost">
              取消
            </Button>
            <Button disabled={!name.trim() || create.isPending} type="submit">
              {create.isPending ? "正在创建…" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The 群组 tab: one card per group, ending in a dashed create card, or a real empty state that says
 * what a group is and offers to make one.
 */
export function CrewTab({
  crews,
  loading,
  onCreate,
  queryClient,
  roster,
  rosterLoading,
}: {
  crews: WakerGroup[];
  loading: boolean;
  onCreate: () => void;
  queryClient: QueryClient;
  /** The coworkers a group can be made of: the listed roster. */
  roster: AgentProfile[];
  rosterLoading: boolean;
}) {
  const members = useMutation(setCrewMembersMutationOptions(queryClient));
  const retire = useMutation(retireCrewMutationOptions(queryClient));
  const [problem, setProblem] = useState<string | null>(null);

  const toggle = (crew: WakerGroup, agentId: string) => {
    const inside = crew.members.some((member) => member.agentId === agentId);
    // The whole roster in order, never a delta the server would have to interpret.
    const next = inside
      ? crew.members
          .filter((member) => member.agentId !== agentId)
          .map((member) => member.agentId)
      : [...crew.members.map((member) => member.agentId), agentId];
    members.mutate(
      { groupId: crew.id, agentIds: next },
      { onError: (thrown: Error) => setProblem(thrown.message) },
    );
  };

  if (loading) {
    return (
      <div className={GRID}>
        {[0, 1, 2].map((key) => (
          <Skeleton className="h-[148px]" key={key} />
        ))}
      </div>
    );
  }

  if (crews.length === 0) {
    return (
      <Empty className="border py-16" data-testid="crews-empty">
        <EmptyHeader>
          <EmptyTitle>还没有群组</EmptyTitle>
          <EmptyDescription>{CREW_MEANING}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={onCreate}>新建群组</Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <>
      <div className={GRID}>
        {crews.map((crew) => (
          <CrewCard
            busy={members.isPending}
            crew={crew}
            key={crew.id}
            onRetire={() => {
              setProblem(null);
              retire.mutate(crew.id, {
                onError: (thrown: Error) => setProblem(thrown.message),
              });
            }}
            onToggle={(agentId) => toggle(crew, agentId)}
            retiring={retire.isPending}
            roster={roster}
            rosterLoading={rosterLoading}
          />
        ))}
        <button
          className={CREATE_CARD}
          data-testid="crew-create-card"
          onClick={onCreate}
          type="button"
        >
          <IconPlus aria-hidden="true" className="size-5" />
          创建群组
        </button>
      </div>
      {problem ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
    </>
  );
}

/** The wall's grid, shared by both tabs so the cards line up the same way. */
export const GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-[12px]";

const CREATE_CARD =
  "flex min-h-[148px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-muted-foreground text-sm outline-none transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60";

function CrewCard({
  busy,
  crew,
  onRetire,
  onToggle,
  retiring,
  roster,
  rosterLoading,
}: {
  busy: boolean;
  crew: WakerGroup;
  onRetire: () => void;
  onToggle: (agentId: string) => void;
  retiring: boolean;
  roster: AgentProfile[];
  rosterLoading: boolean;
}) {
  const [managing, setManaging] = useState(false);
  /*
   * Disbanding drops the roster and the order somebody assembled, and nothing brings them back, so
   * the button that does it asks once before it does it.
   */
  const [confirming, setConfirming] = useState(false);
  const nameOf = (agentId: string) =>
    roster.find((agent) => agent.id === agentId)?.name ?? agentId;
  const ordered = [...crew.members].sort((a, b) => a.position - b.position);

  return (
    <Item
      className="flex-col items-stretch gap-3 bg-card p-4"
      data-testid="crew-card"
      variant="outline"
    >
      <div className="flex items-start gap-3">
        <div className="flex shrink-0 -space-x-2">
          {ordered.slice(0, 3).map((member) => {
            const agent = roster.find((entry) => entry.id === member.agentId);
            return (
              <span
                className="rounded-full ring-2 ring-card"
                key={member.agentId}
              >
                <AbstractAvatar
                  name={agent?.name ?? member.agentId}
                  seed={agent?.avatarSeed ?? member.agentId}
                  size={32}
                />
              </span>
            );
          })}
          {ordered.length === 0 ? (
            <span className="size-8 rounded-full border border-dashed" />
          ) : null}
        </div>
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle className="max-w-full">
            <span className="truncate">{crew.name}</span>
          </ItemTitle>
          {crew.description ? (
            <ItemDescription className="line-clamp-1 text-[13px]">
              {crew.description}
            </ItemDescription>
          ) : null}
          <p className="text-muted-foreground text-xs">
            {crew.members.length} 名员工
          </p>
        </ItemContent>
      </div>

      {ordered.length > 0 ? (
        // The order a person put them in, because a pipeline crew reads as a sequence.
        <p className="text-muted-foreground text-xs">
          顺序：{ordered.map((member) => nameOf(member.agentId)).join(" → ")}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">
          还没有成员，点「管理成员」挑选。
        </p>
      )}

      {managing && !rosterLoading ? (
        <div className="flex flex-wrap gap-1">
          {roster.map((agent) => {
            const inside = crew.members.some(
              (member) => member.agentId === agent.id,
            );
            return (
              <button
                aria-pressed={inside}
                className={
                  inside
                    ? "rounded-full border bg-primary px-2 py-0.5 text-primary-foreground text-xs"
                    : "rounded-full border px-2 py-0.5 text-muted-foreground text-xs"
                }
                disabled={busy}
                key={agent.id}
                onClick={() => onToggle(agent.id)}
                type="button"
              >
                {inside ? "✓ " : ""}
                {agent.name}
              </button>
            );
          })}
        </div>
      ) : null}

      <ItemActions className="flex-wrap gap-1 border-t pt-3">
        <Button
          aria-expanded={managing}
          onClick={() => setManaging((open) => !open)}
          size="xs"
          variant="ghost"
        >
          {managing ? "完成" : "管理成员"}
        </Button>
        {/*
         * The board, narrowed to this crew. A group is only worth naming if the work can be looked at
         * through it, and the filter carries the roster rather than the group id so the cards stay the
         * same ones a person could reach member by member.
         */}
        {crew.members.length > 0 ? (
          <Link
            className={buttonVariants({ size: "xs", variant: "ghost" })}
            search={{
              crew: crew.members.map((member) => member.agentId).join(","),
            }}
            to="/tasks"
          >
            在看板上看
          </Link>
        ) : null}
        <span className="flex-1" />
        {confirming ? (
          <>
            <Button
              disabled={retiring}
              onClick={() => {
                setConfirming(false);
                onRetire();
              }}
              size="xs"
              variant="destructive"
            >
              确认解散「{crew.name}」
            </Button>
            <Button
              onClick={() => setConfirming(false)}
              size="xs"
              variant="ghost"
            >
              取消
            </Button>
          </>
        ) : (
          <Button
            disabled={retiring}
            onClick={() => setConfirming(true)}
            size="xs"
            variant="ghost"
          >
            解散
          </Button>
        )}
      </ItemActions>
    </Item>
  );
}
