/**
 * The enterprise controls, installed once per API server and enforced at the existing boundaries.
 *
 * WHERE EACH SWITCH IS ENFORCED (all fail closed):
 *
 * - The computer boundary (`evaluateActionPolicy`, through {@link setPolicyOverlay}): every browser,
 *   shell, file and MCP action a Bot takes. Use Bots, Cloud browser use, Cloud computer use, Cloud
 *   network access, the network policy for navigations, and the MCP allowlist.
 * - The HTTP gate (`admin/gate.ts`), in front of the routes a member uses: starting a run, publishing
 *   a Team Bot, granting a folder on their own machine, connecting Slack or Teams, saving a custom
 *   rule, using the password manager, and the model allowlist.
 * - The stores themselves, wrapped in place ({@link guardDeliveryStore}, {@link guardHostAccess}),
 *   so a path that never crosses the HTTP gate (a Bot's own tool call, OpenTag pairing) is refused
 *   the same way.
 *
 * The computer boundary is synchronous, so it answers from a snapshot of the rows held here and kept
 * current by LISTEN/NOTIFY on {@link ENTERPRISE_TOPIC} plus a one-minute re-read. A snapshot that
 * never loaded refuses everything it is asked about. Every async check reads the database fresh.
 */

import { isPersonBrowserId } from "@openbot/shared/openbot-browser";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import postgres from "postgres";
import { ownerTenantOfBot } from "../agents/bot-owner";
import {
  type AuditStore,
  addAuditTap,
  DEPLOYMENT_INITIATOR,
  recordAuditEvent,
} from "../audit";
import { isConfiguredAdmin } from "../auth/roles";
import { type ComputerKey, computerKeyText } from "../computer/computer-key";
import {
  type PolicyContext,
  type PolicyDecision,
  setPolicyOverlay,
} from "../computer/policy";
import {
  deliverEgressPolicies,
  type EgressPolicy,
  effectiveNetworkPolicy,
  egressDecision,
  pushEgressPolicies,
} from "../computer/policy-network";
import type { ComputerProvider } from "../computer/provider";
import type { Database } from "../db/client";
import { agentProfiles, agents, mcpServers } from "../db/schema";
import { boundModelName } from "../models/runtime-resolver";
import type { ProactiveAdmin } from "../proactive/contracts";
import { createOtelEventExporter, type EventExporter } from "../telemetry/otel";
import { scrubCommand } from "../telemetry/scrub";
import { isPersonTenant, runAsTenant } from "../tenant/context";
import type { WebBotAuth } from "../web-bot-auth";
import { lastUsedByComputer, runningComputers } from "../work/culler";
import {
  type Capability,
  type CapabilityAnswer,
  type CapabilityRow,
  capabilityRefusal,
  DEFAULT_CAPABILITIES,
  type Member,
  resolveAllCapabilities,
  resolveCapability,
} from "./capabilities";
import {
  createEnterpriseStore,
  DEFAULT_ENTERPRISE_SETTINGS,
  ENTERPRISE_TOPIC,
  type EnterpriseSettings,
  type EnterpriseStore,
  type NetworkPolicyRow,
} from "./settings-store";

/** Action Recording keeps 90 days, as Grok Bot's does. */
export const ACTION_RECORD_RETENTION_DAYS = 90;

type Snapshot = {
  rows: CapabilityRow[];
  admins: Set<string>;
  groupsByUser: Map<string, string[]>;
  settings: EnterpriseSettings;
  network: NetworkPolicyRow[];
  /**
   * The app each server-row id on the MCP allowlist instantiates (`team:notion` → `notion`), read
   * from `mcp_servers.catalogue_key`. Only rows with a key: a custom server's id is its own name.
   */
  mcpAppOfRow: Map<string, string>;
  loadedAt: Date;
};

export type EnterpriseDeps = {
  database: Database;
  databaseUrl: string;
  auditStore: AuditStore;
  provider?: ComputerProvider;
  computerToken?: string;
  /** Where a person's own OpenBot browser may go (browser/egress.ts): pushed to it instead of a Bot's policy, which says
   * where Bots may go. Absent, a person's browser is pushed `deny_all`, the answer for a computer with no policy. */
  personBrowserPolicy?: EgressPolicy;
  /**
   * A Bot's policy as it must be for now, from the one its owner is under: wider while a person records in the Bot's
   * browser, so the Recorder there reaches OpenBot and the gateway (browser/bot-browser.ts), and the Bot's own once
   * nobody does. Applied to every push of a Bot's policy, the periodic one and the push on wake, so neither takes the
   * Recorder's way out away mid-recording, and neither leaves it to the Bot afterwards. Absent: the owner's policy.
   */
  duringRecording?: (
    botId: string,
    policy: EgressPolicy,
  ) => Promise<EgressPolicy>;
  /** Pushed to every computer with its policy; see `computer/policy-network.ts`. */
  webBotAuth?: WebBotAuth;
  /** `provider/model` the built-in Bot runs on, for the model allowlist and usage view. */
  builtInModel?: string;
  /**
   * The library model a built-in Bot's run will actually speak, named by the same resolver that builds
   * it — `null` when the run falls back to {@link builtInModel} (no binding, or a binding whose key is
   * revoked or will not decrypt). Absent, the rows alone are read ({@link boundModelName}), which
   * cannot tell a key that will not decrypt.
   */
  agentModelName?: (agentId: string) => Promise<string | null>;
  /**
   * The model a person picked for the conversation behind a thread, when there is one they may use
   * (`channels/model-choice.ts`). A built-in run in that thread answers on it, so it is the model
   * the allowlist judges and the usage row names.
   */
  pickedModel?: (
    actorId: string,
    threadId: string,
  ) => Promise<string | undefined>;
  /** Offboarding: ends sessions and deny-lists, and retires what a person granted. */
  people?: {
    revoke: (userId: string, by: string) => Promise<void>;
    retireOwned: (userId: string, by: string) => Promise<void>;
    restore: (userId: string) => Promise<void>;
  };
  initialAdminEmails?: readonly string[];
  /**
   * The people's browsers' Recorders (recorder/wiring.ts): who holds a live connection, and the sign-out that ends a
   * person's. Turning SSO-required on ends them for the people it signs out. Absent where there is no Recorder.
   */
  recorders?: {
    holders: () => Promise<string[]>;
    signOut: (userId: string, ending: string) => Promise<void>;
  };
  env?: Record<string, string | undefined>;
  /** Optional typed clock seam; production keeps the native interval implementation. */
  clock?: {
    scheduleInterval: (
      callback: () => void,
      milliseconds: number,
    ) => ReturnType<typeof setInterval>;
    cancelInterval: (timer: ReturnType<typeof setInterval>) => void;
  };
};

