import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  ACP_CHOICES,
  ACP_GHOST_BUTTON,
  ACP_PRIMARY_BUTTON,
  ACP_SECONDARY_BUTTON,
  type AcpChoice,
  acpCardOf,
  acpChoicesFor,
  acpRawText,
  decisionErrorText,
} from "@/components/channels/acp-cards";
import { ChannelAvatar } from "@/components/channels/avatar";
import { externalMark } from "@/lib/agents/external";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  approvalRequestOptions,
  decideApproval,
  decidedElsewhereWords,
} from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { cn } from "@/lib/utils";

/*
 * 审批详情（`/approvals?id=<审批 id>`）：手机网页上批一条「等你确认」，设计稿第 5 屏（外部员工 Task 12）。
 *
 * 谁想做什么、在哪台电脑上，命令或路径的原文，这一轮改了哪些文件、做到哪了，为什么问你；按钮大，贴在屏幕底部：
 * 「批准」一整行，下面一行「拒绝」和「这次对话里都允许」（底线和管理员拒绝的没有第三个）。设计稿里的「看它的
 * 屏幕」不做：要等设备端能推画面（外部员工 Task 11）。
 *
 * 读的是 `GET /api/approvals/:id`：只有这条审批的主人读得到，别人（群里的其他成员）读到 404，这里就说「不在
 * 你这里」。外部员工以外的审批不在这里批，指去审批列表。
 */

const LABEL =
  "text-[12px] text-[color:var(--wb-muted,var(--muted-foreground))]";
const PANEL =
  "rounded-[var(--wb-radius,12px)] border border-[color:var(--wb-line,var(--border))] bg-[color:var(--wb-card,var(--card))]";

const DONE_WORDS: Record<AcpChoice, string> = {
  allow_once: "已批准，只执行这一次。",
  deny: "已拒绝，它会知道你没同意。",
  allow_conversation: "已允许，这次对话里同样的事不再问你。",
};

/**
 * 按审批 id 换一份：从 `?id=A` 直接切到 `?id=B` 时路由不卸载这个组件，A 的「已决定」和请求状态
 * 会留到 B 上，B 明明还在等却没有按钮。
 */
export function ApprovalDetail({ id }: { id: string }) {
  return <OneApproval id={id} key={id} />;
}

