import { createFileRoute, notFound } from "@tanstack/react-router";
import { redirectIfMoved } from "@/lib/settings/moves";

/**
 * `/admin/*` 下没有页面的地址：先问旧地址表，命中就转走，否则按不存在处理，而不是画一个空页。
 */
export const Route = createFileRoute("/_authed/admin/$")({
  beforeLoad: (opts) => {
    redirectIfMoved(opts);
    throw notFound();
  },
});