export type EnterpriseControls = {
  store: EnterpriseStore;
  deps: EnterpriseDeps;
  exporter: EventExporter | undefined;
  snapshot: () => Snapshot | undefined;
  refresh: () => Promise<void>;
  capabilityFor: (userId: string, capability: Capability) => Promise<boolean>;
  capabilitiesFor: (userId: string) => Promise<Record<Capability, boolean>>;
  terminateMemberComputers: (
    userId: string,
    by: { id?: string; email: string },
  ) => Promise<{
    /** The computers stopped: `person:<id>`, and `bot:<id>` for each of their isolated Bots. */
    stopped: string[];
    failed: { computer: string; reason: string }[];
  }>;
  terminateInactiveComputers: () => Promise<{ stopped: string[] } | null>;
  pushNetworkPolicies: () => Promise<void>;
  policyForBot: (botId: string) => Promise<EgressPolicy>;
  /**
   * Whose network policy a Bot's computer is under: its owner, as a member with their groups, and
   * whether their "Cloud network access" capability is on. The lookup `policyForBot` makes, for a
   * replay of a candidate policy (admin/network-replay.ts). Undefined until the controls have read
   * their settings.
   */
  networkMemberFor: (
    botId: string,
  ) => Promise<{ member: Member; cloudNetwork: boolean } | undefined>;
  offboard: (userId: string, by: string) => Promise<void>;
  stop: () => Promise<void>;
};

let installed: EnterpriseControls | undefined;
let initializing: Promise<EnterpriseControls> | undefined;

/** The running controls, or undefined in a test or a script that never installed them. */
export function enterpriseControls(): EnterpriseControls | undefined {
  return installed;
}

/**
 * Skill sharing (Admin, Automatic learning): whether people may open their Skills to every Bot. Off until the
 * controls have read it, like every switch here. For a person's change, read fresh from the database.
 */
export async function skillSharingAllowed(): Promise<boolean> {
  return (await installed?.store.settings())?.skillSharing === true;
}

/**
 * The same switch for a run, from the snapshot: every replica refreshes it the moment an administrator saves
 * (LISTEN/NOTIFY), so a run pays no query for it.
 */
export function skillSharingInSnapshot(): boolean {
  return installed?.snapshot()?.settings.skillSharing === true;
}

function refusal(matched: string, reason: string): PolicyDecision {
  return {
    allowed: false,
    mode: "enforce",
    matched,
    source: "deny",
    forward: false,
    reason,
  };
}

const COMPUTER_INTENTS = new Set([
  "read_file",
  "write_file",
  "list_files",
  "download_file",
  "run_command",
]);

function memberFrom(snapshot: Snapshot, userId: string): Member {
  return {
    role: snapshot.admins.has(userId) ? "admin" : "user",
    groups: snapshot.groupsByUser.get(userId) ?? [],
  };
}

/**
 * The overlay the computer boundary asks first. Exported for tests.
 */
export function decideFromSnapshot(
  snapshot: Snapshot | undefined,
  context: PolicyContext,
): PolicyDecision | null {
  // The first refusal, and nothing past it is worked out: a generator stops where this stops.
  for (const check of enterpriseChecks(snapshot, context))
    if (check.refusal) return check.refusal;
  return null;
}

/** The snapshot the computer boundary answers from, for a reader outside this module. */
export type EnterpriseSnapshot = Snapshot;

/** The snapshot as {@link installEnterpriseControls} reads it, for a reader that needs one now. */
export const loadEnterpriseSnapshot = (
  store: EnterpriseStore,
  database: Database,
) => loadSnapshot(store, database);

/**
 * One switch the overlay looked at, what it found, and the refusal it makes, if any. In the order the
 * overlay looks at them, which is the order {@link decideFromSnapshot} refuses in.
 */
export type EnterpriseCheck =
  | { control: "unavailable"; refusal: PolicyDecision }
  | {
      control: "app_allowlist";
      server: string;
      enabled: boolean;
      /** Built in and always on (Routines), which the list never holds back. */
      builtIn: boolean;
      approved: boolean;
      refusal: PolicyDecision | null;
    }
  | {
      control: "capability";
      capability: Capability;
      answer: CapabilityAnswer;
      refusal: PolicyDecision | null;
    }
  | {
      control: "network";
      host: string;
      port: number;
      policy: EgressPolicy & { from: string };
      /** Null when only the computer can decide: an IP-range rule needs the resolved address. */
      decision: { allowed: boolean; reason: string } | null;
      refusal: PolicyDecision | null;
    };

/**
 * Every switch the overlay asks about one action, each with what it found.
 *
 * The overlay itself ({@link decideFromSnapshot}) stops at the first refusal. "What would happen if…"
 * (`what-if-check.ts`) reads all of them, so an admin sees every switch's answer and which one decides.
 */
