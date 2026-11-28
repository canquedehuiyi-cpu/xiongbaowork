import { expect } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import { queryClient } from "@/query-client";
import { routeTree } from "@/routeTree.gen";
import { type FixtureAudience, resolveFixture } from "./parity/fixtures";

/*
 * 设置整理的测试夹具：同一套路由树、同一份 parity 数据，按「谁在看」换受众。
 * 用的测试文件自己负责 happy-dom 的注册与清理（`GlobalRegistrator`、`cleanup`、`queryClient.clear()`），
 * 并在 `beforeAll` 里把 `globalThis.WebSocket` 换成 `OfflineWebSocket`。
 */

export type AudienceName =
  | "team-admin"
  | "team-member"
  | "team-member-local"
  | "personal"
  | "unknown-edition";

export const AUDIENCES: readonly AudienceName[] = [
  "team-admin",
  "team-member",
  "team-member-local",
  "personal",
  "unknown-edition",
];

/** 受众名 → parity 夹具的受众。`team-member-local` 和 `unknown-edition` 在 `stubFetchFor` 里再改。 */
const FIXTURE_AUDIENCE: Record<AudienceName, FixtureAudience> = {
  "team-admin": "admin",
  "team-member": "member",
  "team-member-local": "member",
  personal: "personal",
  "unknown-edition": "admin",
};

export class OfflineWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

/**
 * 换掉 `globalThis.fetch`：请求交给 parity 的 `resolveFixture`，`/api/me` 的角色、能力接口的版本与
 * `localEvaluation` 按受众改写；`unknown-edition` = 管理员 + 能力接口 500。夹具没有的请求回 404。
 * 用完由测试自己还原 `fetch`。
 */
export function stubFetchFor(audience: AudienceName): void {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "http://localhost/",
      );
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (
        method.toUpperCase() === "GET" &&
        url.pathname === "/api/capabilities"
      ) {
        if (audience === "unknown-edition") {
          return Response.json(
            { error: "capabilities unavailable" },
            { status: 500 },
          );
        }
      }
      let body: unknown;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = undefined;
        }
      }
      const found = resolveFixture(
        method,
        `${url.pathname}${url.search}`,
        "data",
        body,
        FIXTURE_AUDIENCE[audience],
      );
      if (!found)
        return Response.json({ error: "not served" }, { status: 404 });
      let answer = found.body;
      if (
        audience === "team-member-local" &&
        method.toUpperCase() === "GET" &&
        url.pathname === "/api/capabilities"
      ) {
        answer = { ...(answer as object), localEvaluation: true };
      }
      return Response.json(answer, { status: found.status });
    },
    { preconnect: original.preconnect },
  );
}

/**
 * 按受众走一遍真实路由树（同 `workbench-frame-routes.test.tsx`），等重定向和读取都结束再返回。
 * 不预置当前用户：`/api/me` 经 fetch 桩回答，所以受众的角色是真的读出来的。
 */
export async function renderAt(
  href: string,
  audience: AudienceName,
): Promise<{ container: HTMLElement; finalHref: () => string }> {
  stubFetchFor(audience);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [href] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const finalHref = () => {
    const { pathname, searchStr, hash } = router.state.location;
    return `${pathname}${searchStr}${hash ? `#${hash}` : ""}`;
  };
  // 路由空闲、没有请求在飞，且连续两次采样位置不变：重定向链和受众读取都走完了。
  let last = "";
  await waitFor(
    () => {
      const idle =
        router.state.status === "idle" && queryClient.isFetching() === 0;
      const now = finalHref();
      const stable = idle && now === last;
      last = now;
      expect(stable).toBe(true);
    },
    { timeout: 25000, interval: 60 },
  );
  return { container: view.container, finalHref };
}

/** 容器里所有带 `data-setting-key` 的控制的键（出现几次就返回几次）。 */
export function settingKeysIn(container: Element): string[] {
  return [...container.querySelectorAll("[data-setting-key]")].map(
    (node) => node.getAttribute("data-setting-key") ?? "",
  );
}

/**
 * 这个键在这种受众下该不该出现：按键前缀查表，后续 PR 增补。
 * 目前只有团队版管理员（含读不到版本、按团队版管理员处理）看得到的前缀。
 */
const TEAM_ADMIN_ONLY_PREFIXES = [
  "enterprise.",
  "capability.",
  "approvals.team.",
];

export function keyVisibleFor(key: string, audience: AudienceName): boolean {
  if (TEAM_ADMIN_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return audience === "team-admin" || audience === "unknown-edition";
  }
  return true;
}
