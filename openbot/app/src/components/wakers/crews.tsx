import { IconPlus, IconUsersGroup } from "@tabler/icons-react";
import {
  useMutation,
  useQuery,
  type useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentProfile } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";
import { pipelineTemplatesQueryOptions } from "@/lib/pipelines/queries";
import { cn } from "@/lib/utils";
import {
  retireCrewMutationOptions,
  setCrewMembersMutationOptions,
  startCrewChatMutationOptions,
} from "@/lib/waker-groups/mutations";
import {
  CREW_STATUS_WORDS,
  crewStatus,
  type WakerGroup,
} from "@/lib/waker-groups/queries";
import {
  CARD_SURFACE,
  CardFooter,
  CardIndex,
  CREATE_CARD,
  CreateCardFace,
  FACE_FRAME,
  GRID,
  ordinal,
} from "./card-chrome";
import { CreateGroupForm } from "./create-group-form";

/** A text link in a card's action row, sized like the ghost buttons beside it. */
const CARD_LINK =
  "inline-flex h-6 items-center rounded-md px-2 font-medium text-[12px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60";

type QueryClient = ReturnType<typeof useQueryClient>;

/** Why a group exists and what it does not do, said wherever a person is about to make one. */
const CREW_MEANING =
  "新建群组会同时建一个聊天，群里的员工在里面一起干活。群组不授予任何权限——每位员工仍然只对它自己已获授权的那件事负责。";

/**
 * Making a group (`POST /api/waker-groups`): the same form as the 新建群组 page, in a dialog. One
 * dialog behind the header's 新建群组, the grid's create card and the empty state's button, so all
 * three are the same flow and a refused name comes back as the server's own sentence in the same
 * place. A made group opens its chat.
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
  const navigate = useNavigate();
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建群组</DialogTitle>
          <DialogDescription>{CREW_MEANING}</DialogDescription>
        </DialogHeader>
        <CreateGroupForm
          onCancel={() => onOpenChange(false)}
          onCreated={({ channel }) => {
            queryClient.setQueryData(channelKeys.detail(channel.id), channel);
            onOpenChange(false);
            void navigate({
              to: "/group/$channelId",
              params: { channelId: channel.id },
            });
          }}
          variant="dialog"
        />
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
  const [problem, setProblem] = useState<string | null>(null);

  const toggle = (crew: WakerGroup, agentId: string) => {
    const inside = crew.members.some((member) => member.agentId === agentId);
    // The whole roster in order, never a delta the server would have to interpret.
    const next = inside
      ? crew.members
          .filter((member) => member.agentId !== agentId)
          .map((member) => member.agentId)
      : [...crew.members.map((member) => member.agentId), agentId];
    setProblem(null);
    members.mutate(
      { groupId: crew.id, agentIds: next },
      {
        // The roster is saved even when the chat did not start; the card then offers 开始聊天.
        onSuccess: ({ chatError }) => {
          if (chatError) setProblem(chatError);
        },
        // A 409 (part-way, or owner-gone) carries the server's own sentence.
        onError: (thrown: Error) => setProblem(thrown.message),
      },
    );
  };

  if (loading) {
    return (
      <div className={GRID}>
        {[0, 1, 2].map((key) => (
          <Skeleton className="h-[177px] rounded-[16px]" key={key} />
        ))}
      </div>
    );
  }

  if (crews.length === 0) {
    return (
      <div
        className="rounded-[16px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]"
        data-testid="crews-empty"
      >
        <WorkbenchEmpty
          action={
            <Button className="h-[29px] text-[12px]" onClick={onCreate}>
              <IconPlus aria-hidden="true" />
              新建群组
            </Button>
          }
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
        {crews.map((crew, index) => (
          <CrewCard
            busy={members.isPending}
            crew={crew}
            index={ordinal(index)}
            key={crew.id}
            onRetire={() => {
              setProblem(null);
              retire.mutate(crew.id, {
                onError: (thrown: Error) => setProblem(thrown.message),
              });
            }}
            onToggle={(agentId) => toggle(crew, agentId)}
            queryClient={queryClient}
            retiring={retire.isPending}
            roster={roster}
            rosterLoading={rosterLoading}
          />
        ))}
        {/* Last, as on the employees tab: one more slot after the groups that exist. */}
        <button
          className={CREATE_CARD}
          data-testid="crew-create-card"
          onClick={onCreate}
          type="button"
        >
          <CreateCardFace
            hint="把几位员工排成一个可以一起叫来的群组"
            kind="Group"
            label="新建群组"
          />
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

