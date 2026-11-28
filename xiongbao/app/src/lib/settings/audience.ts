import { type QueryClient, useQuery } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { editionOf } from "@/lib/edition-guard";
import { mayOpenSetup } from "@/lib/setup/queries";

export type SettingsAudience = {
  edition: "team" | "personal";
  isAdmin: boolean;
  maySetUp: boolean;
  /** 用户与版本两个读取都已结束（成功或失败）。之前受众受限的节一律不画。 */
  ready: boolean;
};

export type SectionAudience = {
  who: "everyone" | "team-admin";
  edition: "both" | "team" | "personal";
};

/** 读不到版本按团队版；`settled` 说明两个读取是否都已结束。 */
export function audienceOf(
  user: { role?: string } | null | undefined,
  capabilities: { edition?: string; localEvaluation?: boolean } | undefined,
  settled: { user: boolean; capabilities: boolean },
): SettingsAudience {
  return {
    edition: capabilities?.edition === "personal" ? "personal" : "team",
    isAdmin: user?.role === "admin",
    maySetUp: mayOpenSetup(
      user,
      capabilities && {
        localEvaluation: capabilities.localEvaluation === true,
      },
    ),
    ready: settled.user && settled.capabilities,
  };
}

export function useSettingsAudience(): SettingsAudience {
  const user = useQuery(currentUserQueryOptions());
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  return audienceOf(user.data, capabilities.data, {
    user: user.isFetched || user.isError,
    capabilities: capabilities.isFetched || capabilities.isError,
  });
}

/** 受众受限的节在 ready 之前返回 false；who/edition 都满足才 true。team-admin 隐含 edition team。 */
export function shows(
  section: SectionAudience,
  audience: SettingsAudience,
): boolean {
  const restricted = section.who !== "everyone" || section.edition !== "both";
  if (restricted && !audience.ready) return false;
  if (
    section.who === "team-admin" &&
    !(audience.edition === "team" && audience.isAdmin)
  ) {
    return false;
  }
  return section.edition === "both" || section.edition === audience.edition;
}

/**
 * 子页守卫：rule 不满足时送回 fallback；team-admin 的页在个人版一律送回 "/settings"。读不到版本按团队版。
 * `team-admin-or-personal`：个人版人人通过，团队版只有管理员。
 */
export function guardSubpage(
  rule: "team-admin" | "personal" | "team-admin-or-personal",
  fallback: string,
) {
  return async ({
    context,
  }: {
    context: { queryClient: QueryClient };
  }): Promise<void> => {
    const { queryClient } = context;
    const edition = await editionOf(queryClient);
    if (rule === "personal") {
      if (edition !== "personal") throw redirect({ to: fallback });
      return;
    }
    if (rule === "team-admin" && edition === "personal") {
      throw redirect({ to: "/settings" });
    }
    if (rule === "team-admin-or-personal" && edition === "personal") return;
    const user = await queryClient
      .ensureQueryData(currentUserQueryOptions())
      .catch(() => null);
    if (user?.role !== "admin") throw redirect({ to: fallback });
  };
}
