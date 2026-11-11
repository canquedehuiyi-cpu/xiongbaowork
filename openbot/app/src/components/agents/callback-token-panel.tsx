import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  issueCallbackTokenMutationOptions,
  revokeCallbackTokenMutationOptions,
} from "@/lib/agents/mutations";

/**
 * The credential this coworker presents when it calls a tool back.
 *
 * Only for a coworker that runs somewhere else. The Bot in the box has no endpoint and nothing to
 * authenticate as, and offering it a token would imply otherwise.
 *
 * Shown once, and said plainly. This deployment keeps a hash, so there is no screen that can show the
 * token again: an operator who loses it rotates, and rotating retires the old one, which is also how a
 * leak is handled.
 *
 * A coworker with no token can still hold a conversation. What it cannot do is reach anything outside
 * one, which is the right default for a URL somebody pasted.
 *
 * A Bot OpenBot runs itself, the harness picked in setup, is handed OpenBot's key on every run and
 * uses its tools with none of its own. The panel says so and offers nothing to generate: it used to
 * tell the personal starter it "can't use tools" while it searched the web and used the browser.
 */
export const KEY_FROM_OPENBOT =
  "这位员工由熊宝自己运行，不需要凭据也能用授予它的工具。";

export function CallbackTokenPanel({
  agentId,
  hasToken,
  fromOpenBot = false,
}: {
  agentId: string;
  hasToken: boolean;
  fromOpenBot?: boolean;
}) {
  const queryClient = useQueryClient();
  const issue = useMutation(issueCallbackTokenMutationOptions(queryClient));
  const revoke = useMutation(revokeCallbackTokenMutationOptions(queryClient));

  /** Held in state, not in a query cache: it must not survive a refetch or a navigation. */
  const [token, setToken] = useState<string | null>(null);
  const error = issue.error ?? revoke.error;

  const heading = (
    <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      回调工具
    </h2>
  );

  if (fromOpenBot) {
    return (
      <section className="mt-6 grid gap-2">
        {heading}
        <p className="text-muted-foreground text-sm">{KEY_FROM_OPENBOT}</p>
      </section>
    );
  }

  return (
    <section className="mt-6 grid gap-2">
      {heading}

      <p className="text-muted-foreground text-sm">
        {hasToken
          ? "这位员工持有凭据，所以能使用授予它的工具。轮换会换掉它，旧的立刻失效。"
          : "这位员工没有凭据，所以能对话，但用不了授予它的任何工具。生成一个，放进这位员工的配置里。"}
      </p>

      {token ? (
        <div className="grid gap-2 rounded-[12px] border border-border bg-card p-3">
          <p className="font-medium text-sm">现在就复制。之后不会再显示。</p>
          {/*
           * Selectable and wrapped rather than a copy button alone: somebody pasting this into a
           * deployment config on another machine may not have a clipboard between the two.
           */}
          <code className="block break-all rounded bg-foreground/5 p-2 font-mono text-xs">
            {token}
          </code>
          <p className="text-muted-foreground text-xs">
            部署只保存它的哈希，所以这里没有办法再给你看一次。
          </p>
          <Button onClick={() => setToken(null)} size="sm" variant="outline">
            完成
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={issue.isPending}
            onClick={async () => setToken(await issue.mutateAsync(agentId))}
            size="sm"
            variant="outline"
          >
            {issue.isPending ? "正在生成…" : hasToken ? "轮换令牌" : "生成令牌"}
          </Button>
          {hasToken ? (
            <Button
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(agentId)}
              size="sm"
              variant="outline"
            >
              {revoke.isPending ? "正在吊销…" : "吊销"}
            </Button>
          ) : null}
        </div>
      )}

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
    </section>
  );
}
