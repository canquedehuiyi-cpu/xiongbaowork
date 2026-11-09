import { useMutation, type useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { WorkbenchEmpty } from "@/components/layout/workbench-empty";
import { PortraitPicker } from "@/components/portraits/portrait-picker";
import { usePortraitSrc } from "@/components/portraits/use-portrait";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentProfile } from "@/lib/agents/queries";
import { cn } from "@/lib/utils";
import {
  createCrewMutationOptions,
  retireCrewMutationOptions,
  setCrewMembersMutationOptions,
} from "@/lib/waker-groups/mutations";
import type { WakerGroup } from "@/lib/waker-groups/queries";
import { CREW_CHAT_NEEDS_TWO, useOpenCrewChat } from "./use-open-crew-chat";
import {
  CARD_SURFACE,
  CardFooter,
  CREATE_CARD,
  CreateCardFace,
  GRID,
} from "./card-chrome";

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
 * The 群组 tab: a create card first, then one card per group, or a real empty state that says
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
  const crewChat = useOpenCrewChat();
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
          <Skeleton className="h-[212px]" key={key} />
        ))}
      </div>
    );
  }

  if (crews.length === 0) {
    return (
      <div
        className="rounded-lg border border-border bg-card"
        data-testid="crews-empty"
      >
        <WorkbenchEmpty
          action={<Button onClick={onCreate}>新建群组</Button>}
          className="py-16"
          description={CREW_MEANING}
          mood="cute"
          title="还没有群组"
        />
      </div>
    );
  }

  return (
    <>
      <div className={GRID}>
        {/* First, as on the employees tab and in the reference. */}
        <button
          className={CREATE_CARD}
          data-testid="crew-create-card"
          onClick={onCreate}
          type="button"
        >
          <CreateCardFace label="新建群组" />
        </button>
        {crews.map((crew) => (
          <CrewCard
            busy={members.isPending}
            crew={crew}
            key={crew.id}
            onChat={() => {
              setProblem(null);
              void crewChat.open(crew);
            }}
            opening={crewChat.openingId === crew.id}
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
      </div>
      {problem || crewChat.problem ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {problem ?? crewChat.problem}
        </p>
      ) : null}
    </>
  );
}

function CrewCard({
  busy,
  crew,
  onChat,
  opening,
  onRetire,
  onToggle,
  retiring,
  roster,
  rosterLoading,
}: {
  busy: boolean;
  crew: WakerGroup;
  /** Open this group's group chat, or start one with its members (use-open-crew-chat.ts). */
  onChat: () => void;
  opening: boolean;
  onRetire: () => void;
  onToggle: (agentId: string) => void;
  retiring: boolean;
  roster: AgentProfile[];
  rosterLoading: boolean;
}) {
  const [managing, setManaging] = useState(false);
  const [choosingFace, setChoosingFace] = useState(false);
  const face = usePortraitSrc("group", crew.id);
  /*
   * Disbanding drops the roster and the order somebody assembled, and nothing brings them back, so
   * the button that does it asks once before it does it.
   */
  const [confirming, setConfirming] = useState(false);
  const nameOf = (agentId: string) =>
    roster.find((agent) => agent.id === agentId)?.name ?? agentId;
  const ordered = [...crew.members].sort((a, b) => a.position - b.position);

  return (
    /*
     * The employees tab's card language: members' avatars centred on top, the name, one line of
     * purpose and the order, and a 成员 | 看板 footer under a hairline. Editing (管理成员 / 解散) is
     * a small row of its own, because on this tab it is the thing a person comes to do.
     */
    <div
      className={cn(CARD_SURFACE, "items-center px-4 pt-[16px]")}
      data-testid="crew-card"
    >
      <div className="flex h-[44px] shrink-0 items-center -space-x-3">
        {face ? (
          // A face somebody chose for the group stands in for its members' faces.
          <img
            alt={`群组头像：${crew.name}`}
            className="size-[44px] rounded-full object-cover ring-2 ring-card"
            data-portrait=""
            height={44}
            src={face}
            width={44}
          />
        ) : null}
        {(face ? [] : ordered.slice(0, 4)).map((member) => {
          const agent = roster.find((entry) => entry.id === member.agentId);
          return (
            <span
              className="rounded-full ring-2 ring-card"
              key={member.agentId}
            >
              <AbstractAvatar
                name={agent?.name ?? member.agentId}
                seed={agent?.avatarSeed ?? member.agentId}
                portrait={{ kind: "coworker", id: member.agentId }}
                size={40}
              />
            </span>
          );
        })}
        {!face && ordered.length > 4 ? (
          <span className="z-[1] inline-flex size-[40px] items-center justify-center rounded-full bg-muted text-[12px] text-muted-foreground ring-2 ring-card tabular-nums">
            +{ordered.length - 4}
          </span>
        ) : null}
        {!face && ordered.length === 0 ? (
          <span className="size-[40px] rounded-full border border-dashed" />
        ) : null}
      </div>
      <p className="mt-[12px] max-w-full truncate font-semibold text-[16px] leading-[24px]">
        {crew.name}
      </p>
      {crew.description ? (
        <p className="mt-1 w-full truncate text-[12px] text-muted-foreground leading-[18px]">
          {crew.description}
        </p>
      ) : null}
      {ordered.length > 0 ? (
        // The order a person put them in, because a pipeline crew reads as a sequence.
        <p
          className="mt-0.5 w-full truncate text-[12px] text-muted-foreground leading-[18px]"
          title={ordered.map((member) => nameOf(member.agentId)).join(" → ")}
        >
          顺序：{ordered.map((member) => nameOf(member.agentId)).join(" → ")}
        </p>
      ) : (
        <p className="mt-0.5 text-[12px] text-muted-foreground leading-[18px]">
          还没有成员，点「管理成员」挑选。
        </p>
      )}

      {managing && !rosterLoading ? (
        <div className="mt-3 flex flex-wrap justify-center gap-1">
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

      <div className="mt-1 flex flex-wrap items-center justify-center gap-1">
        {/*
         * The reason a group is made: to talk to its members together. Fewer than two members has
         * nobody to hold a group chat with, and the button says so instead of failing on click.
         */}
        <Button
          disabled={ordered.length < 2 || opening}
          onClick={onChat}
          size="xs"
          title={ordered.length < 2 ? CREW_CHAT_NEEDS_TWO : undefined}
        >
          {opening ? "正在打开…" : "进入群聊"}
        </Button>
        <Button
          aria-expanded={managing}
          onClick={() => setManaging((open) => !open)}
          size="xs"
          variant="ghost"
        >
          {managing ? "完成" : "管理成员"}
        </Button>
        <Button onClick={() => setChoosingFace(true)} size="xs" variant="ghost">
          更换头像
        </Button>
        {choosingFace ? (
          <PortraitPicker
            id={crew.id}
            kind="group"
            name={crew.name}
            onOpenChange={setChoosingFace}
            open={choosingFace}
            seed={crew.id}
          />
        ) : null}
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
      </div>

      <CardFooter
        className="mx-0 w-full"
        left={<span>{crew.members.length} 名员工</span>}
        right={
          /*
           * The board, narrowed to this crew. A group is only worth naming if the work can be looked
           * at through it, and the filter carries the roster rather than the group id so the cards
           * stay the same ones a person could reach member by member.
           */
          crew.members.length > 0 ? (
            <Link
              className="rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
              search={{
                crew: crew.members.map((member) => member.agentId).join(","),
              }}
              to="/tasks"
            >
              在看板上看
            </Link>
          ) : (
            <span>看板：还没有成员</span>
          )
        }
      />
    </div>
  );
}
