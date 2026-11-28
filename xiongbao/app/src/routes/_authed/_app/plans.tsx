import { createFileRoute } from "@tanstack/react-router";
import { redirectIfMoved } from "@/lib/settings/moves";

/**
 * 套餐与用量搬进了设置（`/settings/plans`，M5b）。原页面剪到了 `components/quota/plans-page.tsx`。
 *
 * `/plans` 这个地址不能断：服务端配额报错里的 `upgradeUrl` 就是它（`server/src/quota/limits.ts`），前端
 * `lib/client.ts` 也按这个契约走，所以保留成重定向。
 */
export const Route = createFileRoute("/_authed/_app/plans")({
  // 去向在 `SETTINGS_MOVES`（U01）。
  beforeLoad: redirectIfMoved,
});
