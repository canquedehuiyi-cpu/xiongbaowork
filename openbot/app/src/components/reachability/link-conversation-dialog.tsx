import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
import { conversationLabel } from "@/lib/channels/label";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  confirmSms,
  deliveryKey,
  type Reachability,
  startChatLink,
  startSms,
} from "@/lib/delivery";

/**
 * The phone verification waiting for its code, kept for the tab.
 *
 * Only the challenge id lives in the page, and the text with the code arrives on the person's
 * phone a moment after they may have looked away: leaving and coming back used to drop the box to
 * type it into, with no way to confirm the code they had just been sent.
 */
const PENDING_SMS = "openbot.reachability.pendingSms";
function readPending(): string {
  try {
    return sessionStorage.getItem(PENDING_SMS) ?? "";
  } catch {
    return "";
  }
}
function writePending(id: string) {
  try {
    if (id) sessionStorage.setItem(PENDING_SMS, id);
    else sessionStorage.removeItem(PENDING_SMS);
  } catch {
    /* A browser that keeps nothing still confirms within the visit. */
  }
}

/**
 * The link-a-conversation flow's state, held by the page rather than the dialog.
 *
 * The dialog unmounts when it closes; a half-filled form or a phone waiting for its code must still
 * be there when the person opens it again, and the page's entry tile reads the pending code to say
 * so while the dialog is closed.
 */
export function useLinkFlow() {
  const queryClient = useQueryClient();
  const [channelId, setChannelId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [phone, setPhone] = useState("");
  const [copied, setCopied] = useState(false);
  const [challengeId, setChallengeId] = useState(readPending);
  useEffect(() => writePending(challengeId), [challengeId]);
  const [code, setCode] = useState("");
  const link = useMutation({
    mutationFn: (platform: "slack" | "teams") =>
      startChatLink({ channelId, agentId, platform }),
    onSuccess: () => setCopied(false),
  });
  const sms = useMutation({
    mutationFn: () => startSms({ channelId, agentId, phone }),
    onSuccess: setChallengeId,
  });
  const confirm = useMutation({
    mutationFn: () => confirmSms(challengeId, code),
    onSuccess: async () => {
      setChallengeId("");
      setCode("");
      await queryClient.invalidateQueries({ queryKey: deliveryKey });
    },
  });
  return {
    channelId,
    setChannelId,
    agentId,
    setAgentId,
    phone,
    setPhone,
    copied,
    setCopied,
    challengeId,
    code,
    setCode,
    link,
    sms,
    confirm,
  };
}

export type LinkFlow = ReturnType<typeof useLinkFlow>;

const selectClass =
  "h-[32px] rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

/** 接入 IM 聊天: link one conversation and coworker to Slack, Teams or a phone number. */
export function LinkConversationDialog({
  open,
  onOpenChange,
  flow,
  reach,
  botName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flow: LinkFlow;
  reach: Reachability | undefined;
  botName: (id: string) => string;
}) {
  const channels = useInfiniteQuery(channelListQueryOptions());
  const selected = channels.data?.find(
    (channel) => channel.id === flow.channelId,
  );
  const { link, sms, confirm } = flow;
  const error = link.error ?? sms.error ?? confirm.error;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>接入 IM 聊天</DialogTitle>
          <DialogDescription>
            在 Slack、Microsoft
            Teams、短信或你的手机上把一段对话接下去。提问与审批请求，找的是这段对话同一个主人。
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {error && (
            <p role="alert" className="text-destructive text-[13px]">
              {error.message}
            </p>
          )}
          {channels.error && !channels.data && (
            <p role="alert" className="text-destructive text-[13px]">
              无法读取你的会话：{channels.error.message}
            </p>
          )}
          <label className="grid gap-1 text-[13px]">
            会话
            <select
              className={selectClass}
              value={flow.channelId}
              onChange={(event) => {
                flow.setChannelId(event.target.value);
                flow.setAgentId("");
              }}
            >
              <option value="">选择一段对话</option>
              {channels.data
                ?.filter((channel) => channel.active)
                .map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {conversationLabel(channel)}
                  </option>
                ))}
            </select>
          </label>
          <label className="grid gap-1 text-[13px]">
            员工
            <select
              className={selectClass}
              value={flow.agentId}
              onChange={(event) => flow.setAgentId(event.target.value)}
            >
              <option value="">选择一位员工</option>
              {selected?.agentIds.map((id) => (
                <option key={id} value={id}>
                  {botName(id)}
                </option>
              ))}
            </select>
          </label>
          {channels.hasNextPage && (
            <Button
              variant="outline"
              disabled={channels.isFetchingNextPage}
              onClick={() => channels.fetchNextPage()}
            >
              加载更早的会话
            </Button>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                !flow.agentId || !reach?.available.slack || link.isPending
              }
              onClick={() => link.mutate("slack")}
            >
              关联 Slack
            </Button>
            <Button
              variant="outline"
              disabled={
                !flow.agentId || !reach?.available.teams || link.isPending
              }
              onClick={() => link.mutate("teams")}
            >
              关联 Microsoft Teams
            </Button>
          </div>
          {link.data && (
            <div className="grid gap-2 rounded-md border bg-muted/40 p-3 text-[13px]">
              <p>
                请在 {link.data.expiresInMinutes} 分钟内，把这条消息发给{" "}
                {link.data.platform === "teams" ? "Microsoft Teams" : "Slack"}{" "}
                里的本应用。它会把那个账号关联到这段对话和员工。
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1">
                  {link.data.command}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(
                      link.data?.command ?? "",
                    );
                    flow.setCopied(true);
                  }}
                >
                  {flow.copied ? "已复制" : "复制"}
                </Button>
              </div>
            </div>
          )}
          <p className="text-[13px] text-muted-foreground">
            在别人也看得见的频道里，员工会改用私信回你，而不是在群里答。
          </p>
          {reach && !reach.available.slack && (
            <p className="text-[13px] text-muted-foreground">
              需要管理员先把本产品与 OpenTag 配对，才能关联 Slack 或 Teams。
            </p>
          )}
          <form
            className="grid gap-3 border-t pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              sms.mutate();
            }}
          >
            <label htmlFor="delivery-phone" className="grid gap-1 text-[13px]">
              手机号
              <Input
                id="delivery-phone"
                type="tel"
                value={flow.phone}
                onChange={(event) => flow.setPhone(event.target.value)}
                placeholder="+15551234567"
                required
                pattern="\+[1-9][0-9]{7,14}"
              />
            </label>
            {reach && !reach.available.sms && (
              <p className="text-[13px] text-muted-foreground">
                这个部署没有配置短信服务，暂时不能用手机号接入。
              </p>
            )}
            <Button
              type="submit"
              disabled={!flow.agentId || !reach?.available.sms || sms.isPending}
            >
              {sms.isPending ? "正在发送…" : "发送验证码"}
            </Button>
          </form>
          {flow.challengeId && (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                confirm.mutate();
              }}
            >
              <Input
                aria-label="验证码"
                autoComplete="one-time-code"
                value={flow.code}
                onChange={(event) => flow.setCode(event.target.value)}
                required
              />
              <Button type="submit" disabled={confirm.isPending}>
                确认手机号
              </Button>
            </form>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
