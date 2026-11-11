import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
// This import closes a cycle: `./provider-vocabulary` imports a type from this file (and upstream reads
// `pluginsProvider` from here). It is safe for one reason, and the reason is the rule: the binding
// that crosses it, `directoryReadFailure`, is an `export function` declaration, fully initialised
// during module instantiation, and it is only ever called from inside a `queryFn`, long after both
// modules have finished evaluating. Nothing may call across this import at module scope.
import {
  directoryReadFailure,
  type PluginsProvider,
} from "./provider-vocabulary";

/**
 * Re-exported, not re-declared.
 *
 * The field list is asked for by a POST, so it lives beside its only producer in `./mutations` —
 * a second copy here would be free to drift from the shape that write actually returns.
 */
export type { BrokerField } from "./mutations";

/** A tool one server offers, as the Plugins page sees it. */
export type PluginTool = {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `<serverId>/<name>`. What a grant names. */
  ref: string;
  /** Whether it changes something. Anything not positively known to be a read is a write. */
  effect: "read" | "write";
  /**
   * Whether the vendor warns that it destroys something.
   *
   * Beside {@link effect} rather than folded into it: the rule engine judges reads and writes and
   * gains nothing from a third value, while a person deciding whether to switch an action on is
   * asking a different question. Recorded from the vendor's own labels, so false is an absence of a
   * claim rather than a claim of safety.
   */
  destructive: boolean;
  grantedTo: string[];
};

/**
 * A grant on a tool this server does not currently advertise.
 *
 * Held and not offered: nothing reaches a model, because a Bot is told about a tool only when the
 * grant and the tool list agree. That is a fact about what the vendor advertises today, not about the
 * grant, so it is reported rather than quietly dropped — a connector that starts advertising the name
 * again offers it again.
 */
export type WithdrawnGrant = {
  /** `<serverId>/<toolName>`. What a grant names, and what an administrator revokes. */
  ref: string;
  name: string;
  grantedTo: string[];
};

