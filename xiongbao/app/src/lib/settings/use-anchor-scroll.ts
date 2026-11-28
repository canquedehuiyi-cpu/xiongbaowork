import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * 话题页内容渲染完（`ready`）后，按地址里的 `#锚点` 找同名 `id` 滚过去。找不到就什么也不做：旧地址的锚点
 * 对这个人可能根本不画（受众受限的节），落在页顶即可，不报错。
 */
export function useAnchorScroll(ready: boolean): void {
  const hash = useRouterState({ select: (state) => state.location.hash });
  useEffect(() => {
    if (!ready || !hash) return;
    let id = hash.replace(/^#/, "");
    try {
      id = decodeURIComponent(id);
    } catch {
      // 坏的转义按原样找
    }
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [ready, hash]);
}