export function* enterpriseChecks(
  snapshot: Snapshot | undefined,
  context: PolicyContext,
): Generator<EnterpriseCheck> {
  if (!snapshot) {
    yield {
      control: "unavailable",
      refusal: refusal(
        "enterprise:unavailable",
        "This deployment's enterprise controls have not loaded yet, so the action was refused.",
      ),
    };
    return;
  }
  const member = memberFrom(snapshot, context.actor.id);
  const needed: Capability[] = ["useBots"];

  if (context.mcp?.server) {
    const allowlist = snapshot.settings.mcpAllowlist;
    /*
     * A tool call names the APP (`notion/search`), while since G01-E a curated connector's row is
     * `team:notion`, and an allowlist the admin screen saved before it listed apps holds that row id.
     * So an entry approves the app it names directly, or the app its row instantiates, as the
     * database says (`mcpAppOfRow`) — never by taking the spelling apart.
     *
     * M3: upstream v1.0.0 also exempts its always-on Routines app here (`isAlwaysOn`, from
     * `plugins/personal-defaults.ts`), which this fork's plugins do not have; the fork's rule stands.
     */
    const server = context.mcp.server;
    // M5: 留给 X 系列（personal-defaults：上游的 `isAlwaysOn` 常开应用豁免）。fork 没有常开应用，所以 builtIn 恒为 false。
    const builtIn = false;
    const approved = allowlist.servers.some(
      (entry) => entry === server || snapshot.mcpAppOfRow.get(entry) === server,
    );
    yield {
      control: "app_allowlist",
      server,
      enabled: allowlist.enabled,
      builtIn,
      approved,
      refusal:
        allowlist.enabled && !builtIn && !approved
          ? refusal(
              "mcp_allowlist",
              `The MCP server "${context.mcp.server}" is not on this deployment's approved list, so ${context.mcp.tool} was not called.`,
            )
          : null,
    };
  } else if (context.tool.name.startsWith("computer_")) {
    if (context.intent && COMPUTER_INTENTS.has(context.intent)) {
      needed.push("cloudComputer");
    } else {
      needed.push("cloudBrowser");
    }
    if (context.intent === "navigate") needed.push("cloudNetwork");
  }

  for (const capability of needed) {
    const answer = resolveCapability(snapshot.rows, member, capability);
    yield {
      control: "capability",
      capability,
      answer,
      refusal: answer.allowed
        ? null
        : refusal(`capability:${capability}`, capabilityRefusal(capability)),
    };
  }

  /*
   * A navigation is checked against the network policy here as well as on the computer, so the
   * refusal is a sentence in the conversation rather than a browser error page. Only where it can be
   * decided without DNS: an IP-range rule needs the resolved address, which the computer's filter has
   * and this server does not.
   */
  const destination =
    context.intent === "navigate" && context.page.host
      ? destinationOf(context.page.url)
      : null;
  if (destination) {
    const policy = effectiveNetworkPolicy(snapshot.network, member, true);
    const hasRanges = policy.rules.some((rule) => rule.type === "cidr");
    const decision =
      !hasRanges || /^[\d.:[\]]+$/.test(destination.host)
        ? egressDecision(policy, destination.host, destination.port)
        : null;
    yield {
      control: "network",
      host: destination.host,
      port: destination.port,
      policy,
      decision,
      refusal:
        decision && !decision.allowed
          ? refusal(
              `network:${policy.from}`,
              `${decision.reason} An admin can add it.`,
            )
          : null,
    };
  }
}

/**
 * The host and port a navigation opens, as the egress matcher wants them: apart.
 *
 * Not `page.host`. That is `URL.host`, which carries the port whenever it is not the scheme's
 * default (`erp.internal:8080`), because a boundary rule written as `page.host == "..."` matches
 * against it. Handed to the matcher as the host, it was compared with the domain rules as
 * `erp.internal:8080` and matched none of them, so every allowed destination on a non-default port
 * was refused here, before the computer's filter, which reads the host and port apart, was asked.
 */
export function destinationOf(
  url: string,
): { host: string; port: number } | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return null;
    return {
      host: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === "http:" ? 80 : 443)),
    };
  } catch {
    return null;
  }
}

/** Which app each allowlisted row id instantiates. See {@link Snapshot.mcpAppOfRow}. */
async function mcpAppsOfRows(
  database: Database,
  ids: string[],
): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await database
    .select({ id: mcpServers.id, catalogueKey: mcpServers.catalogueKey })
    .from(mcpServers)
    .where(
      and(inArray(mcpServers.id, ids), isNotNull(mcpServers.catalogueKey)),
    );
  return new Map(
    rows.flatMap((row) =>
      row.catalogueKey ? [[row.id, row.catalogueKey] as const] : [],
    ),
  );
}

async function loadSnapshot(
  store: EnterpriseStore,
  database: Database,
): Promise<Snapshot> {
  /*
   * One after another, not Promise.all. Concurrent statements on one Bun SQL connection were seen to
   * swap prepared-statement result shapes ("bind message has 7 result formats but query has 1
   * columns"), and a snapshot is four small reads.
   */
  const rows = await store.capabilityRows();
  const admins = await store.adminIds();
  const settings = await store.settings();
  const network = await store.networkPolicies();
  const groups = [
    ...new Set([
      ...rows
        .filter((row) => row.scopeKind === "group")
        .map((row) => row.scopeId),
      ...network
        .filter((row) => row.scopeKind === "group")
        .map((row) => row.scopeId),
    ]),
  ];
  const groupsByUser = await store.groupMembers(groups);
  const mcpAppOfRow = await mcpAppsOfRows(
    database,
    settings.mcpAllowlist.servers,
  );
  return {
    rows,
    admins,
    groupsByUser,
    settings,
    network,
    mcpAppOfRow,
    loadedAt: new Date(),
  };
}

/** Is this an action-recording row, and what should it say? */
function commandOf(payload: Record<string, unknown>): string | undefined {
  const command = payload.command;
  return typeof command === "string" && command.trim() ? command : undefined;
}

export function installEnterpriseControls(
  deps: EnterpriseDeps,
): Promise<EnterpriseControls> {
  if (installed) return Promise.resolve(installed);
  if (initializing) return initializing;
  const pending = initializeEnterpriseControls(deps).finally(() => {
    initializing = undefined;
  });
  initializing = pending;
  return pending;
}