export type PluginServer = {
  id: string;
  title: string;
  logo?: string | null;
  vendor: string;
  url: string;
  summary: string;
  docsUrl: string;
  /** `first-party` for a reviewed entry, `custom` for one an administrator added by URL. */
  provenance: string;
  hasCredential: boolean;
  toolsRefreshedAt: string | null;
  lastError: string | null;
  addedBy: string | null;
  /**
   * Whether this server registers its own OAuth client (RFC 7591) rather than waiting on an
   * administrator to paste one in.
   */
  dynamicClient: boolean;
  /**
   * How this server's authorization config was CREATED, for the brokered rows that have one.
   *
   * What was written down when somebody enabled the app, not what the catalogue publishes today.
   * The catalogue is the vendor's, and an app it starts advertising under a different scheme has
   * not moved the config this deployment already created — so a screen deciding what a live
   * connection does reads this and never a fresh listing. The vocabulary is the vendor's own scheme
   * literals (`OAUTH2`, `DCR_OAUTH`, `API_KEY`, `NO_AUTH`, and the rest), so it is a string rather
   * than a union this page would have to keep level with Composio's.
   *
   * Null is not an older brokered row. It is a row that is not brokered at all.
   */
  authScheme: string | null;
  /**
   * Whether only an administrator may connect this app (upstream #950). True for an app connected
   * on this deployment's own OAuth client, a server-to-server grant (`S2S_OAUTH2`, Shopify is one):
   * the credential is the deployment's, so an account on it is the organization's access and only an
   * administrator holds one. The server's verdict about the app; whether the person reading is an
   * administrator is theirs to combine it with. The connect route refuses whatever a screen draws.
   */
  adminConnectOnly: boolean;
  /**
   * The Microsoft Entra scope a server added by URL is reached with as the person asking, or null
   * for one reached on the deployment's own token (upstream #931). Optional because a server replica
   * older than this field does not send it, mid-rollout.
   */
  entraScope?: string | null;
  /**
   * Whether this app is PERSONAL, held one credential per person, or SHARED, with a single
   * deployment-held account that every Bot holding a grant acts as (X1 #427).
   *
   * 熊宝服务端只在 broker 行上下发（默认 `personal`），非 broker 行没有这个字段，所以这里是可选的；
   * 上游是必有、可为 null。缺省读作个人账号。
   */
  accountMode?: "personal" | "shared" | null;
  /**
   * 熊宝服务端下发的 Shared 应用团队账号状态（X1 #427）：是否已连接、何时、由谁、是否经过检查。vendor 处的
   * 身份不下发。非 Shared 应用为 null，非 broker 行没有这个字段。
   *
   * 上游把同一件事拆成 `sharedVendorConnected`（服务器上）和连接列表里的 deployment 行
   * （`holder/connected/connectedBy/displayName`）；熊宝服务端不下发那些，读这里。
   */
  sharedAccount?: {
    connected: boolean;
    connectedAt: string | null;
    connectedBy: string | null;
    verified: boolean;
  } | null;
  /**
   * 上游字段：Shared 应用的团队账号是否已连接。**熊宝服务端不下发**，同一个事实在
   * {@link PluginServer.sharedAccount}`.connected`；留成可选只为让恢复的上游组件能编译，读它的地方应改读
   * `sharedAccount`。
   */
  sharedVendorConnected?: boolean;
  /**
   * Whether this app may only hold the deployment's one shared account: it connects on this
   * deployment's own OAuth client (upstream #950's `sharedOnly`). The same judgement as
   * {@link PluginServer.adminConnectOnly}; 熊宝 Personal 模式下管理员仍可以自己的名义连接。Optional:
   * only broker rows carry it, and absent reads as false.
   */
  sharedOnly?: boolean;
  /**
   * Who may give this app to a Bot: any Bot's owner (`any`) or only an admin (`admin`), with the
   * default filled in. **熊宝服务端的列表不下发**（见 x-series-interfaces 第 8 条），由
   * `GET /servers/:id/owner-grants` 单独给出，读 {@link ownerGrantsQueryOptions}。
   */
  ownerGrants?: "any" | "admin";
  /** What an admin chose, or null where the default is in force. 同上，列表不下发。 */
  ownerGrantsChosen?: "any" | "admin" | null;
  /**
   * What the last refresh left out for its names. A warning: the rest were stored. **熊宝服务端不下发**；
   * optional, as upstream's is for an older replica.
   */
  skippedTools?: string[];
  tools: PluginTool[];
  /** Empty for a healthy connector. See {@link WithdrawnGrant}. */
  withdrawn: WithdrawnGrant[];
};

export type PluginSkill = {
  id: string;
  slug: string;
  /** Whose it is. Null means the deployment's: an administrator looks after it. */
  ownerUserId: string | null;
  title: string;
  summary: string;
  instructions: string;
  origin: string;
  installedBy: string | null;
  grantedTo: string[];
  /**
   * The tools this skill says it needs, as `<serverId>/<toolName>` refs.
   *
   * A declaration, not a grant, and the difference is the whole reason anybody may write a skill:
   * naming a tool here cannot make it callable. Selection intersects this with what the Bot was
   * granted, so a skill naming a tool its Bot does not hold selects the skill and loads nothing.
   * `grantedTo` on the tool side is what decides.
   */
  tools: string[];
};