function OneApproval({ id }: { id: string }) {
  const cache = useQueryClient();
  const request = useQuery({ ...approvalRequestOptions(id), retry: false });
  const agents = useQuery(agentListQueryOptions());
  const me = useQuery(currentUserQueryOptions());
  const [answered, setAnswered] = useState<AcpChoice | null>(null);
  const decision = useMutation({
    mutationFn: (choice: AcpChoice) => decideApproval(id, choice),
    onSuccess: (_, choice) => {
      setAnswered(choice);
      return cache.invalidateQueries({ queryKey: ["approvals"] });
    },
    // 别处已经决定过了：重读这一条，按钮随之收起。
    onError: () => cache.invalidateQueries({ queryKey: ["approvals"] }),
  });

  const data = request.data;
  const card = data ? acpCardOf(data.action) : null;
  const agent = agents.data?.find(
    (candidate) => candidate.id === data?.action.botId,
  );
  const raw = data ? acpRawText(data.action.args) : null;
  const waiting = data?.status === "pending" && answered === null;
  // 已经决定了（在这里刚答的，或别处、别的渠道决定的）：标题说「已处理」；还在等、还没读到时说「等你确认」。
  const settled =
    answered !== null || (data !== undefined && data.status !== "pending");
  /*
   * 在微信、Slack、Teams 上决定的：「已由 小熊 在 微信 批准。」（规格验收第 203、213 行）。审批只有本人能决定、
   * 也只有本人读得到，所以「某某」是本人的名字，没有名字时说「你」，与微信里的回话一致。网页上决定的、旧数据
   * 照旧（null）。
   */
  const elsewhere = data
    ? decidedElsewhereWords(data, me.data?.name?.trim() || "你")
    : null;
  const choices: AcpChoice[] = card ? acpChoicesFor(card) : [];
  const who = card?.employee || agent?.name || "这位员工";
  const headline =
    card?.action ||
    (data?.action.policy?.reason ? `${who}请你确认一件事` : `${who}等你确认`);
  const subtitle = [
    agent?.external ? externalMark(agent.external) : null,
    card?.computer || null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="flex min-h-full flex-col bg-[color:var(--wb-main,var(--background))] text-[14px] text-[color:var(--wb-fg,var(--foreground))]"
      data-approval-detail=""
    >
      <header className="flex items-center gap-3 border-[color:var(--wb-line,var(--border))] border-b px-4 py-4">
        <Link
          className="text-[color:var(--wb-fg2,var(--muted-foreground))] no-underline"
          data-slot="approval-back"
          to="/approvals"
        >
          返回
        </Link>
        <h1 className="m-0 font-semibold text-[16px]">
          {settled ? "已处理" : "等你确认"}
        </h1>
      </header>

      {request.isLoading ? (
        <p
          className="px-4 py-6 text-[color:var(--wb-muted,var(--muted-foreground))]"
          role="status"
        >
          正在读取…
        </p>
      ) : !data ? (
        <p
          className="px-4 py-6 text-[color:var(--wb-fg2,var(--muted-foreground))]"
          role="status"
        >
          这条请求不在你这里，或者已经没有了。
        </p>
      ) : !card && elsewhere ? (
        // 外部员工以外的请求在别的渠道（微信等）已经决定了：说一声在哪、谁决定的，不再指去审批列表。
        <p
          className="px-4 py-6 text-[color:var(--wb-fg2,var(--muted-foreground))]"
          data-slot="approval-decided-via"
          role="status"
        >
          {elsewhere}。
        </p>
      ) : !card ? (
        // 外部员工以外的请求（交给你做的、参数要看全的）在审批列表里处理，这一页只画外部员工的。
        <p
          className="px-4 py-6 text-[color:var(--wb-fg2,var(--muted-foreground))]"
          role="status"
        >
          这条请求请到审批列表里处理。{" "}
          <Link className="underline underline-offset-2" to="/approvals">
            打开审批列表
          </Link>
        </p>
      ) : (
        <>
          {/* 手机上按钮贴在底部，内容留出按钮那么高的空白，最后一行不会被盖住。 */}
          <div className="flex flex-1 flex-col gap-4 px-4 pt-[18px] pb-[200px] md:pb-6">
            <div className="flex items-center gap-3">
              <ChannelAvatar participantIds={[data.action.botId]} size={44} />
              <div className="flex min-w-0 flex-col gap-[3px]">
                <b className="font-semibold">{headline}</b>
                {subtitle ? (
                  <span className="text-[12px] text-[color:var(--wb-fg2,var(--muted-foreground))]">
                    {subtitle}
                  </span>
                ) : null}
              </div>
            </div>

            {raw ? (
              <pre className="m-0 whitespace-pre-wrap break-all rounded-[10px] bg-[color:var(--wb-rail,var(--muted))] p-3 font-mono text-[13px]">
                {raw}
              </pre>
            ) : null}

            {card && card.files.length > 0 ? (
              <div className="flex flex-col gap-2">
                <span className={LABEL}>这次改了什么</span>
                <ul
                  aria-label="改过的文件"
                  className={cn(PANEL, "m-0 list-none overflow-hidden p-0")}
                >
                  {card.files.map((file) => (
                    <li
                      className="break-all border-[color:var(--wb-line,var(--border))] border-b p-3 font-mono text-[13px] last:border-b-0"
                      key={file}
                    >
                      {file}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {card?.summary ? (
              <div className={cn(PANEL, "flex flex-col gap-1.5 p-3")}>
                <span className={LABEL}>这一轮</span>
                <span className="leading-[1.7] text-[color:var(--wb-fg2,var(--muted-foreground))]">
                  {card.summary}
                </span>
              </div>
            ) : null}

            <p className={cn(LABEL, "m-0 leading-relaxed")}>
              {card?.hit ? `${card.hit}。` : ""}
              {card?.reason || data.action.policy?.reason || ""}
              {waiting ? " 批准后只执行这一次。" : ""}
            </p>
          </div>

          <div
            className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-2.5 border-[color:var(--wb-line,var(--border))] border-t bg-[color:var(--wb-main,var(--background))] px-4 pt-3 pb-[max(28px,env(safe-area-inset-bottom))] md:static md:z-auto md:pb-6"
            data-slot="approval-actions"
          >
            {waiting ? (
              <>
                <button
                  className={cn(
                    ACP_PRIMARY_BUTTON,
                    "min-h-12 w-full rounded-[12px] text-[16px]",
                  )}
                  disabled={decision.isPending}
                  onClick={() => decision.mutate("allow_once")}
                  type="button"
                >
                  {ACP_CHOICES.allow_once}
                </button>
                <div className="flex gap-2.5">
                  {choices
                    .filter((choice) => choice !== "allow_once")
                    .map((choice) => (
                      <button
                        className={cn(
                          choice === "deny"
                            ? ACP_SECONDARY_BUTTON
                            : ACP_GHOST_BUTTON,
                          "min-h-11 flex-1 rounded-[12px] px-2",
                        )}
                        disabled={decision.isPending}
                        key={choice}
                        onClick={() => decision.mutate(choice)}
                        type="button"
                      >
                        {ACP_CHOICES[choice]}
                      </button>
                    ))}
                </div>
                {decision.error ? (
                  <p
                    className="m-0 text-[13px] text-[color:var(--wb-amber-fg,var(--signal-ink))]"
                    role="alert"
                  >
                    {decisionErrorText(decision.error)}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="m-0 py-2 text-center" role="status">
                {answered
                  ? DONE_WORDS[answered]
                  : elsewhere
                    ? `${elsewhere}。`
                    : "这条请求已经处理过了。"}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