async function initializeEnterpriseControls(
  deps: EnterpriseDeps,
): Promise<EnterpriseControls> {
  const store = createEnterpriseStore(deps.database);
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? {
    scheduleInterval: (callback: () => void, milliseconds: number) =>
      setInterval(callback, milliseconds),
    cancelInterval: (timer: ReturnType<typeof setInterval>) =>
      clearInterval(timer),
  };
  let snapshot: Snapshot | undefined;
  let exporter: EventExporter | undefined;
  let connection: ReturnType<typeof postgres> | undefined;
  const removeTaps: (() => void)[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  let closing = false;
  let finishing: Promise<void> | undefined;
  let controls: EnterpriseControls | undefined;
  let ownsOverlay = false;
  let delivery: ReturnType<typeof deliverEgressPolicies> | undefined;
  const stop = (): Promise<void> => {
    if (finishing) return finishing;
    const completion = Promise.withResolvers<void>();
    finishing = completion.promise;
    closing = true;
    if (installed === controls) installed = undefined;
    const failures: Error[] = [];
    const attempt = (stage: string, close: () => void) => {
      try {
        close();
      } catch {
        failures.push(
          new Error(`Enterprise controls ${stage} failed or is unconfirmed.`),
        );
      }
    };
    for (const timer of timers)
      attempt("timer stop", () => clock.cancelInterval(timer));
    const policyDelivery = delivery;
    if (policyDelivery)
      attempt("policy delivery stop", () => policyDelivery.stop());
    for (const remove of removeTaps) attempt("tap removal", remove);
    if (ownsOverlay) attempt("policy seal", () => setPolicyOverlay(null));
    void (async () => {
      const closes: { stage: string; close: () => Promise<void> }[] = [];
      const listener = connection;
      const telemetry = exporter;
      if (listener)
        closes.push({ stage: "listener close", close: () => listener.end() });
      if (telemetry)
        closes.push({
          stage: "exporter shutdown",
          close: () => telemetry.shutdown(),
        });
      const results = await Promise.allSettled(
        closes.map(({ close }) => Promise.resolve().then(close)),
      );
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected")
          failures.push(
            new Error(
              `Enterprise controls ${closes[index]?.stage ?? "resource close"} failed or is unconfirmed.`,
            ),
          );
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          `Enterprise controls shutdown is unconfirmed (${failures.length} failed stages).`,
        );
    })().then(completion.resolve, completion.reject);
    return finishing;
  };

  try {
    /*
     * The settings, capability switches and network policies are the deployment's, and the refresh
     * runs from boot, from a 60-second timer and from the NOTIFY listener — none of which has a frame.
     * So it reads as `platform` (G01) rather than leaving it to the legacy `system` fallback.
     */
    const refresh = async () => {
      if (closing) return;
      try {
        snapshot = await runAsTenant("platform", () =>
          loadSnapshot(store, deps.database),
        );
        // Any Bot's network policy may have changed with what was just read, so the push on the way to
        // each action sends it again rather than trusting that its computer already holds it.
        deps.provider?.forgetPushedPolicies?.();
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "enterprise-controls-refresh-failed",
            note: snapshot
              ? "Still enforcing the last settings this server read."
              : "No settings have been read, so every capability-gated action is refused.",
            error: String(error),
            cause:
              error instanceof Error && error.cause
                ? String(error.cause)
                : undefined,
          }),
        );
      }
    };
    await refresh();
    setPolicyOverlay((context) =>
      closing ? null : decideFromSnapshot(snapshot, context),
    );
    ownsOverlay = true;

    exporter = createOtelEventExporter(env);
    const eventExporter = exporter;
    if (eventExporter)
      removeTaps.push(
        addAuditTap((event) => {
          if (!closing) eventExporter.emit(event);
        }),
      );

    /*
     * Action Recording: every shell command a Bot ran (or was refused), scrubbed, into its own table.
     * Read from the audit rows the computer gateway writes, so the recorded outcome is the one the
     * trail holds. A command on the person's own computer (`host/run_command`) is on the trail too,
     * and is recorded by `guardHostAccess` below with the outcome the desktop gave, so it is skipped
     * here and recorded once.
     */
    removeTaps.push(
      addAuditTap((event) => {
        if (closing) return;
        if (!snapshot?.settings.actionRecording) return;
        if (!event.eventType.startsWith("computer.action_")) return;
        const command = commandOf(event.payload);
        if (!command) return;
        // The gateway names the tool `action`; `tool` is accepted for any other writer.
        const named = event.payload.action ?? event.payload.tool;
        if (typeof named === "string" && named.startsWith("host/")) return;
        const scrubbed = scrubCommand(command);
        const botId =
          typeof event.payload.bot === "string" ? event.payload.bot : null;
        const toolName =
          typeof named === "string" ? named : "computer_run_command";
        const actor =
          event.actorUserId ??
          (typeof event.payload.actor === "string"
            ? event.payload.actor
            : null);
        const outcome = event.eventType.replace("computer.action_", "");
        void store
          .recordAction({
            surface: "cloud",
            botId,
            actorUserId: actor,
            toolName,
            command: scrubbed,
            outcome,
          })
          .catch((error) =>
            console.error(
              JSON.stringify({
                type: "action-record-failed",
                error: String(error),
              }),
            ),
          );
        exporter?.emit({
          eventType: "action.recorded",
          targetType: "computer",
          targetId: botId,
          actorUserId: event.actorUserId ?? null,
          initiatorKind: event.initiatorKind,
          initiatorId: event.initiatorId,
          payload: { bot: botId, tool: toolName, command: scrubbed, outcome },
          surface: "bot",
        });
      }),
    );

    const audit = (input: Parameters<typeof recordAuditEvent>[1]) =>
      recordAuditEvent(deps.auditStore, input).catch((error) =>
        console.error(
          JSON.stringify({
            type: "enterprise-audit-failed",
            eventType: input.eventType,
            error: String(error),
          }),
        ),
      );

    /*
     * Whose network policy a Bot's computer is under (upstream #1398): the lookup `policyForBot`
     * makes, also used to replay a candidate policy (admin/network-replay.ts).
     *
     * As `platform` (G01): "whose Bot is this" is asked by the 30-second push and by a computer
     * waking, for a Bot of any tenant. Left to the caller's frame it ran as `system` (or as whoever
     * woke it), row-level security hid the owner's profile, and the Bot was given the network policy
     * of nobody in particular instead of its owner's.
     */
    const networkMemberFor: EnterpriseControls["networkMemberFor"] = async (
      botId,
    ) => {
      const current = snapshot;
      if (!current) return undefined;
      const [profile] = await runAsTenant("platform", () =>
        deps.database
          .select({ owner: agentProfiles.ownerUserId })
          .from(agentProfiles)
          .where(eq(agentProfiles.agentId, botId))
          .limit(1),
      );
      const owner = profile?.owner;
      const member: Member = owner
        ? await runAsTenant("platform", () => store.member(owner))
        : { role: "user", groups: [] };
      return {
        member,
        cloudNetwork: resolveCapability(current.rows, member, "cloudNetwork")
          .allowed,
      };
    };

    const policyForBot = async (botId: string): Promise<EgressPolicy> => {
      // A person's own browser has no Bot and no owner to read a policy for, and the organization's is for Bots.
      if (isPersonBrowserId(botId))
        return deps.personBrowserPolicy ?? { mode: "deny_all", rules: [] };
      const current = snapshot;
      const owner = await networkMemberFor(botId);
      if (!current || !owner) return { mode: "deny_all", rules: [] };
      const { from: _from, ...policy } = effectiveNetworkPolicy(
        current.network,
        owner.member,
        owner.cloudNetwork,
      );
      return deps.duringRecording
        ? deps.duringRecording(botId, policy)
        : policy;
    };

    // Tried again within seconds until it lands, quietly while a computer is likely still starting.
    const retrying = deliverEgressPolicies({
      push: () =>
        pushEgressPolicies({
          provider: deps.provider as ComputerProvider,
          token: deps.computerToken,
          policyForBot,
          ...(deps.webBotAuth ? { webBotAuth: deps.webBotAuth } : {}),
        }),
    });
    delivery = retrying;
    const pushNetworkPolicies = async () => {
      if (closing || !deps.provider) return;
      return retrying.push();
    };

    /*
     * Every Bot this person owns, whichever frame asks: an administrator's request (whose own tenant
     * cannot see the member's profiles) or SCIM's deferred offboarding. As `platform` (G01), because
     * the question is about the person, not about the asker's rows.
     */
    const ownedBots = async (userId: string) =>
      (
        await runAsTenant("platform", () =>
          deps.database
            .select({ agentId: agentProfiles.agentId })
            .from(agentProfiles)
            .where(eq(agentProfiles.ownerUserId, userId)),
        )
      ).map((row) => row.agentId);

    /**
     * Whose a Bot is: its owner (`agents/bot-owner.ts`) — the tenant stamped on its own `agents` row,
     * or for a team Bot the person its profile names — or `platform` when that is nobody. The
     * stopped-computer row is then filed in its owner's trail rather than in `system`'s or `team`'s.
     * Same rule as the idle computer culler.
     */
    const botTenant = async (botId: string): Promise<string> =>
      (await ownerTenantOfBot(deps.database, botId)) ?? "platform";

    const terminateMemberComputers: EnterpriseControls["terminateMemberComputers"] =
      async (userId, by) => {
        const result = {
          stopped: [] as string[],
          failed: [] as { computer: string; reason: string }[],
        };
        if (!deps.provider) return result;
        /*
         * Their own computer, which every Bot they used runs on, and the computer of each Bot of theirs
         * that has one of its own. Asking about an isolated Bot that never had a computer is a stop of
         * nothing, which answers that nothing was running.
         */
        const keys: ComputerKey[] = [
          { kind: "person", personId: userId },
          ...(await ownedBots(userId)).map((botId) => ({
            kind: "bot" as const,
            botId,
          })),
        ];
        for (const key of keys) {
          const computer = computerKeyText(key);
          try {
            const { wasRunning } = await deps.provider.stop({ key });
            if (wasRunning) result.stopped.push(computer);
          } catch (error) {
            result.failed.push({
              computer,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        await audit({
          eventType: "computer.terminated",
          targetType: "person",
          targetId: userId,
          ...(by.id ? { actorUserId: by.id } : {}),
          payload: {
            by: by.email,
            stopped: result.stopped,
            failed: result.failed,
            note: "Running Bots stopped; durable disks kept; each Bot gets a fresh computer next session.",
          },
        });
        return result;
      };

    /**
     * Stop every running computer nobody has used for `inactiveComputerDays`.
     *
     * One replica at a time, under a transaction-scoped advisory lock, so two servers do not both
     * write the audit row. Idleness is read from the audit trail, as the idle culler reads it, so
     * nothing here dials a computer to ask.
     */
    const terminateInactiveComputers = async () => {
      const days = snapshot?.settings.inactiveComputerDays ?? 30;
      if (!deps.provider || days <= 0) return null;
      /*
       * The lock is held on a connection of its own, so the work below (reads, stops, audit rows) uses
       * the pool normally. Holding it inside a pool transaction while writing through the pool is how
       * a small pool deadlocks.
       */
      const lockConnection = postgres(deps.databaseUrl, { max: 1 });
      try {
        const [lock] = await lockConnection<
          { held: boolean }[]
        >`select pg_try_advisory_lock(4192011) as held`;
        if (!lock?.held) return null;
        const tx = deps.database;
        const running = runningComputers(
          await (deps.provider as ComputerProvider).list(),
        );
        if (running.length === 0) return { stopped: [] };
        // By computer, as the idle culler reads it: a person's computer is in use while any Bot is.
        // As `platform` (G01): when each running computer, of any tenant, last acted. Unframed this
        // read only `system` rows, so every person's computer looked idle since it started.
        const used = await runAsTenant("platform", () =>
          lastUsedByComputer(
            tx,
            running.map((computer) => computer.computer),
          ),
        );
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        const stopped: string[] = [];
        for (const computer of running) {
          const since =
            used.get(computer.computer) ??
            (computer.startedAt ? new Date(computer.startedAt) : undefined);
          if (!since || since.getTime() > cutoff) continue;
          try {
            await (deps.provider as ComputerProvider).stop({
              key: computer.key,
            });
            stopped.push(computer.computer);
            /*
             * Filed in the trail of whose computer it was: the person's own, or an isolated Bot's
             * owner. The computer is already stopped, so a failed owner lookup must not cost it its
             * audit row or report the stop as failed: it files as the deployment's, like a Bot naming
             * nobody.
             */
            const { key } = computer;
            const owner =
              key.kind === "bot"
                ? await botTenant(key.botId).catch(() => "platform")
                : isPersonTenant(key.personId)
                  ? key.personId
                  : "platform";
            await runAsTenant(owner, () =>
              audit({
                eventType: "computer.terminated_inactive",
                targetType: "computer",
                targetId: computer.computer,
                initiator: DEPLOYMENT_INITIATOR,
                payload: {
                  computer: computer.computer,
                  ...(key.kind === "bot" ? { bot: key.botId } : {}),
                  idleSince: since.toISOString(),
                  inactiveDays: days,
                },
              }),
            );
          } catch (error) {
            console.warn(
              JSON.stringify({
                type: "inactive-computer-stop-failed",
                computer: computer.computer,
                error: String(error),
              }),
            );
          }
        }
        await lockConnection`select pg_advisory_unlock(4192011)`;
        return { stopped };
      } finally {
        await lockConnection.end({ timeout: 5 });
      }
    };

    const offboard = async (userId: string, by: string) => {
      await deps.people?.retireOwned(userId, by).catch((error) =>
        console.error(
          JSON.stringify({
            type: "offboard-retire-failed",
            userId,
            error: String(error),
          }),
        ),
      );
      await terminateMemberComputers(userId, { email: by }).catch((error) =>
        console.error(
          JSON.stringify({
            type: "offboard-computers-failed",
            userId,
            error: String(error),
          }),
        ),
      );
    };

    // Every server hears a change, including the one that made it.
    connection = postgres(deps.databaseUrl, { max: 1 });
    const onChange = () => {
      if (!closing) void refresh().then(() => pushNetworkPolicies());
    };
    await connection
      .listen(ENTERPRISE_TOPIC, onChange, onChange)
      .catch((error) => {
        console.error(
          JSON.stringify({
            type: "enterprise-listen-failed",
            note: "Changes made on another server reach this one within a minute instead of at once.",
            error: String(error),
          }),
        );
      });

    timers.push(
      clock.scheduleInterval(() => {
        if (!closing) void refresh();
      }, 60_000),
    );
    timers.push(
      clock.scheduleInterval(() => {
        if (!closing) void pushNetworkPolicies();
      }, 30_000),
    );
    timers.push(
      clock.scheduleInterval(() => {
        if (closing) return;
        void terminateInactiveComputers().catch((error) =>
          console.error(
            JSON.stringify({
              type: "inactive-computer-sweep-failed",
              error: String(error),
            }),
          ),
        );
        // Retention across every tenant's Action Recording rows: `platform` (G01).
        void runAsTenant("platform", () =>
          store.purgeActions(
            new Date(
              Date.now() - ACTION_RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1000,
            ),
          ),
        ).catch((error) =>
          console.error(
            JSON.stringify({
              type: "action-record-purge-failed",
              error: String(error),
            }),
          ),
        );
      }, 60 * 60_000),
    );
    for (const timer of timers) timer.unref?.();
    void pushNetworkPolicies();

    controls = {
      store,
      deps,
      exporter,
      snapshot: () => snapshot,
      refresh,
      capabilityFor: async (userId, capability) =>
        resolveCapability(
          await store.capabilityRows(),
          await store.member(userId),
          capability,
        ).allowed,
      capabilitiesFor: async (userId) =>
        resolveAllCapabilities(
          await store.capabilityRows(),
          await store.member(userId),
        ),
      terminateMemberComputers,
      terminateInactiveComputers,
      pushNetworkPolicies,
      policyForBot,
      networkMemberFor,
      offboard,
      stop,
    };
    installed = controls;
    return controls;
  } catch {
    try {
      await stop();
    } catch (cleanup: unknown) {
      throw new AggregateError(
        [new Error("Enterprise controls initialization failed."), cleanup],
        "Enterprise controls initialization failed and cleanup is unconfirmed.",
      );
    }
    throw new Error("Enterprise controls initialization failed.");
  }
}

/** For the break-glass rule, which is decided before the controls may be installed. */
export function isBreakGlass(
  email: string,
  initialAdminEmails: readonly string[],
): boolean {
  return isConfiguredAdmin(email, initialAdminEmails);
}

/* ------------------------------ guarding stores in place ------------------------------ */

type DeliveryLike = {
  bind(input: {
    ownerUserId: string;
    transport: string;
    realm: string;
    identity: string;
    channelId?: string | null;
    agentId?: string | null;
  }): Promise<{ id: string }>;
  removeBinding(owner: string, id: string): Promise<void>;
};

/**
 * Refuse a Slack or Teams connection for somebody without "Add Bots to Slack and Teams", and put
 * every connection and disconnection on the trail. In place, so every holder of the store is covered.
 */
export function guardDeliveryStore<T extends DeliveryLike>(
  store: T,
  auditStore: AuditStore,
  refuse: (message: string) => Error,
): T {
  const bind = store.bind.bind(store);
  const removeBinding = store.removeBinding.bind(store);
  store.bind = (async (input: Parameters<T["bind"]>[0]) => {
    const chat = input.transport === "slack" || input.transport === "teams";
    const controls = enterpriseControls();
    if (controls && chat) {
      let allowed = false;
      try {
        allowed = await controls.capabilityFor(input.ownerUserId, "slackTeams");
      } catch {
        allowed = false;
      }
      if (!allowed) throw refuse(capabilityRefusal("slackTeams"));
    }
    const bound = await bind(input);
    await recordAuditEvent(auditStore, {
      eventType: "delivery.linked",
      targetType: "delivery_binding",
      targetId: bound.id,
      actorUserId: input.ownerUserId,
      payload: {
        transport: input.transport,
        realm: input.realm,
        channelId: input.channelId ?? null,
        agentId: input.agentId ?? null,
        /*
         * Which chat account now speaks as the owner, for Slack and Teams only.
         *
         * A link code there is redeemed by whoever sends it, and that account then runs the Bot as
         * its owner and decides approvals as them. The row is filed under the owner, so without
         * this a binding somebody else redeemed reads as the owner connecting their own account,
         * and once the binding is removed nothing anywhere says which account it was. Recorded on
         * the link only: `delivery.unlinked` carries the same `targetId`, so the trail joins them.
         *
         * Not for SMS or push. There `identity` is a phone number or a device token, the trail is
         * readable by every administrator, and the code-in-a-shared-chat risk does not exist —
         * an SMS code proves possession of the phone it was sent to.
         */
        ...(chat ? { identity: input.identity } : {}),
      },
    }).catch(() => undefined);
    return bound;
  }) as T["bind"];
  store.removeBinding = (async (owner: string, id: string) => {
    await removeBinding(owner, id);
    await recordAuditEvent(auditStore, {
      eventType: "delivery.unlinked",
      targetType: "delivery_binding",
      targetId: id,
      actorUserId: owner,
      payload: {},
    }).catch(() => undefined);
  }) as T["removeBinding"];
  return store;
}

type HostAccessLike = {
  requestFolderGrant(input: {
    actorId: string;
    botId: string;
    botName: string;
    writable?: boolean;
  }): Promise<unknown>;
  callHost(
    input: {
      actorId: string;
      botId: string;
      kind: string;
      command?: string;
    },
    hooks?: { onDispatch?: () => Promise<void> },
  ): Promise<unknown>;
};

/** Refuse the member's own machine to somebody without "Local computer access", and record commands. */
export function guardHostAccess<T extends HostAccessLike>(
  broker: T,
  refuse: (message: string) => Error,
): T {
  const requestFolderGrant = broker.requestFolderGrant.bind(broker);
  const callHost = broker.callHost.bind(broker);
  const allowed = async (actorId: string) => {
    const controls = enterpriseControls();
    if (!controls) return true;
    try {
      return (
        (await controls.capabilityFor(actorId, "useBots")) &&
        (await controls.capabilityFor(actorId, "localComputer"))
      );
    } catch {
      return false;
    }
  };
  broker.requestFolderGrant = (async (
    input: Parameters<T["requestFolderGrant"]>[0],
  ) => {
    if (!(await allowed(input.actorId)))
      throw refuse(capabilityRefusal("localComputer"));
    return requestFolderGrant(input);
  }) as T["requestFolderGrant"];
  broker.callHost = (async (
    input: Parameters<T["callHost"]>[0],
    hooks?: Parameters<T["callHost"]>[1],
  ) => {
    if (!(await allowed(input.actorId)))
      throw refuse(capabilityRefusal("localComputer"));
    const controls = enterpriseControls();
    const record = (outcome: string) => {
      if (input.kind !== "run_command" || !input.command) return;
      if (!controls?.snapshot()?.settings.actionRecording) return;
      void controls.store
        .recordAction({
          surface: "local",
          botId: input.botId,
          actorUserId: input.actorId,
          toolName: "host/run_command",
          command: scrubCommand(input.command),
          outcome,
        })
        .catch(() => undefined);
    };
    try {
      const result = await callHost(input, hooks);
      record("allowed");
      return result;
    } catch (error) {
      record("failed");
      throw error;
    }
  }) as T["callHost"];
  return broker;
}

type RoutineLike = {
  create(input: {
    ownerUserId: string;
    agentId?: string;
    channelId?: string;
    cron?: string;
    timezone?: string;
  }): Promise<{ id: string }>;
  update(ownerUserId: string, id: string, patch: object): Promise<unknown>;
  remove(ownerUserId: string, id: string): Promise<void>;
  setEnabled(ownerUserId: string, id: string, enabled: boolean): Promise<void>;
};

/**
 * Put every routine change on the trail, whoever made it: the screen, or a Bot through its tools.
 * In place, so the tool registry that already holds this store is covered too.
 */
export function auditRoutineStore<T extends RoutineLike>(
  store: T,
  auditStore: AuditStore,
): T {
  const create = store.create.bind(store);
  const update = store.update.bind(store) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const remove = store.remove.bind(store);
  const setEnabled = store.setEnabled.bind(store);
  const write = (input: Parameters<typeof recordAuditEvent>[1]) =>
    recordAuditEvent(auditStore, input).catch(() => undefined);

  store.create = (async (input: Parameters<T["create"]>[0]) => {
    const routine = await create(input);
    await write({
      eventType: "routine.created",
      targetType: "routine",
      targetId: routine.id,
      actorUserId: input.ownerUserId,
      payload: {
        agentId: input.agentId ?? null,
        channelId: input.channelId ?? null,
        cron: input.cron ?? null,
        timezone: input.timezone ?? null,
      },
    });
    return routine;
  }) as T["create"];
  store.update = (async (...args: unknown[]) => {
    const result = await update(...args);
    const [ownerUserId, id, changes] = args as [unknown, unknown, unknown];
    await write({
      eventType: "routine.updated",
      targetType: "routine",
      ...(typeof id === "string" ? { targetId: id } : {}),
      ...(typeof ownerUserId === "string" ? { actorUserId: ownerUserId } : {}),
      payload: {
        changed:
          changes && typeof changes === "object"
            ? Object.keys(changes as object)
            : [],
      },
    });
    return result;
  }) as T["update"];
  store.remove = (async (ownerUserId: string, id: string) => {
    await remove(ownerUserId, id);
    await write({
      eventType: "routine.deleted",
      targetType: "routine",
      targetId: id,
      actorUserId: ownerUserId,
      payload: {},
    });
  }) as T["remove"];
  store.setEnabled = (async (
    ownerUserId: string,
    id: string,
    enabled: boolean,
  ) => {
    await setEnabled(ownerUserId, id, enabled);
    await write({
      eventType: "routine.enabled_changed",
      targetType: "routine",
      targetId: id,
      actorUserId: ownerUserId,
      payload: { enabled },
    });
  }) as T["setEnabled"];
  return store;
}

/* ------------------------------ headless turns ------------------------------ */

/**
 * `provider/model` a built-in run in this thread answers on: the person's pick for the
 * conversation, or the deployment's own. Same spelling as `builtInModel`.
 */
export async function builtInModelFor(
  deps: Pick<EnterpriseDeps, "builtInModel" | "pickedModel">,
  actorId: string,
  threadId: string | null,
): Promise<string | undefined> {
  const deployment = deps.builtInModel;
  if (!deployment || !threadId) return deployment;
  const picked = await deps.pickedModel?.(actorId, threadId);
  return picked ? `${deployment.split("/")[0]}/${picked}` : deployment;
}

/**
 * One usage row for a headless turn that reached the model, as the gate writes one for each browser
 * run (`gate.ts`): the configured model for a built-in Bot, `unknown` for a remote one, which chooses
 * its own and was not watched here.
 *
 * Without it a turn nobody started from the browser served a model and left no row, so an admin
 * reading usage never saw what background check-ins cost. Called only once the turn was admitted, so
 * a turn the allowlist refused keeps the one refused row `headlessTurnRefusal` wrote for it. A failed
 * write is logged and never fails the turn, as the gate's is.
 *
 * Written through {@link recordHeadlessModelUsage}, in the owner's own tenant (a check-in is work done
 * for that person), so the row carries their tenant and the bound model is named as the gate names it.
 */
export async function recordHeadlessUsage(input: {
  ownerUserId: string;
  agentId: string;
  threadId: string;
  runId: string;
}): Promise<void> {
  await recordHeadlessModelUsage({
    tenantId: input.ownerUserId,
    ownerUserId: input.ownerUserId,
    agentId: input.agentId,
    threadId: input.threadId,
    runId: input.runId,
  });
}

/**
 * Whether a turn nobody started from the browser may run, and the sentence to refuse it with.
 *
 * The HTTP gate (`gate.ts`) applies "Use Bots" and the model allowlist to a browser run. Routines,
 * Run now, responsibilities, follow-ups, group turns, delivery conversations and Slack, Teams and
 * SMS messages never cross it: they run through the shared headless turn runner, which asks here.
 * The allowlist is decided the way the gate decides it before a run: a built-in Bot runs on the
 * conversation's picked model or the deployment's default; a remote Bot chooses its own and is
 * checked only by what it streams. Fails closed when the controls cannot be read.
 */
export async function headlessTurnRefusal(input: {
  ownerUserId: string;
  agentId: string;
  threadId?: string;
}): Promise<string | null> {
  const controls = installed;
  if (!controls) return null;
  try {
    if (!(await controls.capabilityFor(input.ownerUserId, "useBots")))
      return capabilityRefusal("useBots");
    const allowlist = controls.snapshot()?.settings.modelAllowlist;
    if (!allowlist?.enabled) return null;
    const [row] = await controls.deps.database
      .select({ type: agents.type })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1);
    /*
     * A built-in Bot bound to its tenant's model library runs on that model, so that is the name the
     * allowlist judges and the refusal names. Reading the deployment's model instead would both let
     * a bound Bot past a list it does not appear on and tell the person about a model this run never
     * spoke. Unbound, it answers on the person's pick for this conversation, else the deployment's,
     * the same order the HTTP gate reads (`gate.ts`).
     */
    const builtIn = row?.type === "built_in";
    const bound = builtIn ? await modelBoundFor(controls, input.agentId) : null;
    const model = builtIn
      ? (bound ??
        (await builtInModelFor(
          controls.deps,
          input.ownerUserId,
          input.threadId ?? null,
        )))
      : undefined;
    if (!model || allowlist.models.includes(model)) return null;
    await controls.store
      .recordModelUsage({
        userId: input.ownerUserId,
        agentId: input.agentId,
        threadId: input.threadId ?? null,
        runId: null,
        model,
        source: bound ? "bound" : "configured",
        allowed: false,
      })
      .catch(() => undefined);
    await recordAuditEvent(controls.deps.auditStore, {
      eventType: "model.refused",
      targetType: "agent",
      targetId: input.agentId,
      actorUserId: input.ownerUserId,
      payload: {
        model,
        source: bound ? "bound" : "configured",
        headless: true,
      },
    }).catch(() => undefined);
    return `This Bot uses ${model}, which isn't an allowed model. Ask an admin to allow it.`;
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "headless-capability-check-failed",
        agentId: input.agentId,
        error: String(error),
      }),
    );
    return "This deployment's enterprise controls could not be checked, so the Bot did not run.";
  }
}