export type CatalogueItem = {
  key: string;
  title: string;
  vendor: string;
  summary: string;
  docsUrl: string;
  /**
   * Whose credential reaches this server.
   *
   * `deployment-bearer` is a token an administrator holds for everybody, and the only one this page
   * can collect. `user-oauth` is reached as whoever is asking, so each person connects their own
   * account and there is no token to type here. `builtin` is a first-party capability that runs
   * inside this deployment — there is nothing to connect and nothing to type.
   */
  auth: "none" | "deployment-bearer" | "user-oauth" | "builtin";
  /**
   * What to call the deployment credential, for a vendor that takes it somewhere other than a
   * bearer header — a Web 服务 Key in a query parameter, a 专属地址 that is itself the credential.
   * Absent for an ordinary bearer token, which keeps the page's own "访问令牌". Reviewed copy from
   * the catalogue, never a value.
   */
  credentialLabel?: string;
  /** Where that credential comes from, in a sentence. Present exactly when the label is. */
  credentialHint?: string;
  /** True for a vendor that gives every customer their own hostname. */
  perInstance: boolean;
  /**
   * Whether connecting needs nothing typed first: no account, or an OAuth vendor the deployment
   * registers itself with. Optional so an older server's answer still reads, as "no".
   * **熊宝服务端不下发**。
   */
  oneStep?: boolean;
};

/** One app in Composio's directory, as the picker shows it. */
export type ComposioApp = {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  /** The size of the decision, shown before enabling. */
  actionCount: number;
  enabled: boolean;
  /**
   * How a person connects it, as the server decided from what the app publishes. Only the part
   * this page reads: an app on this deployment's own client (upstream #950) arrives as
   * `{ kind: "fields", authScheme: "S2S_OAUTH2" }` once its client is saved, and is hidden until then.
   */
  connection?: { kind: string; authScheme?: string };
};

/**
 * One OAuth client this deployment holds for a brokered app that connects server to server
 * (upstream #950; Shopify is one). The id and when it was saved; the secret is never read back.
 * `clientId` and `storedAt` are null for a client whose record carries neither.
 */
export type DeploymentClient = {
  toolkit: string;
  clientId: string | null;
  storedAt: string | null;
};

export type PluginsPage = {
  catalogue: CatalogueItem[];
  servers: PluginServer[];
  skills: PluginSkill[];
  /**
   * Whether a Bot holding no credential of its own can still call a tool back.
   *
   * True when the deployment has a shared secret configured for it. A grant decides whether a tool
   * is offered to a model at all; this decides whether the call it makes can be authenticated. With
   * neither this nor a credential issued to the Bot, every call is refused before it reaches the
   * grant, the boundary or the audit trail, which is not something a grant switch can show.
   */
  botsMayCallBack: boolean;
  /**
   * The redirect URI to register with a `user-oauth` vendor, exactly as this deployment will send it.
   *
   * From the server rather than assembled here, because it has to match what was registered
   * character for character. Null when the deployment has no public URL and so cannot complete a
   * consent flow at all.
   */
  redirectUri: string | null;
  /**
   * Whether this deployment has Composio configured.
   *
   * A boolean about configuration and never the key: the page needs to know whether the directory
   * can be browsed at all, and that question is answerable without the API key ever leaving the
   * server.
   */
  composioConfigured: boolean;
  /**
   * Whether this deployment's broker authorizes ONE ACTION AT A TIME (Arcade's per-action grant
   * list). A declared capability, read with a presence test and never a vendor name.
   *
   * 上游必有；**熊宝服务端的 `GET /api/plugins` 不下发**（逐个动作授权不在 X5），所以是可选的，缺省读作 false。
   */
  authorizesPerAction?: boolean;
  /**
   * Which vendor brokers this deployment's apps, as a NAME. Read it through {@link pluginsProvider}.
   * Optional because a payload from an older server does not carry it. **熊宝服务端不下发**。
   */
  provider?: PluginsProvider;
};

/**
 * The provider a payload names, `"composio"` when the server did not say.
 *
 * So a Composio deployment renders byte-identically and a page served by an older server does not
 * blank. Also `"composio"` before the page has loaded.
 */
export function pluginsProvider(page: PluginsPage | undefined): PluginsProvider {
  return page?.provider ?? "composio";
}

