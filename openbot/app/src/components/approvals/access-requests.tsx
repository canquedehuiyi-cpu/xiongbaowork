import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  type AppAccessRequest,
  accessRequestInboxQueryOptions,
  approveAccessRequest,
  dismissAccessRequest,
} from "@/lib/plugins/access-requests";
import { pluginKeys } from "@/lib/plugins/queries";

/**
 * 管理员的访问申请收件箱，M5b 起放在 管理 → 审批（原来在 /approvals 的审批收件箱下面）。
 *
 * 访问申请是等管理员拍板的事，和团队审批设置、共享账号申请放在一起。批准时
 * 服务端调用现有的上架（`enable`）或授予只读动作（`grant`）；做不到时它的中文原因显示在那条申请上，
 * 申请留着。只给管理员看；服务端同样只认持有插件管理权限的人。
 */
export function AccessRequestInbox() {
  const { data: me } = useQuery(currentUserQueryOptions());
  if (me?.role !== "admin") return null;
  return <AdminAccessRequests />;
}

function AdminAccessRequests() {
  const cache = useQueryClient();
  const inbox = useQuery(accessRequestInboxQueryOptions());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const settle = (id: string) => (_data: unknown, error: Error | null) => {
    setErrors((current) => {
      const next = { ...current };
      if (error) next[id] = error.message;
      else delete next[id];
      return next;
    });
    // 批准会上架或授予，插件页读的东西也变了。
    return cache.invalidateQueries({ queryKey: pluginKeys.all });
  };
  const approve = useMutation({
    mutationFn: approveAccessRequest,
    onSettled: (data, error, id) => settle(id)(data, error),
  });
  const dismiss = useMutation({
    mutationFn: dismissAccessRequest,
    onSettled: (data, error, id) => settle(id)(data, error),
  });
  const busy = approve.isPending || dismiss.isPending;
  const requests = inbox.data ?? [];
  return (
    <section aria-labelledby="access-requests-heading" className="space-y-3">
      <div>
        <h2 id="access-requests-heading" className="font-medium">
          访问申请
        </h2>
        <p className="text-sm text-muted-foreground">
          员工在对话里替正在使用它的人申请还没开放给它的应用。批准会上架这个应用，或把它的只读动作授予这位员工。
        </p>
      </div>
      {inbox.error ? (
        <p role="alert" className="text-sm text-destructive">
          {inbox.error.message}
        </p>
      ) : null}
      {/*
       * 已经不在列表里的申请的结果：比如上架或授予已经生效，但申请在此期间被撤回或驳回。服务端的话
       * 原样留在这里，不随那一行一起消失。
       */}
      {Object.entries(errors)
        .filter(([id]) => !requests.some((request) => request.id === id))
        .map(([id, message]) => (
          <p key={id} role="alert" className="text-sm text-destructive">
            {message}
          </p>
        ))}
      {inbox.isSuccess && requests.length === 0 ? (
        <p className="text-sm text-muted-foreground">没有待处理的访问申请。</p>
      ) : null}
      {requests.map((request) => (
        <div
          key={request.id}
          className="space-y-2 rounded-lg border p-4"
          data-access-request={request.id}
        >
          <p className="font-medium">{request.appTitle}</p>
          <p className="text-sm text-muted-foreground">{describe(request)}</p>
          {/* X 系列（X2 评审 M3）加的字段，服务端没给（旧版本）时什么都不多画。 */}
          {request.scopeNote ? (
            // 只在 Team Bot 上有：批准会写在员工身上，每个能用它的人都会拿到，不只是申请人。
            <p className="text-sm" data-scope-note>
              {request.scopeNote}
            </p>
          ) : null}
          {request.note ? (
            // 理由由员工（模型）写下，不是申请人的原话。
            <p className="text-sm">员工给出的理由：{request.note}</p>
          ) : null}
          {errors[request.id] ? (
            <p role="alert" className="text-sm text-destructive">
              {errors[request.id]}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => approve.mutate(request.id)}
            >
              批准
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => dismiss.mutate(request.id)}
            >
              驳回
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}

/** 申请人和员工的关系；`scopeNote` 已经说过时不再重复。 */
const REQUESTER_ROLE: Record<"owner" | "teammate", string> = {
  owner: "（员工的主人）",
  teammate: "（使用这位员工的队友）",
};

function describe(request: AppAccessRequest): string {
  const role =
    !request.scopeNote &&
    (request.requesterRole === "owner" || request.requesterRole === "teammate")
      ? REQUESTER_ROLE[request.requesterRole]
      : "";
  const who = `${
    request.requesterName ?? request.requesterEmail ?? request.requesterUserId
  }${role}`;
  const bot = request.botName ?? request.botId;
  const what =
    request.kind === "enable" ? "上架这个应用" : "把这个应用授予这位员工";
  return `${who} 替员工「${bot}」申请${what}`;
}
