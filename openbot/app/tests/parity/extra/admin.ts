import type { HostAccessStatus } from "../../../src/lib/computers/host-access";
import type {
  ActionPolicy,
  ComputerFleet,
} from "../../../src/lib/computers/queries";
import type { CredentialStatus } from "../../../src/lib/credentials/queries";
import type {
  ActionRecord,
  EnterpriseOverview,
  ModelUsageRow,
  ModelUsageSummary,
} from "../../../src/lib/enterprise/queries";
import type { IdentityProvider } from "../../../src/lib/identity-providers/queries";
import type { SavedLogin } from "../../../src/lib/passwords/queries";
import type { PeoplePage, Person } from "../../../src/lib/people/queries";
import type { ComposioApp } from "../../../src/lib/plugins/queries";
import type { SandboxedRecord } from "../../../src/lib/sandboxed/queries";
import type { DataFunctionSummary } from "../../../src/lib/components/queries";
import type { Quota, Tier, TokenUsage } from "../../../src/lib/quota/queries";
import { type FixtureRoute, list, ok } from "../fixture-kit";

/**
 * Extra parity fixtures for settings, the admin console, plans and the platform page (see
 * tests/parity/fixture-kit.ts). Every shape follows the real reader in `src/lib/**` (or the route's
 * own type, where the page reads with a bare `fetch`), including the envelope key the reader unwraps.
 */

/* ---------------------------------------------------------------------------------------------- */
/* Plans and usage (src/lib/quota/queries.ts)                                                      */
/* ---------------------------------------------------------------------------------------------- */

const TIERS: Tier[] = [
  {
    id: "free",
    name: "体验版",
    limits: { wakers: 3, tasksPerMonth: 200, devices: 1, customModels: false },
  },
  {
    id: "team",
    name: "团队版",
    limits: {
      wakers: 10,
      tasksPerMonth: 2000,
      devices: 5,
      customModels: true,
    },
  },
  {
    id: "enterprise",
    name: "企业版",
    limits: {
      wakers: 50,
      tasksPerMonth: 20000,
      devices: 30,
      customModels: true,
    },
  },
];

const TOKENS: TokenUsage = {
  period: "2026-11",
  scope: "coworker-calls",
  calls: 1284,
  reportedCalls: 1279,
  partialCalls: 2,
  unknownUsageCalls: 3,
  unsettledCalls: 0,
  inputTokens: 3_812_400,
  outputTokens: 905_310,
  totalTokens: 4_717_710,
  complete: false,
};

const NO_TOKENS: TokenUsage = {
  period: "2026-11",
  scope: "coworker-calls",
  calls: 0,
  reportedCalls: 0,
  partialCalls: 0,
  unknownUsageCalls: 0,
  unsettledCalls: 0,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  complete: true,
};

