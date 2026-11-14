import type * as React from "react";
import { Button } from "@/components/ui/button";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import { showSidebarView } from "./sidebar-view";

/**
 * 「去员工列表」: switches the sidebar to 员工, where a new person summons their first employee
 * (召唤员工), and opens the sidebar if it is folded away (on a phone it is a sheet).
 */
export function ShowEmployeesButton({
  className,
  size = "sm",
  variant = "outline",
}: Pick<
  React.ComponentProps<typeof Button>,
  "className" | "size" | "variant"
>) {
  const sidebar = useOptionalSidebar();
  return (
    <Button
      className={className}
      onClick={() => {
        showSidebarView("wakers");
        if (!sidebar) return;
        if (sidebar.isMobile) sidebar.setOpenMobile(true);
        else if (!sidebar.open) sidebar.setOpen(true);
      }}
      size={size}
      type="button"
      variant={variant}
    >
      去员工列表
    </Button>
  );
}
