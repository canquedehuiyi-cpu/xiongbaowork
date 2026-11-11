import { IconUser, IconUsers } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const people = group.data?.people ?? [];
  if (!group.data) return null;
  const iCreated = people.some(
    (person) => person.creator && person.userId === me?.id,
  );
  const count = `${people.length} 人`;

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
            <DialogTitle>群聊成员</DialogTitle>
            <DialogDescription>
              群里的每个人都能看到完整的对话，群里的每位员工都会回答他们。
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 grid gap-4 overflow-y-auto">
            <div className="overflow-hidden rounded-lg">
              {people.map((person, index) => {
                const self = person.userId === me?.id;
                const removable = self ? !person.creator : iCreated;
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
                          {person.creator ? "发起了这个群聊" : person.email}
                        </ItemDescription>
                      </ItemContent>
                      {removable ? (
                        <ItemActions>
                          <Button
                            aria-label={
                              self ? "退出这个群聊" : `移除 ${person.email}`
                            }
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(person.userId)}
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