/** What one Bot holds, which is all the runtime needs to offer it. */
export type GrantedPlugins = {
  tools: {
    ref: string;
    toolName: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
  skills: {
    slug: string;
    title: string;
    summary: string;
    instructions: string;
  }[];
};

export const pluginKeys = {
  all: ["plugins"] as const,
  page: () => ["plugins", "page"] as const,
  forAgent: (agentId: string) => ["plugins", "for-agent", agentId] as const,
  connections: () => ["plugins", "connections"] as const,
  composioApps: (query: string) =>
    ["plugins", "composio", "apps", query] as const,
  siblings: (serverId: string) => ["plugins", "siblings", serverId] as const,
  accounts: (serverId: string) => ["plugins", "accounts", serverId] as const,
  ownerGrants: (serverId: string) =>
    ["plugins", "owner-grants", serverId] as const,
  deploymentClients: () => ["plugins", "composio", "clients"] as const,
  listings: () => ["plugins", "listings"] as const,
  installedByMe: (agentId: string) =>
    ["plugins", "installed-by-me", agentId] as const,
};

/**
 * Spec E3: one catalogue entry an administrator has listed (上架) for owners to install themselves.
 *
 * `ref` is an app's key for `mcp` (the listing covers every tool that app offers, and a grant still
 * names `<key>/<tool>`) and a deployment skill's slug for `skill`. `listedBy` is sent to an
 * administrator only: which operator listed an entry is not every workspace's business.
 */
export type InstallListing = {
  kind: "mcp" | "skill";
  ref: string;
  listedAt: string | null;
  listedBy?: string;
};

/**
 * What an administrator has listed, read on its own from `GET /api/plugins/listings`.
 *
 * Under the `plugins` key, so every plugin write's refetch (including listing and unlisting) redraws
 * it. A body without a list reads as nothing listed, which is the same answer the server gives for
 * a deployment where nobody has listed anything; a request that fails is still an error.
 */
export function installListingsQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.listings(),
    queryFn: async (): Promise<InstallListing[]> => {
      const response = await client("/api/plugins/listings", {
        fallback: "读不到上架目录。",
      });
      const body = (await response.json()) as { listings?: unknown };
      return Array.isArray(body.listings)
        ? (body.listings as InstallListing[])
        : [];
    },
  });
}

/** The refs of one kind that are listed, for the screens that only ask "is this one listed?". */
export function listedRefs(
  listings: InstallListing[] | undefined,
  kind: InstallListing["kind"],
): Set<string> {
  return new Set(
    (listings ?? [])
      .filter((listing) => listing.kind === kind)
      .map((listing) => listing.ref),
  );
}

/**
 * The name grants and listings call this app by.
 *
 * Not `server.id`. Since G01-E a curated connector is the team's row `team:<catalogue key>`, while a
 * grant ref (`<app>/<tool>`), a listing and the self-install check all name the catalogue key; a row
 * that is not a catalogue entry is called by its own id. Read off the refs the server composed for
 * this row, which are the names `plugin_grants` stores, and only without any from the row id itself.
 */
export function appKeyOf(server: PluginServer): string {
  const ref = server.tools[0]?.ref ?? server.withdrawn[0]?.ref;
  const slash = ref?.indexOf("/") ?? -1;
  if (ref && slash > 0) return ref.slice(0, slash);
  return server.id.startsWith("team:") ? server.id.slice(5) : server.id;
}

/**
 * The tools and skills on one Waker that this person installed themselves (spec E3).
 *
 * What they may still take off after an administrator unlists the entry: the server lets the person
 * who installed a grant remove it, and nobody else but an administrator.
 */
export function installedByMeQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: pluginKeys.installedByMe(agentId),
    enabled: agentId.length > 0,
    queryFn: async (): Promise<{ tools: string[]; skills: string[] }> => {
      const response = await client(
        `/api/plugins/for/${encodeURIComponent(agentId)}/installed-by-me`,
        { fallback: "读不到你自己装上的工具。" },
      );
      const body = (await response.json()) as {
        tools?: unknown;
        skills?: unknown;
      };
      const strings = (value: unknown) =>
        Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [];
      return { tools: strings(body.tools), skills: strings(body.skills) };
    },
  });
}

