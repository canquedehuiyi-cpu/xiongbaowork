import { useQuery } from "@tanstack/react-query";
import { linkOptions } from "@tanstack/react-router";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

export type BrokerDirectory = "composio";

/**
 * Where the pages that set up what Bots can reach live: under Admin in the team edition. In the
 * personal one, where there is no Admin, each points at this fork's own page for the same thing:
 * apps under 已连接的账号 in Settings, skills on the 技能 tab of 能力与资源. A page this fork has no
 * personal counterpart for (credentials, computers, the audit trail) goes to Settings. Both editions
 * render the same page components, so every link between those pages goes through here rather than
 * naming `/admin`.
 */
export function managePaths(edition: "team" | "personal") {
  if (edition === "personal") {
    return {
      /** What the list of apps is called where a back button names it. */
      pluginsLabel: "已连接的账号",
      plugins: () => linkOptions({ to: "/settings/connected-accounts" }),
      plugin: (key: string) =>
        linkOptions({ to: "/settings/connected-accounts/$key", params: { key } }),
      // The app's own page for both: there is no page for one tool or one Bot of a connected account.
      pluginTool: (key: string, _tool: string) =>
        linkOptions({ to: "/settings/connected-accounts/$key", params: { key } }),
      pluginBot: (key: string, _agentId: string) =>
        linkOptions({ to: "/settings/connected-accounts/$key", params: { key } }),
      brokerDirectory: (_directory: BrokerDirectory) =>
        linkOptions({ to: "/settings/connected-accounts" }),
      skills: () => linkOptions({ to: "/resources", search: { tab: "skills" } }),
      newSkill: () =>
        linkOptions({ to: "/resources", search: { tab: "skills", new: true } }),
      skill: (slug: string) =>
        linkOptions({ to: "/resources", search: { tab: "skills", edit: slug } }),
      credentialsLabel: "密钥",
      credentials: () => linkOptions({ to: "/settings" }),
      newCredential: () => linkOptions({ to: "/settings" }),
      computers: () => linkOptions({ to: "/settings" }),
      /*
       * What the trail is called, on its page and wherever another page sends a person to it:
       * 活动 where one person reads what their own Bots did, 审计 under Admin, where an admin reviews
       * everybody's Bots for policy.
       */
      auditLabel: "活动",
      audit: () => linkOptions({ to: "/settings" }),
      /** What a sentence calls the product itself: its name alone, "本部署" for an admin. */
      deploymentName: "熊宝数字员工",
      /** Which edition these paths are for, for the sentences that differ beyond a name. */
      edition: "personal" as const,
    };
  }
  return {
    pluginsLabel: "插件",
    plugins: () => linkOptions({ to: "/admin/plugins" }),
    plugin: (key: string) =>
      linkOptions({ to: "/admin/plugins/$key", params: { key } }),
    pluginTool: (key: string, tool: string) =>
      linkOptions({
        to: "/admin/plugins/$key/tools/$tool",
        params: { key, tool },
      }),
    pluginBot: (key: string, agentId: string) =>
      linkOptions({
        to: "/admin/plugins/$key/bots/$agentId",
        params: { key, agentId },
      }),
    brokerDirectory: (_directory: BrokerDirectory) =>
      linkOptions({ to: "/admin/plugins/composio" }),
    skills: () => linkOptions({ to: "/admin/skills" }),
    newSkill: () => linkOptions({ to: "/admin/skills/new" }),
    skill: (slug: string) =>
      linkOptions({ to: "/admin/skills/$slug", params: { slug } }),
    credentialsLabel: "凭据",
    credentials: () => linkOptions({ to: "/admin/credentials" }),
    newCredential: () => linkOptions({ to: "/admin/credentials/new" }),
    computers: () => linkOptions({ to: "/admin/computers" }),
    auditLabel: "审计",
    audit: () => linkOptions({ to: "/admin/audit" }),
    deploymentName: "本部署",
    edition: "team" as const,
  };
}

/** A name from these paths at the start of a sentence: "This deployment", and "OpenBot" as it is. */
export function atStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type ManagePaths = ReturnType<typeof managePaths>;

/**
 * Where an old Admin address goes in the personal edition: an app's page under 已连接的账号, skills on
 * the 技能 tab of 能力与资源, or Settings itself for a page the personal edition does not have.
 */
export function personalAdminRedirect(pathname: string): string {
  if (pathname === "/admin/plugins" || pathname.startsWith("/admin/plugins/")) {
    const key = pathname.slice("/admin/plugins/".length).split("/")[0];
    return key && key !== "composio"
      ? `/settings/connected-accounts/${key}`
      : "/settings/connected-accounts";
  }
  if (pathname === "/admin/skills" || pathname.startsWith("/admin/skills/"))
    return "/resources?tab=skills";
  return "/settings";
}

/**
 * The paths for this deployment. The edition is read once per page load and cached for good, so
 * this is a lookup, not a request; until it answers, the team edition's paths, which are what every
 * deployment from before the switch has.
 */
export function useManagePaths(): ManagePaths {
  const { data } = useQuery(deploymentCapabilitiesQueryOptions());
  return managePaths(data?.edition ?? "team");
}