/** See {@link EnterpriseDeps.agentModelName}: the bound model this Bot's run will speak, or null. */
async function modelBoundFor(
  controls: EnterpriseControls,
  agentId: string,
): Promise<string | null> {
  if (!controls.deps.agentModelName)
    return boundModelName(controls.deps.database, agentId);
  return controls.deps.agentModelName(agentId).catch(() => null);
}

/** The first model an AG-UI stream names, the way the HTTP gate reads a remote Bot's. */
const MODEL_IN_EVENT = /"model"\s*:\s*"([^"]{1,200})"/;

/** The model a stream event names, if any — for a remote Bot, which chooses its own. */
export function modelNamedIn(event: unknown): string | undefined {
  try {
    return MODEL_IN_EVENT.exec(JSON.stringify(event) ?? "")?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The usage row for a headless run that answered — the row the HTTP gate writes for a browser run.
 *
 * A routine firing, a crew's step, a responsibility run or a hop never crosses that gate, so without
 * this its card on the board names no model and the usage view never counts it. `runId` is the run
 * reference the task card is keyed by, which is what the board reads the model back with.
 *
 * The model is the one that ran: a built-in Bot's bound model only when the resolver actually built
 * it (see {@link EnterpriseDeps.agentModelName}), else the person's pick for the conversation or the
 * deployment's; a remote Bot's is what
 * its stream named, or `unknown`. Written in the run's own tenant, and never in `system` or
 * `platform`, where the person whose card it is could not read it. Never throws: a usage row that
 * cannot be written must not turn an answered turn into a failed one.
 */
export async function recordHeadlessModelUsage(input: {
  tenantId: string;
  ownerUserId: string;
  agentId: string;
  threadId: string | null;
  runId: string;
  observedModel?: string;
}): Promise<void> {
  const controls = installed;
  if (!controls) return;
  if (!isPersonTenant(input.tenantId)) {
    console.error(
      JSON.stringify({
        type: "model-usage-without-tenant",
        agentId: input.agentId,
      }),
    );
    return;
  }
  try {
    await runAsTenant(input.tenantId, async () => {
      const [row] = await controls.deps.database
        .select({ type: agents.type })
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1);
      const builtIn = row?.type === "built_in";
      const bound = builtIn
        ? await modelBoundFor(controls, input.agentId)
        : null;
      // Bound model first, then the person's pick for this conversation, then the deployment's.
      const configured = builtIn
        ? (bound ??
          (await builtInModelFor(
            controls.deps,
            input.ownerUserId,
            input.threadId,
          )))
        : undefined;
      const model =
        configured ?? input.observedModel ?? `remote:${input.agentId}`;
      const source = builtIn
        ? bound
          ? "bound"
          : "configured"
        : input.observedModel
          ? "observed"
          : "unknown";
      if (builtIn && !configured) return;
      // Judged as the gate judges it; a built-in Bot off the list never got this far.
      const allowlist = controls.snapshot()?.settings.modelAllowlist;
      const allowed = !allowlist?.enabled || allowlist.models.includes(model);
      return await controls.store.recordModelUsage({
        userId: input.ownerUserId,
        agentId: input.agentId,
        threadId: input.threadId,
        runId: input.runId,
        model,
        source,
        allowed,
      });
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "model-usage-write-failed",
        agentId: input.agentId,
        error: String(error),
      }),
    );
  }
}

