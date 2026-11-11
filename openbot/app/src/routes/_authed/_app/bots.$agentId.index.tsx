import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ManageSection } from "@/components/bot-profile/manage";
import { BotProfile } from "@/components/bot-profile/profile";
import { BotSettingsRows } from "@/components/bot-profile/settings-rows";
import { PageShell } from "@/components/layout/page-shell";
import { wakersBackLink } from "@/components/wakers/wakers-search";
import { agentQueryOptions } from "@/lib/agents/queries";
import { RequestError } from "@/lib/client";

/**
 * 员工自己的页面（`/bots/$agentId`）：上游 main 的 `BotProfile` + `BotSettingsRows` + `ManageSection`，
 * 熊宝的角色档案、暂停与通知（`BotControls`）、等你处理的事、动态和分身的信息来源都在 `BotProfile` 里。
 * 原 `/wakers/$agentId` 一页放下的其余各段拆进了 `/bots/$agentId/*` 的分页，由「这位员工的设置」里的行打开。
 *
 * 浏览器通知的 `noticePath`、桌面端的打开请求和旧消息里的链接都指向这个地址，所以它必须是正式页面。
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/")({
  component: BotProfilePage,
});

function BotProfilePage() {
  const { agentId } = Route.useParams();
  const navigate = useNavigate();
  const agent = useQuery(agentQueryOptions(agentId));
  const toRoster = () => void navigate({ to: "/bots" });
  const missing =
    agent.error instanceof RequestError && agent.error.status === 404;
  return (
    <PageShell
      // Back to the roster as the person left it: its filters, sort and view (the 员工 wall's own).
      backButton={{ label: "员工", linkProps: wakersBackLink() }}
      // No description: the employee's own role, on its card just below, says what this page is about.
      title={agent.data?.name ?? "员工"}
    >
      {agent.isPending ? null : agent.error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {missing
            ? "找不到这位员工，或者你没有权限查看它。"
            : "打不开这位员工，可能没有共享给你。"}
        </p>
      ) : (
        <BotProfile
          agent={agent.data}
          manage={
            <ManageSection
              agent={agent.data}
              onDeleted={toRoster}
              onDuplicated={(copyId) =>
                void navigate({
                  params: { agentId: copyId },
                  to: "/bots/$agentId",
                })
              }
              onHidden={toRoster}
            />
          }
          settings={<BotSettingsRows agent={agent.data} />}
        />
      )}
    </PageShell>
  );
}
