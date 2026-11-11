import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { z } from "zod";
import { AuditPage } from "@/components/manage/audit-page";

/**
 * Read surface for policy, computer, component, MCP, and credential audit events. `bot` narrows it
 * to one employee, which is how an employee's own activity page links here.
 *
 * M5b：改用上游 main 的 `AuditPage`（提问框、筛选标签、每行的「为什么？」、按动作合并行、事件搜索）。
 * fork 原页面的五个视图、只看某位员工、发起方、导出 CSV 与「更早的记录」上游都有，原样落在这一页。
 * 操作录制分区仍在 管理 → 企业管控（fork 的位置），这里不重复画。
 */
export const Route = createFileRoute("/_authed/admin/audit")({
  validateSearch: z.object({ bot: z.string().optional() }),
  component: AdminAuditPage,
});

/**
 * Search is read without `strict`, so the page also renders where it is mounted on a route of
 * another name, as the audit tests do. The route's own `validateSearch` has already checked it.
 */
function AdminAuditPage() {
  const { bot } = useSearch({ strict: false }) as { bot?: string };
  const navigate = useNavigate();
  return (
    <AuditPage
      ask
      bot={bot}
      onClearBot={() => navigate({ to: "/admin/audit" })}
    />
  );
}