/**
 * One account this person has connected, from their own point of view.
 *
 * DELIBERATELY NON-UNIFORM, because `/api/plugins/connections` concatenates two reads: connections
 * held in this deployment's own vault, and brokered ones Composio keeps on our behalf. The fields a
 * settings row draws from — the server id, the scope, the date — line up across both, which is why
 * one type covers both. The pair below does not, so it is optional rather than required: making it
 * required would be a lie the compiler then enforced on every held row.
 */
export type PluginConnection = {
  serverId: string;
  /** What the vendor actually granted, which is not always what was asked for. Empty for brokered. */
  scope: string;
  connectedAt: string;
  /**
   * Whether a real call was last made with this credential, present only on a BROKERED row.
   *
   * Only a brokered row has anything to re-check: this deployment holds no secret for it, only a
   * note that Composio said yes, and that note can drift when somebody ends the connection in
   * Composio's own dashboard. A held connection has no equivalent question, so its rows carry
   * neither field, and the absence of the pair is what tells the two READS apart — nothing more.
   *
   * It is NOT how a reader learns how an app connects. That comes from {@link PluginServer.authScheme}
   * on the server, and a page deriving it from a connection row instead would be a second answer to
   * a question already carried.
   */
  verified?: boolean;
  /**
   * When {@link PluginConnection.verified} was last earned, present only on a brokered row.
   *
   * Null is reachable and means never checked, which is why it stays null rather than collapsing
   * the way `connectedAt` does. For the rows an older migration backfilled it is the moment of
   * consent rather than of a probe, so it is not read as "this connection answered then".
   */
  verifiedAt?: string | null;
  /**
   * Which action the last check of this key actually SPENT, present only on a brokered row.
   *
   * A RECORD READ OFF THE ROW, not a reading of what the app publishes now — which is why it
   * survives a reload where the answer to a connect or a re-check cannot, and why nothing the
   * catalogue does afterwards can move it. Read together with {@link PluginConnection.verified} it
   * separates the three situations that share the one word `false`: no probe means nothing was
   * tried, because at the time of the check the app published nothing safe to spend a key on; a
   * probe with `verified` means the check ran and passed; and a probe WITHOUT it means the check
   * ran and the vendor refused the key, over an account that is still standing.
   *
   * A PAST TENSE, AND ONLY THAT. It is what the SENTENCE beneath the row is drawn from. What it
   * must never be asked is whether the key could be checked again — see
   * {@link PluginConnection.checkable}, which is the present-tense answer and a different field
   * because it is a different question.
   *
   * Optional for the same reason the pair above is: that endpoint concatenates two reads, and only
   * the brokered one carries any of this. Undefined is the absence of the field and not a fourth
   * state.
   */
  probe?: string | null;
  /**
   * Whether the app has anything to check this key against TODAY, present only on a brokered row.
   *
   * ASKED OF THE APP AND NOT OF THE CONNECTION, out of the same chooser a real check would use: has
   * this app published an action safe to spend somebody's key on — a vendor-labelled read, not
   * destructive, needing no arguments, recorded at a version that can be called. It is what the
   * Re-check button is drawn from, and nothing else here is.
   *
   * SEPARATE FROM {@link PluginConnection.probe} BECAUSE COLLAPSING THEM DEADLOCKS THE PAGE. While
   * the button read the record, a key connected to an app with nothing to try recorded null, for
   * good — and the button stayed withheld however much the app published later, though pressing it
   * is the only thing that could ever put an action in the record. The past and the present are two
   * questions; the row asks them separately and answers them separately.
   *
   * Optional for the same reason as the fields above, and false and absent mean the same thing to
   * the only reader there is: nothing to press. That is why a screen may flatten this where it
   * passes `probe` through unflattened — a missing verdict and a null verdict are different
   * sentences, while a missing gate and a closed gate are the same gate.
   */
  checkable?: boolean;
  /**
   * Whose account this row is: the signed-in person's own, or the one standing account of a Shared
   * app. Undefined reads as `"person"` — see {@link personalConnections}.
   *
   * 上游字段；**熊宝服务端不下发**：团队账号的状态记在应用行上（{@link PluginServer.sharedAccount}），连接
   * 列表里只有本人的行。下面三项同理。
   */
  holder?: "person" | "deployment";
  /** Whether the deployment's one shared account is connected, on a DEPLOYMENT row. 熊宝不下发。 */
  connected?: boolean;
  /** The email of whoever connected the shared account, on a DEPLOYMENT row. 熊宝不下发。 */
  connectedBy?: string | null;
  /** The vendor's own name for the connected account, on a DEPLOYMENT row. 熊宝不下发。 */
  displayName?: string | null;
};

