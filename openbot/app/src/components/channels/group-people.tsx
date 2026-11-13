import { IconUser, IconUsers } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  addGroupMemberMutationOptions,
  groupQueryOptions,
  removeGroupMemberMutationOptions,
} from "@/lib/groups";
import { useGroupOfChannel } from "@/lib/waker-groups/use-group-of-channel";

/**
 * Who is in a group, from its top bar: how many people, and a dialog listing them where the creator
 * can take someone out, anyone else can leave, and anyone in it can add a person who has signed in
 * here. Everyone added sees the whole conversation.
 *
 * 熊宝原来把成员和「添加成员」放在输入框上方（group-chat.tsx 的 People / AddPerson），M5b 跟上游挪到顶栏这里。
 */
export function GroupPeopleButton({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const group = useQuery(groupQueryOptions(channelId));
  const me = useQuery(currentUserQueryOptions()).data;
  const add = useMutation(
    addGroupMemberMutationOptions(queryClient, channelId),
  );
  const remove = useMutation(
    removeGroupMemberMutationOptions(queryClient, channelId),
  );
  const navigate = useNavigate();
  const onScreen = useParams({
    strict: false,
    select: (params) =>
      (params as { channelId?: string }).channelId === channelId,
  });
  // Only a chat that is a group's has someone to hand it to; the creator of any other cannot leave.
  const linked = useGroupOfChannel().has(channelId);
  // Away once out, so nobody is left looking at a chat they are no longer in.
  const leave = onScreen ? () => void navigate({ to: "/" }) : undefined;
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  // The creator's leaving hands the group on (or ends the chat), so it is asked before it is done.
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const people = group.data?.people ?? [];
  if (!group.data) return null;
  const iCreated = people.some(
    (person) => person.creator && person.userId === me?.id,
  );
  const count = `${people.length} 人`;
  // The server's people come in the order they joined, and the earliest one left takes the group
  // over (`channel_memberships.created_at`), so the first person who is not me is who gets it.
  const successor = people.find((person) => person.userId !== me?.id);
  const leaveWords = successor
    ? `退出后，这个群组和它的头像、组团流程、运行记录、看板任务卡都归「${successor.name ?? successor.email}」。`
    : "你是最后一个人。退出后这个聊天会删除，群组留在你的「群组」里，可以重新开始聊天。";

  return (
    <>
      <Button
        className="ml-auto"
        onClick={() => setOpen(true)}
        size="sm"
        variant="ghost"
      >
        <IconUsers />
        {count}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>群组成员</DialogTitle>
            <DialogDescription>
              群里的每个人都能看到完整的对话，群里的每位员工都会回答他们。
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 grid gap-4 overflow-y-auto">
            <div className="overflow-hidden rounded-lg">
              {people.map((person, index) => {
                const self = person.userId === me?.id;
                const removable = self ? !person.creator || linked : iCreated;
                return (
                  <Fragment key={person.userId}>
                    {index > 0 ? <Separator /> : null}
                    <Item size="sm" variant="muted">
                      <ItemMedia variant="icon">
                        <IconUser />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          {self ? "你" : (person.name ?? person.email)}
                        </ItemTitle>
                        <ItemDescription>
                          {person.creator ? "发起了这个群组" : person.email}
                        </ItemDescription>
                      </ItemContent>
                      {removable ? (
                        <ItemActions>
                          <Button
                            aria-label={
                              self ? "退出这个群组" : `移除 ${person.email}`
                            }
                            disabled={remove.isPending}
                            onClick={() =>
                              self && iCreated
                                ? setConfirmingLeave(true)
                                : remove.mutate(person.userId, {
                                    onSuccess: () => self && leave?.(),
                                  })
                            }
                            size="sm"
                            variant="outline"
                          >
                            {self ? "退出" : "移除"}
                          </Button>
                        </ItemActions>
                      ) : null}
                    </Item>
                  </Fragment>
                );
              })}
            </div>
            {confirmingLeave ? (
              <div className="grid gap-2 rounded-lg border p-3">
                <p className="text-sm">{leaveWords}</p>
                <div className="flex gap-2">
                  <Button
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(me?.id ?? "", {
                        onSuccess: () => {
                          setConfirmingLeave(false);
                          leave?.();
                        },
                      })
                    }
                    size="sm"
                    variant="destructive"
                  >
                    确认退出
                  </Button>
                  <Button
                    onClick={() => setConfirmingLeave(false)}
                    size="sm"
                    variant="ghost"
                  >
                    取消
                  </Button>
                </div>
              </div>
            ) : null}
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                add.mutate(email.trim(), { onSuccess: () => setEmail("") });
              }}
            >
              <Input
                aria-label="对方的邮箱"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="输入邮箱添加成员"
                type="email"
                value={email}
              />
              <Button
                disabled={!email.trim() || add.isPending}
                size="sm"
                type="submit"
              >
                添加
              </Button>
            </form>
            {add.error || remove.error ? (
              <p className="text-destructive text-sm" role="alert">
                {(add.error ?? remove.error)?.message}
              </p>
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
