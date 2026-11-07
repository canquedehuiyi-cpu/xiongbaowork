import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type CapabilityKey =
  | "useBots"
  | "cloudBrowser"
  | "cloudNetwork"
  | "cloudComputer"
  | "localComputer"
  | "customRules"
  | "passwordManager"
  | "slackTeams"
  | "teamBots";

/** One switch as the server stored it at each scope. `null` means no row: the scope inherits. */
export type CapabilitySetting = {
  capability: CapabilityKey;
  title: string;
  description: string;
  default: boolean;
  organization: boolean | null;
  roles: Partial<Record<"admin" | "user", boolean>>;
  groups: Record<string, boolean>;
};

export type EgressRule =
  | { type: "domain"; value: string }
  | { type: "cidr"; value: string; ports?: string };

export type NetworkMode =
  | "allow_all"
  | "defaults_plus_allowlist"
  | "allowlist_only";

export type NetworkPolicy = {
  scopeKind: "organization" | "group";
  scopeId: string;
  mode: NetworkMode;
  rules: EgressRule[];
  locked: boolean;
  updatedBy: string | null;
  updatedAt: string;
};

export type EnterpriseSettings = {
  ssoRequired: boolean;
  actionRecording: boolean;
  inactiveComputerDays: number;
  modelAllowlist: { enabled: boolean; models: string[] };
  mcpAllowlist: { enabled: boolean; servers: string[] };
};

export type McpAllowlistServer = {
  id: string;
  title: string;
  url: string;
  rowIds: string[];
};

/**
 * Whether the saved MCP allowlist approves this app. An entry naming one of its rows counts: since
 * G01-E a curated row is `team:<key>`, and this screen used to save the row id, which the server's
 * boundary also reads as approving `<key>`.
 */
export function isMcpServerApproved(
  saved: string[],
  server: Pick<McpAllowlistServer, "id" | "rowIds">,
): boolean {
  return saved.some(
    (entry) => entry === server.id || server.rowIds.includes(entry),
  );
}

/**
 * The allowlist after switching one app on or off. On saves the app key (and leaves an entry that
 * already approves it alone); off removes the key and every row id, so no older entry keeps it approved.
 */
export function withMcpServerApproval(
  saved: string[],
  server: Pick<McpAllowlistServer, "id" | "rowIds">,
  approved: boolean,
): string[] {
  if (approved)
    return isMcpServerApproved(saved, server) ? saved : [...saved, server.id];
  return saved.filter(
    (entry) => entry !== server.id && !server.rowIds.includes(entry),
  );
}

export type EnterpriseOverview = {
  capabilities: CapabilitySetting[];
  settings: EnterpriseSettings;
  groups: string[];
  network: NetworkPolicy[];
  defaultDestinations: string[];
  /** One per app: `id` is the key a tool call names; `rowIds` the server rows behind it. */
  mcpServers: McpAllowlistServer[];
  builtInModel: string | null;
  scim: {
    configured: boolean;
    connectionId: string;
    baseUrl: string | null;
    rotating: boolean;
  };
  otel: { configured: boolean };
  actionRecordRetentionDays: number;
};

export type ModelUsageSummary = {
  model: string;
  source: "configured" | "observed" | "unknown";
  runs: number;
  refused: number;
  people: number;
  lastUsedAt: string;
};

export type ModelUsageRow = {
  id: string;
  email: string | null;
  agentId: string;
  model: string;
  source: string;
  allowed: boolean;
  createdAt: string;
};

export type ActionRecord = {
  id: string;
  surface: "cloud" | "local";
  botId: string | null;
  toolName: string;
  command: string;
  outcome: string;
  createdAt: string;
};

export const enterpriseKeys = {
  all: ["enterprise"] as const,
  overview: () => ["enterprise", "overview"] as const,
  modelUsage: (days: number) =>
    ["enterprise", "model-usage", { days }] as const,
  actions: () => ["enterprise", "actions"] as const,
};

export function enterpriseOverviewQueryOptions() {
  return queryOptions({
    queryKey: enterpriseKeys.overview(),
    queryFn: async (): Promise<EnterpriseOverview> =>
      (
        await client("/api/admin/enterprise", {
          fallback: "读不到企业管控设置",
        })
      ).json(),
  });
}

export function modelUsageQueryOptions(days = 30) {
  return queryOptions({
    queryKey: enterpriseKeys.modelUsage(days),
    queryFn: async (): Promise<{
      summary: ModelUsageSummary[];
      recent: ModelUsageRow[];
    }> =>
      (
        await client(`/api/admin/enterprise/models/usage?days=${days}`, {
          fallback: "读不到模型用量",
        })
      ).json(),
  });
}

export function actionRecordsQueryOptions() {
  return queryOptions({
    queryKey: enterpriseKeys.actions(),
    queryFn: (): Promise<ActionRecord[]> =>
      client("/api/admin/enterprise/actions?limit=50", "actions", {
        fallback: "读不到录制的操作",
      }),
  });
}