export type PluginConnections = {
  connections: PluginConnection[];
  redirectUri: string | null;
};

/**
 * The connections that are the signed-in person's own. A Shared app's row is the deployment's, and
 * every screen that asks "is this mine" must never read it as yes.
 *
 * 熊宝服务端的连接列表里只有本人的行（团队账号记在应用行上），所以这道筛选眼下什么也不筛；照上游写，规则
 * 只有这一处。
 */
export function personalConnections(
  rows: PluginConnection[],
): PluginConnection[] {
  return rows.filter((row) => row.holder !== "deployment");
}

/**
 * The signed-in person's own connections.
 *
 * There is no version of this scoped to anybody else: the endpoint answers for whoever is asking,
 * so a page cannot accidentally render somebody else's.
 */
export function connectionsQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.connections(),
    queryFn: async (): Promise<PluginConnections> => {
      const response = await client("/api/plugins/connections", {
        fallback: "读不到你已连接的账号。",
      });
      return response.json();
    },
  });
}

export function pluginsPageQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.page(),
    queryFn: async (): Promise<PluginsPage> => {
      const response = await client("/api/plugins", {
        fallback: "读不到插件。",
      });
      return response.json();
    },
  });
}

/**
 * What disconnecting this app would also end, as the server computed it.
 *
 * `siblings` are other apps' toolkit names (never this one) and `unanswered` is a COUNT of apps that
 * could not be asked about. A deployment whose broker holds one account per app always answers
 * empty.
 */
export type ConnectionSiblings = { siblings: string[]; unanswered: number };

/**
 * 上游 #1298 的 `GET /api/plugins/servers/:id/connection/siblings`。**熊宝服务端没有这个接口**（Arcade 断开时
 * 只在 `DELETE .../connection` 的回应里带 `siblings`），请求会 404；留着只为恢复的上游组件能编译，接线时
 * 由连接组决定去留。
 */
