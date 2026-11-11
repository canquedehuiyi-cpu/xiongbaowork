import { approvalPhrase } from "@openbot/shared/tool-name";
import { IconCircleCheck } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  type ActionKind,
  approvalInboxOptions,
  type ConversationGrant,
  revokeConversationGrantMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";

/** A kind of action, as the start of a sentence about where it is allowed. */
const KIND_WORDS: Record<ActionKind, string> = {
  deleting: "删除",
  sending: "对外发送",
  sharing: "分享",
  publishing: "公开发布",
  payments: "付款",
  credentials: "修改登录信息",
  security_settings: "修改安全设置",
};

/**
 * What a conversation answer allows, as its line says it. An app's tool by its name, "Send message
 * on Slack". A step on a website covers that kind of step there, whichever button it presses, so it
 * says the kind: "Sending to other people on chat.example.com". A plain "Click on …" would read as
 * every click.
 */
function allowedWords(grant: ConversationGrant): string {
  if (grant.toolRef.startsWith("computer_") && grant.kind)
    return `在 ${grant.scope} 上${KIND_WORDS[grant.kind]}`;
  const phrase = approvalPhrase(grant);
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/**
 * What the person allowed for this conversation, above its composer: one line per action, each with
 * Turn off. Read from the same inbox the approval cards are, so a card answered with "Allow for this
 * conversation" shows its line here as soon as the inbox is read again.
 *
 * Turned off, the next such action in this conversation asks again. Nothing at all when nothing is
 * allowed here.
 */
export function ConversationAllowances({ threadId }: { threadId: string }) {
  const inbox = useQuery(approvalInboxOptions());
  const revoke = useMutation(
    revokeConversationGrantMutationOptions(queryClient),
  );
  const grants = (inbox.data?.conversationGrants ?? []).filter(
    (grant) => grant.threadId === threadId,
  );
  if (grants.length === 0) return null;
  return (
    <section
      aria-label="这段对话里已允许"
      className="flex flex-col gap-1 pb-2"
    >
      {grants.map((grant) => {
        const action = allowedWords(grant);
        return (
          <div
            className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/40 py-1 pr-1 pl-2.5 text-sm"
            key={grant.id}
          >
            <IconCircleCheck
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
            <p className="min-w-0 flex-1 truncate text-muted-foreground">
              「<span className="font-medium text-foreground">{action}</span>
              」在这段对话里已允许。
            </p>
            <Button
              aria-label={`关闭：${action}`}
              className="shrink-0"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(grant.id)}
              size="xs"
              variant="ghost"
            >
              关闭
            </Button>
          </div>
        );
      })}
      {revoke.error ? (
        <p className="text-destructive text-sm" role="alert">
          {revoke.error.message}
        </p>
      ) : null}
    </section>
  );
}