function quota(data: boolean): Quota {
  const team = TIERS[1]!;
  return {
    plan: { id: team.id, name: team.name },
    limits: team.limits,
    usage: data
      ? { period: "2026-11", wakers: 9, tasks: 1720, devices: 5, models: 2 }
      : { period: "2026-11", wakers: 0, tasks: 0, devices: 0, models: 0 },
    tokens: data ? TOKENS : NO_TOKENS,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Platform (the route's own types in src/routes/_authed/_app/platform.tsx)                        */
/* ---------------------------------------------------------------------------------------------- */

const TENANTS = [
  {
    id: "tenant-demo",
    email: "demo@example.com",
    name: "演示工作空间",
    plan: "团队版",
    wakers: 9,
    activeRoutines: 6,
    suspended: false,
    createdAt: "2026-03-02T02:00:00.000Z",
  },
  {
    id: "tenant-retail",
    email: "it@retail.example.com",
    name: "华东零售",
    plan: "企业版",
    wakers: 31,
    activeRoutines: 22,
    suspended: false,
    createdAt: "2026-05-18T06:30:00.000Z",
  },
  {
    id: "tenant-trial",
    email: "founder@startup.example.com",
    name: null,
    plan: "体验版",
    wakers: 2,
    activeRoutines: 0,
    suspended: true,
    createdAt: "2026-10-21T09:12:00.000Z",
  },
];

const TENANT_USAGE = [
  {
    tenantId: "tenant-demo",
    email: "demo@example.com",
    name: "演示工作空间",
    usage: TOKENS,
  },
  {
    tenantId: "tenant-retail",
    email: "it@retail.example.com",
    name: "华东零售",
    usage: {
      ...TOKENS,
      calls: 8420,
      reportedCalls: 8420,
      partialCalls: 0,
      unknownUsageCalls: 0,
      totalTokens: 28_406_112,
      complete: true,
    },
  },
  {
    tenantId: "tenant-trial",
    email: "founder@startup.example.com",
    name: null,
    usage: NO_TOKENS,
  },
];

/* ---------------------------------------------------------------------------------------------- */
/* Admin console                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

const PEOPLE: Person[] = [
  {
    id: "user-demo",
    email: "demo@example.com",
    name: "演示用户",
    image: null,
    role: "admin",
    providers: ["google"],
    lastSignedInAt: "2026-11-07T01:40:00.000Z",
    revoked: false,
    configuredAdmin: true,
  },
  {
    id: "user-li",
    email: "li.na@example.com",
    name: "李娜",
    image: null,
    role: "admin",
    providers: ["okta"],
    lastSignedInAt: "2026-11-06T09:15:00.000Z",
    revoked: false,
    configuredAdmin: false,
  },
  {
    id: "user-wang",
    email: "wang.qiang@example.com",
    name: "王强",
    image: null,
    role: "user",
    providers: ["okta", "google"],
    lastSignedInAt: "2026-11-05T12:02:00.000Z",
    revoked: false,
    configuredAdmin: false,
  },
  {
    id: "user-chen",
    email: "chen.jing@example.com",
    name: null,
    image: null,
    role: "user",
    providers: ["entra"],
    lastSignedInAt: null,
    revoked: false,
    configuredAdmin: false,
  },
  {
    id: "user-zhao",
    email: "zhao.lei@example.com",
    name: "赵磊",
    image: null,
    role: "user",
    providers: ["google"],
    lastSignedInAt: "2026-09-30T03:20:00.000Z",
    revoked: true,
    configuredAdmin: false,
  },
];

const CREDENTIALS: CredentialStatus[] = [
  {
    id: "cred-anthropic",
    kind: "model",
    provider: "anthropic",
    keyId: "sk-ant-…4f2a",
    metadata: { label: "主模型" },
    revokedAt: null,
  },
  {
    id: "cred-openai",
    kind: "model",
    provider: "openai",
    keyId: "sk-…9c1d",
    metadata: {},
    revokedAt: null,
  },
  {
    id: "cred-feishu",
    kind: "connector",
    provider: "feishu",
    keyId: "cli_a5…e7",
    metadata: {},
    revokedAt: null,
  },
  {
    id: "cred-old",
    kind: "model",
    provider: "deepseek",
    keyId: "sk-…0b3e",
    metadata: {},
    revokedAt: "2026-10-12T08:00:00.000Z",
  },
];

const AUDIT_EVENTS = [
  {
    id: "audit-1",
    actorUserId: null,
    initiatorKind: "person",
    initiatorId: null,
    eventType: "computer.action_allowed",
    targetType: "page",
    targetId: null,
    payload: {
      action: "computer_click",
      bot: "agent-analyst",
      element: { role: "button", name: "导出报表" },
      page: "https://bi.example.com/sales/weekly",
      decision: { allowed: true, rule: "true" },
    },
    createdAt: "2026-11-07T01:52:00.000Z",
  },
  {
    id: "audit-2",
    actorUserId: null,
    initiatorKind: "routine",
    initiatorId: "routine-weekly",
    eventType: "computer.action_refused",
    targetType: "page",
    targetId: null,
    payload: {
      action: "computer_type",
      bot: "agent-ops",
      element: { role: "textbox", name: "生产库连接串" },
      page: "https://console.example.com/db",
      decision: { allowed: false, rule: "deny: 生产数据库" },
    },
    createdAt: "2026-11-07T01:31:00.000Z",
  },
  {
    id: "audit-3",
    actorUserId: null,
    initiatorKind: "person",
    initiatorId: null,
    eventType: "channel.routed",
    targetType: "agent",
    targetId: "agent-support",
    payload: { viaMention: false, reason: "用户在询问退货流程，交给客服处理" },
    createdAt: "2026-11-07T01:12:00.000Z",
  },
  {
    id: "audit-4",
    actorUserId: null,
    initiatorKind: "person",
    initiatorId: null,
    eventType: "mcp.call_succeeded",
    targetType: "mcp_tool",
    targetId: "feishu.send_message",
    payload: { bot: "agent-writer" },
    createdAt: "2026-11-07T00:48:00.000Z",
  },
  {
    id: "audit-5",
    actorUserId: "user-demo",
    initiatorKind: "deployment",
    initiatorId: null,
    eventType: "credential.created",
    targetType: "credential",
    targetId: "anthropic",
    payload: {},
    createdAt: "2026-11-06T09:30:00.000Z",
  },
];

const IDENTITY_PROVIDERS: IdentityProvider[] = [
  {
    providerId: "retail-okta",
    issuer: "https://retail.okta.com",
    domain: "retail.example.com",
    protocol: "saml",
    registeredBy: "演示用户",
  },
  {
    providerId: "group-entra",
    issuer: "https://login.microsoftonline.com/7f1c…/v2.0",
    domain: "group.example.com",
    protocol: "oidc",
    registeredBy: null,
  },
];

const FLEET: ComputerFleet = {
  isolation: "per-person",
  computers: [
    {
      computer: "bot:agent-analyst",
      kind: "bot",
      botId: "agent-analyst",
      running: true,
      startedAt: "2026-11-07T00:10:00.000Z",
      egress: "203.0.113.24",
      updateAvailable: false,
    },
    {
      computer: "bot:agent-ops",
      kind: "bot",
      botId: "agent-ops",
      running: true,
      startedAt: "2026-11-06T22:00:00.000Z",
      egress: "203.0.113.31",
      updateAvailable: true,
    },
    {
      computer: "bot:agent-research",
      kind: "bot",
      botId: "agent-research",
      running: false,
      startedAt: null,
      egress: null,
    },
  ],
};

const HOST_ACCESS: HostAccessStatus = {
  connected: true,
  grants: [
    {
      id: "grant-1",
      botId: "agent-writer",
      actorId: "user-demo",
      displayName: "~/Documents/周报素材",
      ownerName: "演示用户",
      ownerEmail: "demo@example.com",
    },
  ],
  pending: [],
};

const POLICY: ActionPolicy = {
  mode: "dry-run",
  deny: [
    'action == "computer_type" && page.host == "console.example.com"',
    'file.path.startsWith("/etc/")',
  ],
  allow: ['page.host.endsWith(".example.com")'],
};

function enterprise(data: boolean): EnterpriseOverview {
  return {
    capabilities: [
      {
        capability: "useBots",
        title: "使用员工",
        description: "成员可以和员工对话、分派任务。",
        default: true,
        organization: null,
        roles: {},
        groups: {},
      },
      {
        capability: "cloudComputer",
        title: "云端电脑",
        description: "员工可以在云端电脑里操作浏览器和终端。",
        default: true,
        organization: true,
        roles: { user: false },
        groups: data ? { 运营组: true } : {},
      },
      {
        capability: "localComputer",
        title: "本机电脑",
        description: "员工可以通过桌面应用操作成员自己的电脑。",
        default: false,
        organization: false,
        roles: {},
        groups: {},
      },
      {
        capability: "passwordManager",
        title: "密码管理",
        description: "保存网站登录，员工代填时只看得到用户名。",
        default: true,
        organization: null,
        roles: {},
        groups: {},
      },
    ],
    settings: {
      ssoRequired: data,
      actionRecording: true,
      inactiveComputerDays: 14,
      modelAllowlist: {
        enabled: data,
        models: data ? ["claude-sonnet-4-5", "gpt-4.1"] : [],
      },
      mcpAllowlist: { enabled: false, servers: [] },
      skillSharing: false,
      proactiveDailyRuns: 24,
      modelSelection: false,
    },
    groups: data ? ["运营组", "研究组"] : [],
    network: [
      {
        scopeKind: "organization",
        scopeId: "org",
        mode: "defaults_plus_allowlist",
        rules: data
          ? [
              { type: "domain", value: "bi.example.com" },
              { type: "cidr", value: "10.20.0.0/16", ports: "443" },
            ]
          : [],
        locked: false,
        updatedBy: "演示用户",
        updatedAt: "2026-11-01T03:00:00.000Z",
      },
    ],
    defaultDestinations: [
      "api.anthropic.com",
      "pypi.org",
      "registry.npmjs.org",
    ],
    mcpServers: data
      ? [
          {
            id: "feishu",
            title: "飞书",
            url: "https://mcp.feishu.example.com",
            rowIds: ["team:feishu"],
          },
          {
            id: "notion",
            title: "Notion",
            url: "https://mcp.notion.com",
            rowIds: [],
          },
        ]
      : [],
    builtInModel: "claude-sonnet-4-5",
    scim: {
      configured: data,
      connectionId: "scim-default",
      baseUrl: data ? "https://openbot.example.com/api/scim/v2" : null,
      rotating: false,
    },
    otel: { configured: false },
    actionRecordRetentionDays: 90,
  };
}

const MODEL_SUMMARY: ModelUsageSummary[] = [
  {
    model: "claude-sonnet-4-5",
    source: "configured",
    runs: 1102,
    refused: 0,
    people: 4,
    lastUsedAt: "2026-11-07T01:50:00.000Z",
  },
  {
    model: "gpt-4.1",
    source: "observed",
    runs: 172,
    refused: 3,
    people: 2,
    lastUsedAt: "2026-11-06T11:00:00.000Z",
  },
];

const MODEL_RECENT: ModelUsageRow[] = [
  {
    id: "mu-1",
    email: "wang.qiang@example.com",
    agentId: "agent-analyst",
    model: "claude-sonnet-4-5",
    source: "configured",
    allowed: true,
    createdAt: "2026-11-07T01:50:00.000Z",
  },
  {
    id: "mu-2",
    email: "chen.jing@example.com",
    agentId: "agent-research",
    model: "gpt-4.1",
    source: "observed",
    allowed: false,
    createdAt: "2026-11-06T11:00:00.000Z",
  },
];

const ACTION_RECORDS: ActionRecord[] = [
  {
    id: "act-1",
    surface: "cloud",
    botId: "agent-ops",
    toolName: "bash",
    command: "kubectl get pods -n prod",
    outcome: "allowed",
    createdAt: "2026-11-07T01:20:00.000Z",
  },
  {
    id: "act-2",
    surface: "local",
    botId: "agent-writer",
    toolName: "read_file",
    command: "~/Documents/周报素材/10月.xlsx",
    outcome: "allowed",
    createdAt: "2026-11-07T00:55:00.000Z",
  },
];

const SAVED_LOGINS: SavedLogin[] = [
  {
    id: "login-1",
    origin: "https://bi.example.com",
    username: "demo@example.com",
    createdAt: "2026-09-01T02:00:00.000Z",
    updatedAt: "2026-10-15T02:00:00.000Z",
    lastUsedAt: "2026-11-07T01:40:00.000Z",
  },
  {
    id: "login-2",
    origin: "https://crm.example.com",
    username: "support-bot",
    createdAt: "2026-10-03T02:00:00.000Z",
    updatedAt: "2026-10-03T02:00:00.000Z",
    lastUsedAt: null,
  },
];

const COMPOSIO_APPS: ComposioApp[] = [
  {
    slug: "github",
    name: "GitHub",
    description: "读取仓库、议题与合并请求，代员工提交评论。",
    logo: null,
    categories: ["开发"],
    actionCount: 42,
    enabled: true,
  },
  {
    slug: "gmail",
    name: "Gmail",
    description: "读取与起草邮件，按标签整理收件箱。",
    logo: null,
    categories: ["办公"],
    actionCount: 18,
    enabled: false,
  },
  {
    slug: "hubspot",
    name: "HubSpot",
    description: "查询客户、商机与跟进记录。",
    logo: null,
    categories: ["销售"],
    actionCount: 27,
    enabled: false,
  },
];

const SANDBOXED: SandboxedRecord[] = [
  {
    name: "kpi-tile",
    title: "指标卡",
    draftDescription: "一项指标的数值与环比。",
    draftHtml: '<div class="tile"><b>{{label}}</b><span>{{value}}</span></div>',
    draftCss: ".tile{padding:12px;border-radius:12px}",
    draftJsFunctions: "",
    draftArgumentSchema: {
      type: "object",
      properties: { label: { type: "string" }, value: { type: "string" } },
    },
    publishedHtml: null,
    publishedCss: null,
    publishedJsFunctions: null,
    publishedArgumentSchema: null,
    sampleArguments: { label: "本周销售额", value: "¥ 128,400" },
    revision: 3,
    published: false,
    publishedAt: null,
    authoredBy: "user-demo",
    hasUnpublishedChanges: true,
  },
];

const DATA_FUNCTIONS: DataFunctionSummary[] = [
  {
    name: "sales.weekly",
    description: "本周与上周的销售汇总。",
    reads: "BI 数据仓库（只读）",
  },
  {
    name: "orders.status",
    description: "按订单号查询物流进度。",
    reads: "订单系统（只读）",
  },
];

export const EXTRA: FixtureRoute[] = [
  // The directory's text is already Chinese in these fixtures, so nothing is left to translate.
  ["POST", /^\/api\/translations\/lookup$/, () => ok({ zh: {} })],
  // Admin: components, playground, Composio directory
  [
    "GET",
    /^\/api\/plugins\/composio\/apps$/,
    (c) => {
      const q = c.params.get("q")?.toLowerCase() ?? "";
      return ok({
        apps: list(c, COMPOSIO_APPS).filter(
          (app) => !q || app.name.toLowerCase().includes(q),
        ),
      });
    },
  ],
  ["GET", /^\/api\/sandboxed$/, (c) => ok({ components: list(c, SANDBOXED) })],
  [
    "GET",
    /^\/api\/components\/functions$/,
    (c) => ok({ functions: list(c, DATA_FUNCTIONS) }),
  ],

  // Plans
  ["GET", /^\/api\/quota$/, (c) => ok(quota(c.data))],
  ["GET", /^\/api\/quota\/plans$/, () => ok({ plans: TIERS })],

  // Platform
  [
    "GET",
    /^\/api\/platform\/tenants$/,
    (c) => ok({ tenants: list(c, TENANTS) }),
  ],
  [
    "GET",
    /^\/api\/platform\/usage$/,
    (c) =>
      ok({
        period: "2026-11",
        tenants: list(c, TENANT_USAGE),
        nextOffset: null,
      }),
  ],
  [
    "GET",
    /^\/api\/platform\/tenants\/([^/]+)\/audit$/,
    (c) =>
      ok({
        events: list(c, [
          {
            id: "pa-1",
            eventType: "plan.switched",
            targetType: "subscription",
            targetId: "team",
            initiatorKind: "person",
            createdAt: "2026-11-02T03:00:00.000Z",
          },
          {
            id: "pa-2",
            eventType: "credential.created",
            targetType: "credential",
            targetId: "anthropic",
            initiatorKind: "person",
            createdAt: "2026-10-28T08:10:00.000Z",
          },
        ]),
      }),
  ],

  // Settings
  [
    "GET",
    /^\/api\/passwords$/,
    (c) => ok({ passwordManager: true, logins: list(c, SAVED_LOGINS) }),
  ],

  // Admin
  [
    "GET",
    /^\/api\/admin\/people$/,
    (c) => {
      const search = c.params.get("search")?.toLowerCase() ?? "";
      const people = list(c, PEOPLE).filter(
        (person) =>
          !search ||
          person.email.toLowerCase().includes(search) ||
          (person.name ?? "").includes(search),
      );
      return ok({ people, nextCursor: null } satisfies PeoplePage);
    },
  ],
  [
    "GET",
    /^\/api\/admin\/credentials$/,
    (c) => ok({ credentials: list(c, CREDENTIALS) }),
  ],
  [
    "GET",
    /^\/api\/admin\/audit-events$/,
    (c) => {
      const types = c.params.get("eventType")?.split(",");
      const kinds = c.params.get("initiatorKind")?.split(",");
      return ok({
        events: list(c, AUDIT_EVENTS).filter(
          (event) =>
            (!types || types.includes(event.eventType)) &&
            (!kinds || kinds.includes(event.initiatorKind)),
        ),
      });
    },
  ],
  [
    "GET",
    /^\/api\/admin\/identity-providers$/,
    (c) => ok({ providers: list(c, IDENTITY_PROVIDERS) }),
  ],
  ["GET", /^\/api\/admin\/enterprise$/, (c) => ok(enterprise(c.data))],
  [
    "GET",
    /^\/api\/admin\/enterprise\/models\/usage$/,
    (c) =>
      ok({ summary: list(c, MODEL_SUMMARY), recent: list(c, MODEL_RECENT) }),
  ],
  [
    "GET",
    /^\/api\/admin\/enterprise\/actions$/,
    (c) => ok({ actions: list(c, ACTION_RECORDS) }),
  ],
  [
    "GET",
    /^\/api\/computers\/fleet$/,
    (c) => ok({ ...FLEET, computers: list(c, FLEET.computers) }),
  ],
  [
    "GET",
    /^\/api\/host-access$/,
    (c) => ok({ ...HOST_ACCESS, grants: list(c, HOST_ACCESS.grants) }),
  ],
  [
    "GET",
    /^\/api\/computers\/policy$/,
    (c) =>
      ok({
        policy: c.data ? POLICY : { mode: "enforce", deny: [], allow: [] },
      }),
  ],
];
