import { IconPin } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  postBoardCardMutationOptions,
  withdrawBoardCardMutationOptions,
} from "@/lib/board-cards/mutations";
import { boardCardsQueryOptions } from "@/lib/board-cards/queries";

/** 优先级的三档，数字就是服务器按的优先级。 */
export const PRIORITIES = [
  { value: 0, label: "普通" },
  { value: 5, label: "较高" },
  { value: 10, label: "最高" },
] as const;

/** 岗位就是员工的头衔：从你的员工里取，去重。 */
export function rolesOf(
  agents: readonly { title: string; mine: boolean }[],
): string[] {
  return [
    ...new Set(
      agents
        .filter((agent) => agent.mine)
        .map((agent) => agent.title.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * 看板上的「派给岗位」：写一张卡，说明派给哪个岗位。这个岗位上开了心跳的员工会按优先级自己来领，领了就开工，
 * 做完照常交付、等你验收。下面列着还没人领的卡，可以撤掉；被领走的卡会出现在看板上，标着「员工已认领」。
 */
export function PostRoleCard() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const agents = useQuery({ ...agentListQueryOptions(), enabled: open });
  const cards = useQuery({ ...boardCardsQueryOptions(), enabled: open });
  const post = useMutation({
    ...postBoardCardMutationOptions(queryClient),
    retry: false,
  });
  const withdraw = useMutation(withdrawBoardCardMutationOptions(queryClient));
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [role, setRole] = useState("");
  const [priority, setPriority] = useState(0);
  const [urgent, setUrgent] = useState(false);

  const roles = rolesOf(agents.data ?? []);
  const chosenRole = roles.includes(role) ? role : (roles[0] ?? "");
  const waiting = (cards.data ?? []).filter((card) => card.status === "open");
  const canPost = title.trim().length > 0 && chosenRole && !post.isPending;

  const send = () => {
    if (!canPost) return;
    post.mutate(
      {
        title: title.trim(),
        role: chosenRole,
        priority,
        ...(detail.trim() ? { detail: detail.trim() } : {}),
        ...(urgent ? { urgent } : {}),
      },
      {
        onSuccess: () => {
          setTitle("");
          setDetail("");
          setPriority(0);
          setUrgent(false);
        },
      },
    );
  };

  return (
    <>
      <Button
        onClick={() => {
          post.reset();
          withdraw.reset();
          setOpen(true);
        }}
        variant="outline"
      >
        <IconPin aria-hidden="true" />
        派给岗位
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>派给岗位</DialogTitle>
            <DialogDescription>
              写一张卡，选一个岗位。这个岗位上开了心跳的员工会自己来领，领了就开工，做完等你验收。
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3 overflow-y-auto">
            {agents.isPending ? (
              <p className="text-muted-foreground text-sm">正在读取岗位…</p>
            ) : roles.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                你还没有员工，没有岗位可以派。先招一位员工。
              </p>
            ) : (
              <>
                <Input
                  aria-label="卡片标题"
                  maxLength={200}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="要做什么？"
                  value={title}
                />
                <Textarea
                  aria-label="说明"
                  maxLength={2000}
                  onChange={(event) => setDetail(event.target.value)}
                  placeholder="补充说明：做到什么样算完成"
                  value={detail}
                />
                <div className="flex flex-wrap gap-2">
                  <select
                    aria-label="岗位"
                    className="rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    onChange={(event) => setRole(event.target.value)}
                    value={chosenRole}
                  >
                    {roles.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="优先级"
                    className="rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    onChange={(event) =>
                      setPriority(Number(event.target.value))
                    }
                    value={priority}
                  >
                    {PRIORITIES.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {`优先级：${entry.label}`}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    checked={urgent}
                    onChange={(event) => setUrgent(event.target.checked)}
                    type="checkbox"
                  />
                  紧急，安静时段里也可以领
                </label>
              </>
            )}
            {post.isSuccess ? (
              <p className="text-muted-foreground text-sm" role="status">
                已放上去，员工领了就会出现在看板上。
              </p>
            ) : post.error ? (
              <p className="text-destructive text-sm" role="alert">
                {post.error.message}
              </p>
            ) : null}
            {waiting.length > 0 ? (
              <section aria-label="还没人领的卡">
                <h4 className="mb-1 font-medium text-sm">还没人领的卡</h4>
                <ul className="flex flex-col gap-1">
                  {waiting.map((card) => (
                    <li
                      className="flex items-center justify-between gap-2 text-sm"
                      key={card.id}
                    >
                      <span className="min-w-0 truncate">
                        {card.title}
                        <span className="text-muted-foreground">
                          {` · ${card.role}${card.urgent ? " · 紧急" : ""}`}
                        </span>
                      </span>
                      <Button
                        aria-label={`撤掉「${card.title}」`}
                        disabled={withdraw.isPending}
                        onClick={() => withdraw.mutate(card.id)}
                        size="sm"
                        variant="ghost"
                      >
                        撤掉
                      </Button>
                    </li>
                  ))}
                </ul>
                {withdraw.error ? (
                  <p className="mt-1 text-destructive text-sm" role="alert">
                    {withdraw.error.message}
                  </p>
                ) : null}
              </section>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setOpen(false)} size="sm" variant="ghost">
              关闭
            </Button>
            <Button disabled={!canPost} onClick={send} size="sm">
              {post.isPending ? "正在放上去…" : "放上去"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
