import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

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
  /** True for a vendor that gives every customer their own hostname. */
  perInstance: boolean;
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
};

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
};

export type PluginConnections = {
  connections: PluginConnection[];
  redirectUri: string | null;
};

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
 * Composio's app directory, narrowed by a search term.
 *
 * The term goes to our own endpoint because the vendor's client drops a search parameter and
 * answers with an unfiltered page, so filtering has to happen somewhere that admits to doing it.
 */
export function composioAppsQueryOptions(query: string) {
  return queryOptions({
    queryKey: pluginKeys.composioApps(query),
    queryFn: async (): Promise<{ apps: ComposioApp[] }> => {
      const response = await client(
        `/api/plugins/composio/apps?q=${encodeURIComponent(query)}`,
        { fallback: "读不到 Composio 的应用目录。" },
      );
      return response.json();
    },
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