function CrewCard({
  busy,
  crew,
  index,
  onRetire,
  onToggle,
  queryClient,
  retiring,
  roster,
  rosterLoading,
}: {
  busy: boolean;
  crew: WakerGroup;
  /** The card's place on the wall, for its `GROUP / 01` index. */
  index: string;
  onRetire: () => void;
  onToggle: (agentId: string) => void;
  queryClient: QueryClient;
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
  const navigate = useNavigate();
  const startChat = useMutation(startCrewChatMutationOptions(queryClient));
  const [chatProblem, setChatProblem] = useState<string | null>(null);
  const status = crewStatus(crew);
  // Only read when the question is asked: how many flows go with the group.
  const pipelines = useQuery({
    ...pipelineTemplatesQueryOptions(),
    enabled: confirming,
  });
  const pipelineCount = pipelines.data?.filter(
    (template) => template.groupId === crew.id,
  ).length;
  const nameOf = (agentId: string) =>
    roster.find((agent) => agent.id === agentId)?.name ?? agentId;
  const ordered = [...crew.members].sort((a, b) => a.position - b.position);
  const sequence = ordered.map((member) => nameOf(member.agentId)).join(" → ");

  return (
    /*
     * The employees tab's 「角色档案」 card (docs/design/ios-studio/04-员工管理.png): a mono
     * `GROUP / 01` index, the group's face beside its name and purpose, then its members' faces in
     * order and the order spelled out, and a 成员 · 看板 footer under a hairline. Editing (管理成员 /
     * 更换头像 / 解散) stays on the face, because on this tab it is the thing a person comes to do.
     */
    <div className={CARD_SURFACE} data-testid="crew-card">
      <div className="flex min-h-[21px] items-center justify-between gap-[5px]">
        <CardIndex index={index} kind="Group" />
      </div>
      <div className="mt-[12px] flex min-w-0 items-center gap-[10px]">
        <span className={FACE_FRAME}>
          {face ? (
            // A face somebody chose for the group stands in for a generic mark.
            <img
              alt={`群组头像：${crew.name}`}
              className="size-full object-cover"
              data-portrait=""
              height={44}
              src={face}
              width={44}
            />
          ) : (
            <IconUsersGroup
              aria-hidden="true"
              className="size-[22px] text-foreground/85"
              stroke={1.6}
            />
          )}
        </span>
        <div className="min-w-0">
          <h3 className="truncate font-bold text-[16px] leading-[22px] tracking-[-0.01em]">
            {crew.name}
          </h3>
          <p className="mt-px truncate text-[12px] text-muted-foreground leading-[17px]">
            {crew.description || "还没写这个群组是做什么的。"}
          </p>
        </div>
      </div>

      <div className="mt-[10px] flex min-w-0 items-center gap-[8px]">
        {ordered.length > 0 ? (
          <>
            {/* A chosen group face already stands for them; otherwise the first four faces, in order. */}
            {face ? null : (
              <span className="flex shrink-0 items-center -space-x-[6px]">
                {ordered.slice(0, 4).map((member) => {
                  const agent = roster.find(
                    (entry) => entry.id === member.agentId,
                  );
                  return (
                    <span
                      className="inline-flex rounded-[7px] ring-2 ring-card [&_svg]:scale-[1.42]"
                      key={member.agentId}
                    >
                      <AbstractAvatar
                        name={agent?.name ?? member.agentId}
                        portrait={{ kind: "coworker", id: member.agentId }}
                        seed={agent?.avatarSeed ?? member.agentId}
                        size={20}
                      />
                    </span>
                  );
                })}
                {ordered.length > 4 ? (
                  <span className="z-[1] inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-[7px] bg-muted px-[3px] text-[10px] text-muted-foreground ring-2 ring-card tabular-nums">
                    +{ordered.length - 4}
                  </span>
                ) : null}
              </span>
            )}
            {/* The order a person put them in, because a pipeline crew reads as a sequence. */}
            <p
              className="min-w-0 truncate text-[12px] text-muted-foreground leading-[18px]"
              title={sequence}
            >
              顺序：{sequence}
            </p>
          </>
        ) : (
          <p className="text-[12px] text-muted-foreground leading-[18px]">
            还没有成员，点「管理成员」挑选。
          </p>
        )}
      </div>

      {managing && !rosterLoading ? (
        <div className="mt-[10px] flex flex-wrap gap-1">
          {roster.map((agent) => {
            const inside = crew.members.some(
              (member) => member.agentId === agent.id,
            );
            return (
              <button
                aria-pressed={inside}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
                  inside
                    ? "border-primary bg-primary font-medium text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
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

      <div className="mt-[8px] mb-[8px] -ml-[8px] flex flex-wrap items-center gap-1">
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
        {status === "chat" && crew.channelId ? (
          <>
            <Link
              className={CARD_LINK}
              params={{ channelId: crew.channelId }}
              to="/group/$channelId"
            >
              打开
            </Link>
            <Link
              className={CARD_LINK}
              params={{ channelId: crew.channelId }}
              search={{ settings: 1 }}
              to="/group/$channelId"
            >
              设置
            </Link>
          </>
        ) : status === "not_started" ? (
          <Button
            disabled={startChat.isPending}
            onClick={() => {
              setChatProblem(null);
              startChat.mutate(crew.id, {
                onSuccess: ({ channel }) =>
                  void navigate({
                    to: "/group/$channelId",
                    params: { channelId: channel.id },
                  }),
                onError: (thrown: Error) => setChatProblem(thrown.message),
              });
            }}
            size="xs"
            variant="ghost"
          >
            开始聊天
          </Button>
        ) : status === "pending_members" || status === "too_many" ? (
          <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
            {CREW_STATUS_WORDS[status]}
          </span>
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

      {confirming ? (
        <p className="mb-[8px] text-[12px] text-muted-foreground leading-[18px]">
          解散「{crew.name}」：聊天记录不再显示；它的
          {pipelineCount === undefined ? "" : ` ${pipelineCount} 条`}
          组团流程和运行记录会一并删除；看板上已有的任务卡保留。
        </p>
      ) : null}
      {chatProblem ? (
        <p className="mb-[8px] text-[12px] text-destructive" role="alert">
          {chatProblem}
        </p>
      ) : null}

      <CardFooter
        left={<span>{crew.members.length} 名员工</span>}
        right={
          /*
           * The board, narrowed to this crew. A group is only worth naming if the work can be looked
           * at through it, and the filter carries the roster rather than the group id so the cards
           * stay the same ones a person could reach member by member.
           */
          crew.members.length > 0 ? (
            <span className="flex items-center gap-[10px]">
              {/*
               * 组团流程：给这个群组排好顺序的工作。带上群组 id，流程页直接停在这个群组那一节。
               */}
              <Link
                className="rounded-sm font-semibold text-foreground/90 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                search={{ group: crew.id }}
                to="/pipelines"
              >
                组团流程
              </Link>
              <Link
                className="rounded-sm font-semibold text-foreground/90 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                search={{
                  crew: crew.members.map((member) => member.agentId).join(","),
                }}
                to="/tasks"
              >
                在看板上看
              </Link>
            </span>
          ) : (
            <span>看板：还没有成员</span>
          )
        }
      />
    </div>
  );
}
