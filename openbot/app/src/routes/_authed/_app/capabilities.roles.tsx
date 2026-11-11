import { createFileRoute } from "@tanstack/react-router";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { RoleTemplatesScreen } from "@/components/roles/role-templates-page";

/**
 * 能力 › 角色模板：我的模板和官方模板，可以手写、粘贴 Markdown 或用一句话生成（`/role-templates` 重定向到
 * 这里）。员工页头部的「角色模板」按钮也指向这里。
 */
export const Route = createFileRoute("/_authed/_app/capabilities/roles")({
  component: RolesPage,
});

function RolesPage() {
  return (
    <CapabilitiesShell>
      <RoleTemplatesScreen />
    </CapabilitiesShell>
  );
}