/* ------------------------------ check-ins ------------------------------ */

/**
 * The admin's say over check-ins, as the proactive engine asks it before any model call
 * (`proactive/engine.ts`): the "Check-ins" switch for this person, and how many check-ins a Bot may
 * run for one person in a day.
 *
 * Both read fresh, never from the snapshot, as every asynchronous check here does: a switch an admin
 * flipped a second ago stops the next check-in on every replica. Without the controls installed (a
 * script, a test that never installs them) the defaults stand, which is check-ins on and 24 a day.
 * A switch that can't be read refuses, as every other one does, and says so in the log: a check-in
 * then is skipped, never run unchecked.
 */
export const proactiveAdmin: ProactiveAdmin = {
  async proactiveAllowed(ownerUserId) {
    const controls = installed;
    if (!controls) return DEFAULT_CAPABILITIES.proactive;
    return controls
      .capabilityFor(ownerUserId, "proactive")
      .catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            type: "proactive-capability-read-failed",
            userId: ownerUserId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return false;
      });
  },
  /*
   * One number for every Bot: the cap is per Bot, so a person with five Bots gets five Bots' worth,
   * and the admin sets how many each may use.
   */
  async proactiveDailyRuns(_agentId) {
    const controls = installed;
    if (!controls) return DEFAULT_ENTERPRISE_SETTINGS.proactiveDailyRuns;
    return controls.store
      .settings()
      .then((settings) => settings.proactiveDailyRuns)
      .catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            type: "proactive-daily-runs-read-failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return 0;
      });
  },
};