export function connectionSiblingsQueryOptions(serverId: string) {
  return queryOptions({
    queryKey: pluginKeys.siblings(serverId),
    queryFn: async (): Promise<ConnectionSiblings> => {
      const response = await client(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/connection/siblings`,
        { fallback: "读不到还有哪些应用共用这个连接。" },
      );
      const body: Partial<ConnectionSiblings> = await response.json();
      /*
       * NARROWED RATHER THAN TRUSTED: an answer that is not this shape is read as "nothing to say",
       * which draws no warning, rather than a throw that takes the whole page down for a sentence.
       */
      return {
        siblings: Array.isArray(body.siblings) ? body.siblings : [],
        unanswered:
          typeof body.unanswered === "number" && body.unanswered > 0
            ? body.unanswered
            : 0,
      };
    },
  });
}

/**
 * The active broker's app directory, narrowed by a search term.
 *
 * The term goes to our own endpoint because the vendor's client drops a search parameter and
 * answers with an unfiltered page, so filtering has to happen somewhere that admits to doing it.
 * `provider` only words the failure; 缺省 composio，和 {@link pluginsProvider} 一样。
 */
export function composioAppsQueryOptions(
  query: string,
  provider: PluginsProvider = "composio",
) {
  return queryOptions({
    queryKey: pluginKeys.composioApps(query),
    queryFn: async (): Promise<{ apps: ComposioApp[] }> => {
      const response = await client(
        `/api/plugins/composio/apps?q=${encodeURIComponent(query)}`,
        { fallback: directoryReadFailure(provider) },
      );
      return response.json();
    },
  });
}

/**
 * The OAuth clients this deployment holds for server-to-server apps. Administrators only.
 *
 * Under the `plugins` key, so saving or removing one refetches the directory too: an app on such a
 * client appears there only once its client is saved.
 */
export function deploymentClientsQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.deploymentClients(),
    queryFn: (): Promise<DeploymentClient[]> =>
      client("/api/plugins/composio/clients", "clients", {
        fallback: "读不到部署专属客户端。",
      }),
  });
}

/**
 * Polled grant snapshot for what the active Bot should be offered; call-time checks still enforce.
 */
export function agentPluginsQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: pluginKeys.forAgent(agentId),
    enabled: agentId.length > 0,
    refetchInterval: 15_000,
    queryFn: async (): Promise<GrantedPlugins> => {
      const response = await client(
        `/api/plugins/for/${encodeURIComponent(agentId)}`,
        { fallback: "读不到这位员工的插件。" },
      );
      return response.json();
    },
  });
}

/** One of the signed-in person's accounts at an app, as `/servers/:id/accounts` answers it. */
export type BrokeredAccountRecord = {
  /** Which account a Disconnect or Make default press is about. Opaque. */
  id: string;
  /** What the app says the account is: an email address or a login. Null where it said none. */
  identity: string | null;
  /** What the person and their Bots call it: the identity, or「账号 N」where there is none. */
  label: string;
  /** The account a Bot uses when it doesn't name one. */
  isDefault: boolean;
  connectedAt: string | null;
};

export type BrokeredAccounts = {
  accounts: BrokeredAccountRecord[];
  /** Whether this app can take another account beside the ones listed. The server decides. */
  canAddAnother: boolean;
};

/**
 * The person's own accounts at one brokered app (X1 `GET /api/plugins/servers/:id/accounts`). The
 * server asks the app each time, so an account connected or ended elsewhere is listed as it stands.
 * 键在 `["plugins"]` 之下，所以每一次插件写入的 `invalidatePlugins` 都会刷新它。
 */
export function brokeredAccountsQueryOptions(serverId: string) {
  return queryOptions({
    queryKey: pluginKeys.accounts(serverId),
    queryFn: async (): Promise<BrokeredAccounts> => {
      const response = await client(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/accounts`,
        { fallback: "没能列出你的账号。请刷新页面。" },
      );
      const body = (await response.json()) as {
        accounts?: unknown;
        canAddAnother?: unknown;
      };
      return {
        accounts: Array.isArray(body.accounts)
          ? (body.accounts as BrokeredAccountRecord[])
          : [],
        canAddAnother: body.canAddAnother === true,
      };
    },
  });
}

/** Who may give an app to a Bot, as `GET /servers/:id/owner-grants` answers it (X3). */
export type OwnerGrants = {
  ownerGrants: "any" | "admin";
  /** What an admin chose, or null where the default is in force. */
  chosen: "any" | "admin" | null;
};

/**
 * 熊宝服务端把「主人可授予」单独放在 `GET /api/plugins/servers/:id/owner-grants`（服务器列表不带
 * `ownerGrants`/`ownerGrantsChosen`，x-series-interfaces 第 8 条）。没有这个应用时 404。写入是
 * `./mutations` 里的 owner-grants mutation，同在 `["plugins"]` 键下，写完一起刷新。
 */
export function ownerGrantsQueryOptions(serverId: string) {
  return queryOptions({
    queryKey: pluginKeys.ownerGrants(serverId),
    queryFn: async (): Promise<OwnerGrants> => {
      const response = await client(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/owner-grants`,
        { fallback: "读不到谁能把这个应用交给员工。" },
      );
      const body = (await response.json()) as Partial<OwnerGrants>;
      return {
        ownerGrants: body.ownerGrants === "any" ? "any" : "admin",
        chosen:
          body.chosen === "any" || body.chosen === "admin" ? body.chosen : null,
      };
    },
  });
}
