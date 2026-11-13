import {
  IconArrowDown,
  IconArrowUp,
  IconSettings,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PortraitPicker } from "@/components/portraits/portrait-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { DissolveCrewDialog } from "@/components/wakers/dissolve-crew";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { groupQueryOptions } from "@/lib/groups";
import { pipelineTemplatesQueryOptions } from "@/lib/pipelines/queries";
import {
  crewForChannelMutationOptions,
  renameCrewMutationOptions,
  setCrewMembersMutationOptions,
} from "@/lib/waker-groups/mutations";
import { CrewRequestError, type WakerGroup } from "@/lib/waker-groups/queries";

const MIN_MEMBERS = 2;
const MAX_MEMBERS = 20;
const SIZE_HINT = `一个群组要有 ${MIN_MEMBERS} 到 ${MAX_MEMBERS} 位员工。`;

/**
 * The group's settings, from the chat's own top bar: an icon button and the drawer it opens. The
 * caller owns `open` so the address (`?settings=1`) and the drawer can be one thing.
 */
export function GroupSettingsButton({
  channelId,
  open,
  onOpenChange,
}: {
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <>
      <Button
        aria-label="群组设置"
        onClick={() => onOpenChange(true)}
        size="icon-sm"
        variant="ghost"
      >
        <IconSettings />
      </Button>
      <Sheet onOpenChange={onOpenChange} open={open}>
        <SheetContent
          className="w-full overflow-y-auto sm:max-w-md"
          side="right"
        >
          <SheetHeader>
            <SheetTitle>群组设置</SheetTitle>
            <SheetDescription>
              这个群聊背后的群组：名称、员工与顺序、头像和组团流程。
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            <GroupSettingsPanel channelId={channelId} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * Asks the server which group this chat is, and so whether this person may change it: a 200 is the
 * person who started it, a 403 anyone else, and a 409 a group whose starter has left the chat. Only
 * the first gets controls; the rest read the roster the chat itself already knows.
 */
export function GroupSettingsPanel({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const lookup = useMutation(crewForChannelMutationOptions(queryClient));
  const { mutate } = lookup;
  useEffect(() => {
    mutate(channelId);
  }, [channelId, mutate]);

  let body = <p className="text-muted-foreground text-sm">正在读取…</p>;
  if (lookup.isError) {
    const error = lookup.error;
    const status = error instanceof CrewRequestError ? error.status : 0;
    const gone = status === 409;
    body = (
      <ReadOnlyRoster
        channelId={channelId}
        note={
          status === 403
            ? "只有发起人能调整"
            : gone
              ? error.message
              : "群组信息加载失败。"
        }
        onRetry={status === 403 || gone ? undefined : () => mutate(channelId)}
      />
    );
  } else if (lookup.data) {
    body = <CrewEditor initial={lookup.data.group} />;
  }
  return (
    <div className="flex flex-col gap-5" data-slot="group-settings-panel">
      {body}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-[13px]">{title}</h3>
      {children}
    </section>
  );
}

/** Everyone else sees who is in the group, in the order the chat has them, and nothing to press. */
function ReadOnlyRoster({
  channelId,
  note,
  onRetry,
}: {
  channelId: string;
  note: string;
  onRetry?: () => void;
}) {
  const conversation = useQuery(groupQueryOptions(channelId));
  return (
    <Section title="员工与顺序">
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
        {(conversation.data?.bots ?? []).map((bot) => (
          <li key={bot.id}>{bot.name}</li>
        ))}
      </ol>
      <p className="text-muted-foreground text-xs">{note}</p>
      {onRetry ? (
        <div>
          <Button onClick={onRetry} size="sm" variant="outline">
            重试
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

const byPosition = (group: WakerGroup) =>
  [...group.members]
    .sort((a, b) => a.position - b.position)
    .map((member) => member.agentId);

function CrewEditor({ initial }: { initial: WakerGroup }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const agents = useQuery(agentListQueryOptions());
  const templates = useQuery(pipelineTemplatesQueryOptions(initial.id));
  const rename = useMutation(renameCrewMutationOptions(queryClient));
  const save = useMutation(setCrewMembersMutationOptions(queryClient));
  // What the server last said the group is; the edits below are held apart from it until saved.
  const [group, setGroup] = useState(initial);
  const [order, setOrder] = useState(() => byPosition(initial));
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initial.name);
  const [purpose, setPurpose] = useState(initial.description ?? "");
  const [adding, setAdding] = useState(false);
  const [choosingFace, setChoosingFace] = useState(false);
  const [dissolving, setDissolving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [renameProblem, setRenameProblem] = useState<string | null>(null);

  const nameOf = (agentId: string) =>
    agents.data?.find((agent) => agent.id === agentId)?.name ?? agentId;
  const saved = byPosition(group);
  const dirty =
    order.length !== saved.length ||
    order.some((agentId, index) => agentId !== saved[index]);
  const sizeOk = order.length >= MIN_MEMBERS && order.length <= MAX_MEMBERS;
  const candidates = (agents.data ?? []).filter(
    (agent) => !order.includes(agent.id),
  );
  // Taking out someone who owns a step is allowed; the person is told which step goes ownerless.
  const leaving = saved.filter((agentId) => !order.includes(agentId));
  const stepWarnings = leaving.flatMap((agentId) =>
    (templates.data ?? []).flatMap((template) =>
      template.steps.flatMap((step, index) =>
        step.agentId === agentId
          ? [
              {
                key: `${template.id}:${step.id}`,
                text: `${nameOf(agentId)}：这位员工负责流程「${template.name}」的第 ${index + 1} 步`,
              },
            ]
          : [],
      ),
    ),
  );

  const move = (from: number, to: number) =>
    setOrder((current) => {
      const next = [...current];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });

  const submitRename = () => {
    const body: { name?: string; description?: string } = {};
    if (name.trim() !== group.name) body.name = name.trim();
    if (purpose !== (group.description ?? "")) body.description = purpose;
    setRenameProblem(null);
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    rename.mutate(
      { groupId: group.id, ...body },
      {
        onSuccess: (result) => {
          setGroup((current) => ({ ...current, ...result.group }));
          setEditing(false);
        },
        onError: (thrown: Error) => setRenameProblem(thrown.message),
      },
    );
  };

  const submitMembers = () => {
    setProblem(null);
    save.mutate(
      { groupId: group.id, agentIds: order },
      {
        onSuccess: (result) => {
          setGroup(result.group);
          setOrder(byPosition(result.group));
          // The roster is saved even when the chat did not start; say so.
          if (result.chatError) setProblem(result.chatError);
        },
        onError: (thrown: Error) => setProblem(thrown.message),
      },
    );
  };

  return (
    <>
      <Section title="名称与用途">
        {editing ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitRename();
            }}
          >
            <Input
              aria-label="群组名称"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
            <Input
              aria-label="群组用途"
              onChange={(event) => setPurpose(event.target.value)}
              placeholder="这个群组是做什么的"
              value={purpose}
            />
            <div className="flex gap-2">
              <Button
                aria-label="保存名称与用途"
                disabled={!name.trim() || rename.isPending}
                size="sm"
                type="submit"
              >
                保存
              </Button>
              <Button
                onClick={() => {
                  setEditing(false);
                  setRenameProblem(null);
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                取消
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-medium text-sm">{group.name}</p>
              <p className="text-muted-foreground text-xs">
                {group.description || "还没写这个群组是做什么的。"}
              </p>
            </div>
            <Button
              aria-label="修改名称与用途"
              onClick={() => {
                setName(group.name);
                setPurpose(group.description ?? "");
                setEditing(true);
              }}
              size="sm"
              variant="ghost"
            >
              修改
            </Button>
          </div>
        )}
        {renameProblem ? (
          <p className="text-destructive text-xs" role="alert">
            {renameProblem}
          </p>
        ) : null}
      </Section>

      <Section title="员工与顺序">
        <ol className="flex flex-col gap-1">
          {order.map((agentId, index) => (
            <li
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
              key={agentId}
            >
              <span className="w-5 text-muted-foreground text-xs tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">{nameOf(agentId)}</span>
              <Button
                aria-label={`上移 ${nameOf(agentId)}`}
                disabled={index === 0}
                onClick={() => move(index, index - 1)}
                size="icon-xs"
                variant="ghost"
              >
                <IconArrowUp />
              </Button>
              <Button
                aria-label={`下移 ${nameOf(agentId)}`}
                disabled={index === order.length - 1}
                onClick={() => move(index, index + 1)}
                size="icon-xs"
                variant="ghost"
              >
                <IconArrowDown />
              </Button>
              <Button
                aria-label={`移除 ${nameOf(agentId)}`}
                onClick={() =>
                  setOrder((current) => current.filter((id) => id !== agentId))
                }
                size="icon-xs"
                variant="ghost"
              >
                <IconX />
              </Button>
            </li>
          ))}
        </ol>
        {stepWarnings.length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-muted-foreground text-xs">
            {stepWarnings.map((warning) => (
              <li key={warning.key}>{warning.text}</li>
            ))}
          </ul>
        ) : null}
        {sizeOk ? null : (
          <p className="text-destructive text-xs">{SIZE_HINT}</p>
        )}
        {adding ? (
          <div className="flex flex-wrap gap-1">
            {candidates.length === 0 ? (
              <span className="text-muted-foreground text-xs">
                没有可以再添加的员工。
              </span>
            ) : (
              candidates.map((agent) => (
                <Button
                  aria-label={`添加 ${agent.name}`}
                  key={agent.id}
                  onClick={() => setOrder((current) => [...current, agent.id])}
                  size="xs"
                  variant="outline"
                >
                  {agent.name}
                </Button>
              ))
            )}
          </div>
        ) : null}
        <div className="flex gap-2">
          <Button
            aria-expanded={adding}
            onClick={() => setAdding((open) => !open)}
            size="sm"
            variant="outline"
          >
            添加员工
          </Button>
          <Button
            aria-label="保存员工与顺序"
            disabled={!sizeOk || !dirty || save.isPending}
            onClick={submitMembers}
            size="sm"
          >
            保存
          </Button>
        </div>
        {problem ? (
          <p className="text-destructive text-xs" role="alert">
            {problem}
          </p>
        ) : null}
      </Section>

      <Section title="头像">
        <div>
          <Button
            onClick={() => setChoosingFace(true)}
            size="sm"
            variant="outline"
          >
            更换头像
          </Button>
        </div>
        {choosingFace ? (
          <PortraitPicker
            id={group.id}
            kind="group"
            name={group.name}
            onOpenChange={setChoosingFace}
            open={choosingFace}
            seed={group.id}
          />
        ) : null}
      </Section>

      <Section title="组团流程">
        {(templates.data ?? []).length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-sm">
            {(templates.data ?? []).map((template) => (
              <li key={template.id}>{template.name}</li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-xs">
            还没有给这个群组排流程。
          </p>
        )}
        <div className="flex gap-3 text-[13px]">
          <Link
            className="font-medium underline-offset-2 hover:underline"
            search={{ group: group.id }}
            to="/pipelines"
          >
            管理流程
          </Link>
          <Link
            className="font-medium underline-offset-2 hover:underline"
            search={{ crew: saved.join(",") }}
            to="/tasks"
          >
            在看板上看
          </Link>
        </div>
      </Section>

      <Section title="危险区">
        <div>
          <Button
            onClick={() => setDissolving(true)}
            size="sm"
            variant="destructive"
          >
            解散群组
          </Button>
        </div>
        <DissolveCrewDialog
          crew={group}
          onDissolved={() => void navigate({ to: "/" })}
          onOpenChange={setDissolving}
          open={dissolving}
        />
      </Section>
    </>
  );
}
