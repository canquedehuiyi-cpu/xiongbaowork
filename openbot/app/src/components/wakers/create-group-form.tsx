import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { agentListQueryOptions } from "@/lib/agents/queries";
import type { AgentChannel } from "@/lib/channels/queries";
import { createGroupWithChatMutationOptions } from "@/lib/waker-groups/mutations";
import { CrewRequestError, type WakerGroup } from "@/lib/waker-groups/queries";

/** The most employees one 群组 holds: the server refuses more (`max(20)`). */
export const MOST_MEMBERS = 20;

/**
 * What a refusal says here. A 409 is the server's own sentence (a taken name); any other refusal
 * shows the server's words only when they are Chinese, since its English validation text would put
 * a JSON dump in front of a person.
 */
function refusalWords(error: Error): string {
  if (error instanceof CrewRequestError && error.status === 409)
    return error.message;
  return /[一-鿿]/.test(error.message)
    ? error.message
    : "群组没能建好，请再试一次。";
}

/**
 * 新建群组: a name, an optional purpose, and two to twenty employees in the order they will answer.
 * One request (`POST /api/waker-groups`) makes the group and its chat together, so the page and the
 * 员工页 dialog are the same flow. The name follows the picked employees until it is typed over.
 */
export function CreateGroupForm({
  variant,
  onCreated,
  onCancel,
}: {
  variant: "page" | "dialog";
  onCreated: (result: { group: WakerGroup; channel: AgentChannel }) => void;
  onCancel?: () => void;
}) {
  const queryClient = useQueryClient();
  const profiles = useQuery(agentListQueryOptions());
  const create = useMutation(createGroupWithChatMutationOptions(queryClient));
  const [chosen, setChosen] = useState<string[]>([]);
  const [typedName, setTypedName] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("");

  const nameOf = (id: string) =>
    profiles.data?.find((profile) => profile.id === id)?.name ?? id;
  const name = typedName ?? chosen.map(nameOf).join("、");
  const ready = chosen.length >= 2 && name.trim() !== "" && !create.isPending;

  const submit = () => {
    if (!ready) return;
    create.mutate(
      { name: name.trim(), description: purpose, agentIds: chosen },
      { onSuccess: onCreated },
    );
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        aria-label="群组名称"
        autoFocus={variant === "dialog"}
        onChange={(event) => setTypedName(event.target.value)}
        placeholder="群组名称"
        required
        value={name}
      />
      <Input
        aria-label="这个群组是做什么的（可选）"
        onChange={(event) => setPurpose(event.target.value)}
        placeholder="这个群组是做什么的（可选）"
        value={purpose}
      />
      {profiles.isError ? (
        <p
          className="rounded-[12px] border border-signal/30 bg-signal-soft px-3 py-2 text-[13px] text-signal-ink"
          role="alert"
        >
          {profiles.error.message}
        </p>
      ) : null}
      {profiles.isPending ? (
        <p className="text-[13px] text-muted-foreground" role="status">
          正在读取员工…
        </p>
      ) : null}
      {profiles.data && profiles.data.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          还没有员工可以拉进群组。
        </p>
      ) : null}
      {profiles.data?.length ? (
        <div
          className={`flex flex-col overflow-hidden rounded-[14px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] ${
            variant === "dialog" ? "max-h-72 overflow-y-auto" : ""
          }`}
        >
          {profiles.data.map((profile) => {
            const checked = chosen.includes(profile.id);
            // Full: the ones not yet picked wait, so nobody is added past what the server takes.
            const full = !checked && chosen.length >= MOST_MEMBERS;
            return (
              <label
                className="flex min-h-[48px] cursor-pointer items-center gap-2.5 border-border border-b px-3 py-2 last:border-b-0 hover:bg-foreground/[0.03] has-[[data-checked]]:bg-accent"
                htmlFor={`group-bot-${profile.id}`}
                key={profile.id}
              >
                <Checkbox
                  aria-label={profile.name}
                  // The place in the answering order, read with the name (the chip says it on screen).
                  aria-describedby={
                    checked ? `group-order-${profile.id}` : undefined
                  }
                  checked={checked}
                  disabled={full}
                  id={`group-bot-${profile.id}`}
                  onCheckedChange={(next) =>
                    setChosen((current) =>
                      next
                        ? [...current, profile.id]
                        : current.filter((id) => id !== profile.id),
                    )
                  }
                />
                <ChannelAvatar participantIds={[profile.id]} size={26} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-[13px]">
                    {profile.name}
                  </span>
                  {profile.title ? (
                    <span className="block truncate text-[12px] text-muted-foreground">
                      {profile.title}
                    </span>
                  ) : null}
                </span>
                {checked ? (
                  <span
                    className="shrink-0 rounded-full border border-signal/30 bg-signal-soft px-2 py-0.5 text-[11px] text-signal-ink"
                    id={`group-order-${profile.id}`}
                  >
                    第 {chosen.indexOf(profile.id) + 1} 个回答
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      ) : null}
      {create.error ? (
        <p
          className="rounded-[12px] border border-signal/30 bg-signal-soft px-3 py-2 text-[13px] text-signal-ink"
          role="alert"
        >
          {refusalWords(create.error)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-live="polite"
          className="order-last basis-full text-[12px] text-faint sm:order-none sm:basis-auto sm:flex-1"
        >
          {chosen.length < 2
            ? `已选 ${chosen.length} 位，至少还要 ${2 - chosen.length} 位`
            : chosen.length >= MOST_MEMBERS
              ? `已选 ${chosen.length} 位，一个群组最多 ${MOST_MEMBERS} 位`
              : `已选 ${chosen.length} 位`}
        </span>
        {onCancel ? (
          <Button onClick={onCancel} type="button" variant="ghost">
            取消
          </Button>
        ) : null}
        <Button disabled={!ready} type="submit">
          {create.isPending
            ? "正在创建…"
            : variant === "page"
              ? "创建群组"
              : "创建"}
        </Button>
      </div>
    </form>
  );
}
