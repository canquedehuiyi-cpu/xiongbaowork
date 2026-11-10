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
  | "teamBots"
  | "ownerApps"
  | "isolatedComputers"
  | "proactive";

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
  /** People may open the Skills learned from their recordings to every Bot. Off by default. */
  skillSharing: boolean;
  /** How many check-ins each Bot may run for one person in a day. 24 by default. */
  proactiveDailyRuns: number;
  /** People may pick the model a built-in Bot answers on, per conversation. Off by default. */
  modelSelection: boolean;
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

/** Why a check-in stopped before the model. */
export type CheckInSkipReason =
  | "off_admin"
  | "off_person"
  | "paused"
  | "capped"
  | "unreachable"
  | "no_sources"
  | "busy";

/**
 * One Bot's check-ins over the window, as the admin's Check-ins page reads them. Counts only: the
 * server sends no titles and no people.
 *
 * `items` are the ones raised in the window, by where each stands now, so `raised` is the sum of the
 * other four. `acceptance` is started out of started and hidden, null until somebody answered one.
 */
export type BotCheckInMetrics = {
  agentId: string;
  name: string;
  avatarSeed: string;
  /** People whose check-ins with this Bot are on now. */
  peopleOn: number;
  runs: {
    quiet: number;
    raised: number;
    failed: number;
    skipped: Record<CheckInSkipReason, number>;
  };
  items: {
    raised: number;
    started: number;
    hidden: number;
    cleared: number;
    open: number;
  };
  acceptance: number | null;
  /** This Bot's items that a ping carried. */
  pinged: number;
};

export type CheckInMetrics = {
  days: 7 | 30;
  /** The daily cap in force. */
  dailyRuns: number;
  bots: BotCheckInMetrics[];
  /** One ping folds every Bot's items for a person, so pings are counted for everybody at once. */
  pings: { sent: number; itemsPerPing: number | null };
};

export const enterpriseKeys = {
  all: ["enterprise"] as const,
  overview: () => ["enterprise", "overview"] as const,
  modelUsage: (days: number) =>
    ["enterprise", "model-usage", { days }] as const,
  actions: () => ["enterprise", "actions"] as const,
  /*
   * Under the enterprise root although the route is `/api/admin/proactive`: who has check-ins on and
   * the cap in force both move when a switch or a setting is saved, and every enterprise write
   * invalidates this root.
   */
  checkIns: (days: 7 | 30) => ["enterprise", "check-ins", { days }] as const,
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

export function checkInMetricsQueryOptions(days: 7 | 30) {
  return queryOptions({
    queryKey: enterpriseKeys.checkIns(days),
    queryFn: async (): Promise<CheckInMetrics> =>
      (
        await client(`/api/admin/proactive?days=${days}`, {
          fallback: "读不到主动巡检",
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

/** The capability switches as they apply to the person asking. */
export type MyCapabilities = {
  capabilities: Partial<Record<CapabilityKey, boolean>>;
  /** False on a deployment running without enterprise controls, where the defaults stand. */
  enforced: boolean;
};

/**
 * What this person may use, which is not an administrator's read.
 *
 * `/me` sits under the enterprise ADMIN prefix and is deliberately the one route there that any
 * signed-in person may call: the switches decide what the app offers them, so the app has to be
 * able to ask. Everything else behind that prefix requires an administrator.
 */
export function myCapabilitiesQueryOptions() {
  return queryOptions({
    queryKey: ["enterprise", "me"] as const,
    queryFn: async (): Promise<MyCapabilities> =>
      (
        await client("/api/admin/enterprise/me", {
          fallback: "读不到熊宝允许做什么。",
        })
      ).json(),
  });
}
