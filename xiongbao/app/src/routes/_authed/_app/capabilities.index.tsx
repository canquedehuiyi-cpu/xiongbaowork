import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/capabilities` on its own opens the first tab. 熊宝默认是插件页签（用户决定），上游是技能。 */
export const Route = createFileRoute("/_authed/_app/capabilities/")({
  beforeLoad: () => {
    throw redirect({ to: "/capabilities/plugins", replace: true });
  },
});
