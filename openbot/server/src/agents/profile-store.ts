import { declaredHarness } from "@openbot/shared/harnesses";
import { and, desc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { capabilityRefusal } from "../admin/capabilities";
import type { CredentialStore } from "../credentials";
import type { Database } from "../db/client";
import {
  agentPreferences,
  agentProfiles,
  agents,
  deploymentPackages,
  modelRegistry,
  platformModelPool,
  pluginGrants,
  subscriptions,
} from "../db/schema";
import { roleTemplates } from "../db/schema/roles";
import { teamBotPublications } from "../db/schema/team-bots";
import { TEAM_TENANT } from "../db/schema/tenant";
import { asPlatform, currentTenant, isPersonTenant } from "../tenant/context";
import { avatarAgentId } from "../tenant/provisioning";
import {
  assignedCondition,
  assignedToActor,
  teamBotAccess,
} from "../team-bots/access";
import {
  authFromConfiguration,
  retireReplacedKey,
  storeAgentAuth,
} from "./auth-header";
import {
  type CallbackTokenHolder,
  hashCallbackToken,
  mintCallbackToken,
  sameToken,
} from "./callback-token";
import { frameworkOf } from "./framework";
import { mayIsolate } from "./isolation";
import { canManageAgent } from "./profile-policy";
import type {
  AgentActor,
  AgentProfile,
  AgentRoleContent,
  CreateAgentInput,
  Persona,
} from "./profile-types";
import { englishName } from "../brand";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DatabaseExecutor = Pick<Database, "select"> | Pick<Transaction, "select">;

/** Something that can read profiles: the pool, or a caller's open transaction. */
export type ProfileReadExecutor = DatabaseExecutor;

export type AgentProfileStore = {
  list(actor: AgentActor, hidden?: boolean): Promise<AgentProfile[]>;
  get(actor: AgentActor, id: string): Promise<AgentProfile | null>;
  /**
   * `get`, but on the caller's own transaction and holding the profile against deletion until that
   * transaction ends.
   *
   * A caller that writes rows referencing an agent has to validate it here rather than through
   * `get`. `get` borrows a second pooled connection, which deadlocks the caller's transaction once
   * every connection is held by one, and reads an unlocked snapshot, so a deletion committing
   * between the check and the insert leaves rows pointing at an agent that no longer runs.
   */
  getWithin(
    executor: ProfileReadExecutor,
    actor: AgentActor,
    id: string,
  ): Promise<AgentProfile | null>;
  create(
    actor: AgentActor,
    input: CreateAgentInput & {
      /**
       * The standing instruction for a coworker with nowhere else to run.
       *
       * Only consulted when there is neither an endpoint nor a Bot in the box, and it is what makes
       * that a `built_in` coworker rather than a refusal. `POST /api/agents` never sends it — the
       * form has no such field — so a hand-made Bot on a deployment without a managed agent is
       * refused exactly as it is today.
       *
       * Not on `CreateAgentInput`, so `update` cannot take it: changing an existing Bot's type is a
       * different act with different consequences, and this is the creation path.
       */
      systemPrompt?: string;
      /**
       * The role template the form started from (ROLE1), recorded as the new coworker's source.
       * Create-only for the reason `systemPrompt` is: an existing coworker takes a template through
       * `applyRole`, which shows the person what it replaces. Not recorded on a `built_in` coworker
       * (D4); the content the form sent is saved either way.
       */
      roleTemplate?: { id: string; version: number };
    },
    admit?: (transaction: Transaction) => Promise<void>,
  ): Promise<AgentProfile>;
  update(
    actor: AgentActor,
    id: string,
    input: CreateAgentInput,
    /**
     * Refuse with {@link AgentChangedError} unless the profile still carries this `updated_at`, read
     * under the same row lock the write takes. A caller that decided what to write from an earlier
     * read (a staffing proposal drafted against one version) must not overwrite an edit made since;
     * a check outside this transaction would let two such writers both pass it.
     */
    options?: { unchangedSince?: Date },
  ): Promise<AgentProfile>;
  duplicate(
    actor: AgentActor,
    id: string,
    admit?: (transaction: Transaction) => Promise<void>,
    options?: DuplicateOptions,
  ): Promise<AgentProfile>;
  setHidden(actor: AgentActor, id: string, hidden: boolean): Promise<void>;
  setPinned(actor: AgentActor, id: string, pinned: boolean): Promise<void>;
  softDelete(actor: AgentActor, id: string): Promise<void>;
  /**
   * Issue this agent a credential for calling tools back, and return it once.
   *
   * Returned rather than stored: only the hash is kept, so this is the one moment the token exists in
   * a readable form. Calling it again replaces the old one, which is how rotation works and how a
   * leaked token is retired.
   */
  issueCallbackToken(actor: AgentActor, id: string): Promise<string>;
  /** Take the credential away. The agent may talk, and may no longer call anything back. */
  revokeCallbackToken(actor: AgentActor, id: string): Promise<void>;
  /**
   * Which agent holds this token, if any, and the tenant its profile is stamped with.
   *
   * By hash, because that is all this side keeps. Not scoped to an actor: the caller is a machine
   * presenting a credential, and the credential is the whole of its claim. So it is asked as
   * `platform` (G01-E PCB), the one frame that sees a person's private Bot and a `team` Bot alike:
   * the route asking has no person to frame it, and the legacy unframed `system` answer sees neither.
   */
  agentForCallbackToken(hash: string): Promise<CallbackTokenHolder | null>;
};

/** What a summon adds to a plain duplicate (`agents/summon.ts`). Absent, a duplicate is just a copy. */
export type DuplicateOptions = {
  /** The shared preset this copy was summoned from, written to `agent_profiles.summoned_from`. */
  summonedFrom?: string;
  /**
   * Rows that must commit with the copy, written on the copy's own transaction after it exists, so
   * a failure here leaves no copy behind and a copy never exists without them.
   */
  alongside?: (transaction: Transaction, copy: AgentProfile) => Promise<void>;
};

/** The transaction `duplicate`'s `admit` and `alongside` are handed. */
export type ProfileTransaction = Transaction;

/**
 * The store with the one write role templates need (ROLE1). A separate type so the many stand-in
 * stores tests build for `AgentProfileStore` need not grow a method they never call.
 */
export type AgentProfileStoreWithRoles = AgentProfileStore & {
  /**
   * Replace a coworker's identity, persona and Bible with a role template's, and record the template
   * and version as its source (ROLE1 §3.3). Name, avatar, model, skills and everything else stay.
   * Refused for a `built_in` coworker, the 分身 included (D4), and for one the actor may not manage.
   */
  applyRole(
    actor: AgentActor,
    id: string,
    role: AgentRoleContent,
    source: { id: string; version: number },
  ): Promise<AgentProfile>;
};

export class AgentNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent ${id} was not found.`);
    this.name = "AgentNotFoundError";
  }
}

/** The profile changed after the version the caller wrote against; nothing was written. */
export class AgentChangedError extends Error {
  constructor(id: string) {
    super(`Agent ${id} changed since it was read.`);
    this.name = "AgentChangedError";
  }
}

export class AgentNotManageableError extends Error {
  constructor(id: string) {
    super(`Agent ${id} cannot be managed by this actor.`);
    this.name = "AgentNotManageableError";
  }
}

export class ProtectedAgentError extends Error {
  constructor(id: string) {
    super(`Agent ${id} is protected.`);
    this.name = "ProtectedAgentError";
  }
}

/**
 * A Bot was asked to have a computer of its own and may not.
 *
 * `capability`: the person asking does not hold "Isolated Bots". `unowned`: the Bot belongs to the
 * deployment rather than a person (a tenant package's Bot, or one whose owner was removed), and the
 * switch is a person's, so there is nobody it could be granted to. The route records both on the trail.
 */
export class IsolationRefusedError extends Error {
  /**
   * `forOwner`: the switch refused is the Bot's owner's, asked while somebody else (an administrator) edits it, so the
   * sentence names the owner rather than telling the editor their own switch is off.
   */
  constructor(
    readonly reason: "capability" | "unowned",
    options: { forOwner?: boolean } = {},
  ) {
    super(
      reason === "unowned"
        ? "This Bot doesn't belong to a person, so it can't have a computer of its own."
        : options.forOwner
          ? "An admin has turned off \"Isolated Bots\" for this Bot's owner, so it can't have a computer of its own."
          : capabilityRefusal("isolatedComputers"),
    );
    this.name = "IsolationRefusedError";
  }
}

/**
 * Refuse a Bot of its own to somebody without "Isolated Bots".
 *
 * Here rather than only at the route, so every caller of the store meets it, as publishing a Team Bot
 * does. Asked only of a request that turns isolation ON: turning it off is always allowed, and an
 * absent field changes nothing.
 *
 * Before any transaction opens. The answer reads the switches on a pooled connection of its own, and
 * borrowing a second one while a transaction holds the first is how `getWithin`'s deadlock happens.
 */
async function requireMayIsolate(actor: AgentActor) {
  if (!(await mayIsolate(actor.id))) {
    throw new IsolationRefusedError("capability");
  }
}

/**
 * Refuse a computer of its own to a Bot whose OWNER lacks "Isolated Bots", whoever is editing it.
 *
 * The owner's switch is the one that decides at run time (`runsIsolated` in isolation.ts), so it is the one asked here:
 * asking the editor let an administrator tick Isolated on somebody's Bot whose owner lacks the switch, the save
 * succeeded, and the Bot never ran isolated. Read before the transaction, for the reason `requireMayIsolate` gives. An
 * unknown Bot, and one that belongs to nobody, are refused inside, each for its own reason.
 */
async function requireOwnerMayIsolate(
  database: Database,
  actor: AgentActor,
  agentId: string,
) {
  const [row] = await database
    .select({ ownerUserId: agentProfiles.ownerUserId })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId))
    .limit(1);
  const owner = row?.ownerUserId;
  if (!owner || (await mayIsolate(owner))) return;
  throw new IsolationRefusedError("capability", {
    forOwner: owner !== actor.id,
  });
}

export class ManagedAgentUnavailableError extends Error {
  constructor() {
    super(
      `${englishName()} has no managed Bot. Give this Bot its own AG-UI endpoint.`,
    );
    this.name = "ManagedAgentUnavailableError";
  }
}

export class ModelNotInLibraryError extends Error {
  constructor() {
    super("That model is not in this library, or has been switched off.");
    this.name = "ModelNotInLibraryError";
  }
}

/**
 * A platform pool model this coworker may not be bound to (stories H1, K1): no such row, switched
 * off, or not offered on the plan the coworker's tenant is on.
 */
export class PlatformModelNotAvailableError extends Error {
  constructor() {
    super("该平台体验模型不存在、已停用，或不在当前套餐内。");
    this.name = "PlatformModelNotAvailableError";
  }
}

/** A library model and a pool model named in one save: a coworker speaks with exactly one. */
export class ModelBindingConflictError extends Error {
  constructor() {
    super("一个员工只能绑定一个模型：请在模型库与平台体验模型之间二选一。");
    this.name = "ModelBindingConflictError";
  }
}

/**
 * A Bot nobody owns any more may not be made private (G01-E P9).
 *
 * When a person's account is deleted, their Bots keep living with `owner_user_id` set null. A public
 * or published one is stamped `team`, and `team` rows are read only where `openbot_team_bot_visible`
 * says so: public, the owner, or a published audience. Private and unpublished, with no owner, that
 * is nobody: the Bot would stay in the database, unreachable from every chat, and no person's frame
 * could ever change it back. So the change is refused. An administrator takes such a Bot down by
 * deleting it on the admin pages, which still works.
 *
 * The account deletion itself can reach that state: it also deletes the person's publications
 * (`published_by` ON DELETE CASCADE), so a Bot they had published while private is left ownerless,
 * private and unpublished at once. No app path deletes accounts; the operator note on Team Bots'
 * `unpublish` says how an administrator finds and removes such a Bot.
 */
export class OwnerlessBotPrivateError extends Error {
  constructor(id: string) {
    super(
      `Nobody owns Bot ${id} any more, so it cannot be made private or unpublished: nobody could reach it. Keep it shared, or delete it.`,
    );
    this.name = "OwnerlessBotPrivateError";
  }
}

/** A role template offered to the 分身 (ROLE1, D4 as revised 2026-11-04). */
export class RoleTemplateNotApplicableError extends Error {
  constructor() {
    super(
      "我的分身不能套用角色模板：它代表你本人，按自己的系统提示词运行，模板会替换它。手册仍可手工编辑。",
    );
    this.name = "RoleTemplateNotApplicableError";
  }
}

/** A role template named as a new coworker's source that is not the creator's at that version. */
export class RoleTemplateSourceError extends Error {
  constructor() {
    super("所选角色模板不存在或已被删除，请重新选择。");
    this.name = "RoleTemplateSourceError";
  }
}

export class ModelBindingNotApplicableError extends Error {
  constructor(id: string) {
    super(`Agent ${id} runs on another server, so its model is chosen there.`);
    this.name = "ModelBindingNotApplicableError";
  }
}

const joinedProjection = {
  id: agents.id,
  name: agents.name,
  title: agentProfiles.title,
  roleDescription: agentProfiles.roleDescription,
  avatarSeed: agentProfiles.avatarSeed,
  visibility: agentProfiles.visibility,
  ownerUserId: agentProfiles.ownerUserId,
  packageId: deploymentPackages.id,
  hiddenAt: agentPreferences.hiddenAt,
  pinnedAt: agentPreferences.pinnedAt,
  deletedAt: agentProfiles.deletedAt,
  modelRef: agentProfiles.modelRef,
  platformModelRef: agentProfiles.platformModelRef,
  persona: agentProfiles.persona,
  bible: agentProfiles.bible,
  roleTemplateId: agentProfiles.roleTemplateId,
  roleTemplateVersion: agentProfiles.roleTemplateVersion,
  isolated: agentProfiles.isolated,
  summonedFrom: agentProfiles.summonedFrom,
  presetPortrait: agentProfiles.presetPortrait,
  /* The hash, only so a surface can say whether one exists. It never leaves this module. */
  callbackTokenHash: agentProfiles.callbackTokenHash,
  configuration: agents.configuration,
  type: agents.type,
};

function joinedProfiles(executor: DatabaseExecutor, actor: AgentActor) {
  return executor
    .select({
      ...joinedProjection,
      // A Team Bot an administrator put in this person's sidebar.
      assignedToMe: sql<boolean>`${assignedToActor(actor.id, agents.id)}`,
    })
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .leftJoin(
      agentPreferences,
      and(
        eq(agentPreferences.agentId, agents.id),
        eq(agentPreferences.userId, actor.id),
      ),
    )
    .leftJoin(deploymentPackages, eq(deploymentPackages.id, agents.packageId));
}

function accessFilter(actor: AgentActor) {
  if (actor.role === "admin") return undefined;

  return or(
    eq(agentProfiles.visibility, "public"),
    eq(agentProfiles.ownerUserId, actor.id),
    // A private Bot its owner published to the team, to this person, or to a group they are in.
    teamBotAccess(actor.id, agentProfiles.agentId),
  );
}

function mapProfile(
  row: Awaited<
    ReturnType<ReturnType<typeof joinedProfiles>["execute"]>
  >[number],
): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    roleDescription: row.roleDescription,
    avatarSeed: row.avatarSeed,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    // Fresh personal starters are editable defaults, even though the package seeded them.
    systemOwned:
      row.packageId !== null &&
      (row.configuration as { personalStarter?: boolean } | null)
        ?.personalStarter !== true,
    hasCallbackToken: row.callbackTokenHash !== null,
    hidden: row.hiddenAt !== null,
    pinned: row.pinnedAt !== null,
    assignedToMe: Boolean(row.assignedToMe),
    deletedAt: row.deletedAt,
    isolated: row.isolated,
    summonedFrom: row.summonedFrom ?? null,
    presetPortrait: row.presetPortrait ?? null,
    endpoint: endpointOf(row.configuration),
    modelRef: row.modelRef,
    platformModelRef: row.platformModelRef,
    persona: (row.persona as Persona | null) ?? null,
    bible: row.bible ?? null,
    roleTemplate:
      row.roleTemplateId !== null && row.roleTemplateVersion !== null
        ? { id: row.roleTemplateId, version: row.roleTemplateVersion }
        : null,
    acceptsRoleTemplate: !isAvatar(row.id),
    // Whether a key is set, never which. The form needs to show "a key is set" so a person does not
    // wipe one by saving an unrelated edit; showing the value would put a secret in a screenshot.
    hasAuth: authFromConfiguration(row.configuration) !== null,
    instructions: starterInstructionsOf(row),
    ...frameworkField(row),
  };
}

/** What runs it, by name, when OpenBot knows. See `AgentProfile.framework`. */
function frameworkField(row: {
  type: "built_in" | "remote_ag_ui" | "remote_mastra";
  configuration: unknown;
}): { framework?: string } {
  const framework = frameworkOf(row);
  return framework ? { framework } : {};
}

/**
 * Where a personal starter keeps its instructions: the prompt a Bot that runs here runs on, or the
 * instructions OpenBot sends a remote one in its standing role, after what it does.
 */
export function starterInstructionsKey(
  type: "built_in" | "remote_ag_ui" | "remote_mastra",
): "systemPrompt" | "standingInstructions" {
  return type === "built_in" ? "systemPrompt" : "standingInstructions";
}

/** A personal starter's instructions, or null for any other Bot. See `AgentProfile.instructions`. */
function starterInstructionsOf(row: {
  type: "built_in" | "remote_ag_ui" | "remote_mastra";
  configuration: unknown;
}): string | null {
  const configuration = row.configuration as {
    personalStarter?: unknown;
  } | null;
  if (configuration?.personalStarter !== true) return null;
  return promptOf(configuration, starterInstructionsKey(row.type));
}

/**
 * Whether this is a person's 分身 (`avatar-<person>`, `tenant/provisioning.ts`), the one coworker that
 * takes no role template (ROLE1 D4, revised 2026-11-04).
 *
 * D4 first refused every `built_in` coworker. On a single-container deployment every coworker a person
 * makes is `built_in` (it runs here on its role description), so that switched the feature off. Only
 * the 分身 runs on a prompt that is deliberately not its role description and speaks as the person
 * themselves; any other `built_in` coworker already has its prompt moved by an edit of its role
 * description, and a template is that same edit. By id, not by stamp: a public Bot's tenant moves to
 * `team`, its id never does.
 */
function isAvatar(id: string): boolean {
  return id.startsWith(avatarAgentId(""));
}

/**
 * The AG-UI address this coworker runs on, read back out of its stored configuration.
 *
 * Needed so an edit does not destroy it. The edit form is the same form as create, so without the
 * current endpoint to fill it with, saving a change of title would submit an empty endpoint and
 * convert an external agent back into the built-in one. That failure is silent and total: the Bot
 * keeps working, so nothing looks broken, and it is simply no longer their agent.
 */
function endpointOf(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const endpoint = (configuration as { endpoint?: unknown }).endpoint;
  return typeof endpoint === "string" ? endpoint : null;
}

/**
 * Whether an edit's endpoint is the address the Bot already has.
 *
 * Compared as URLs, not as text. The edit form sends the stored address back unchanged, and the
 * route stores what `new URL` makes of it, which adds a "/" to an address with no path: the
 * installer's `http://agent-harness:4212` came back as `http://agent-harness:4212/`. Compared as
 * text, renaming the personal starter repointed it at that copy and counted it as the person's own
 * connection, so the next provider change left it dialling a harness that no longer runs.
 */
function sameAddress(edited: string, stored: string | null): boolean {
  if (stored === null) return false;
  try {
    return new URL(edited).toString() === new URL(stored).toString();
  } catch {
    return edited === stored;
  }
}

/** Which agent on a Mastra server this Bot means, when the row names one. */
function remoteAgentIdOf(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const named = (configuration as { remoteAgentId?: unknown }).remoteAgentId;
  return typeof named === "string" && named.length > 0 ? named : null;
}

/**
 * The instruction a Bot runs on, read back out of its stored configuration.
 *
 * The mirror of {@link endpointOf}, and needed for the same reason: a copy has to be made of what
 * the original actually was, and for a `built_in` coworker the prompt IS the coworker. Trimmed and
 * required to be non-empty, matching `registeredAgentFromRow`, which will not build a Bot from a
 * blank one either.
 */
function promptOf(
  configuration: unknown,
  key: "systemPrompt" | "standingInstructions",
): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const prompt = (configuration as Record<string, unknown>)[key];
  if (typeof prompt !== "string") return null;
  const trimmed = prompt.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** What a coworker is, and what it runs on: the two `agents` columns a copy has to reproduce. */
export type AgentRun = {
  type: "built_in" | "remote_ag_ui" | "remote_mastra";
  configuration: Record<string, unknown>;
};

/**
 * What a duplicate runs on, decided from what the original ran on.
 *
 * WHY THIS IS NOT JUST THE ENDPOINT. Duplicate used to rebuild the copy from `source.endpoint` alone
 * and write `type: "remote_ag_ui"` flat. #328 fixed the half of that a coworker with its own endpoint
 * saw. The other half is a coworker that has no endpoint because it is not supposed to have one: a
 * `built_in` Bot's configuration is `{ systemPrompt }`, so the endpoint read came back null, the copy
 * fell through to the managed Bot, and the prompt was dropped on the floor.
 *
 * That copy is the failure this repository already has a paragraph about. It looks identical on every
 * screen and its whole instruction becomes `standingRoleMessage` — see the note above that function
 * in `copilot.ts`, which names the compliance Bot that answered a filing question with invented
 * thresholds because one sentence of role description was all that reached it. The default tenant
 * package ships two `built_in` coworkers, and one of them, `Knowledge`, is a careful
 * do-not-fabricate instruction. Copy it and you get a coworker with the name, the title, the avatar,
 * and none of that.
 *
 * The type is carried too, not only the configuration, so a copy runs the same way its original
 * does.
 *
 * `null` means there is nothing to run this copy on, which the caller turns into
 * {@link ManagedAgentUnavailableError}. That can now only happen for a source that had neither an
 * endpoint nor a prompt on a deployment with no managed Bot — never for a `built_in` source, which
 * brings its own instruction and needs no managed Bot to fall back to.
 *
 * `auth` is deliberately not carried: it is a reference into the vault, and two coworkers sharing one
 * credential would mean rotating either one's key silently changed the other's.
 */
export function runForDuplicate(
  source: {
    type: "built_in" | "remote_ag_ui" | "remote_mastra";
    configuration: unknown;
  },
  managed: Record<string, unknown> | undefined,
): AgentRun | null {
  const systemPrompt = promptOf(source.configuration, "systemPrompt");
  if (source.type === "built_in" && systemPrompt) {
    return { type: "built_in", configuration: { systemPrompt } };
  }

  const endpoint = endpointOf(source.configuration);
  if (endpoint) {
    /*
     * The copy is dialled the way the original was, and that is not cosmetic. A Mastra endpoint
     * speaks Mastra's client protocol and has no AG-UI route, so a duplicate written as
     * `remote_ag_ui` would carry the right address and be unable to say anything to it. The Bot
     * would appear, accept a grant, and answer nothing.
     *
     * Which agent on that server comes with it for the same reason: a Mastra endpoint is a roster,
     * and a copy that forgets the name falls back to a different agent, or refuses. See
     * `pickFromRoster`.
     */
    const standingInstructions = promptOf(
      source.configuration,
      "standingInstructions",
    );
    const remoteAgentId =
      source.type === "remote_mastra"
        ? remoteAgentIdOf(source.configuration)
        : null;
    const harness =
      source.configuration && typeof source.configuration === "object"
        ? declaredHarness(
            (source.configuration as Record<string, unknown>).harness,
          )?.id
        : undefined;
    return {
      type: source.type === "remote_mastra" ? "remote_mastra" : "remote_ag_ui",
      configuration: {
        endpoint,
        ...(remoteAgentId ? { remoteAgentId } : {}),
        ...(standingInstructions ? { standingInstructions } : {}),
        // The same agent at the same address runs on the same framework. See `frameworkOf`.
        ...(harness ? { harness } : {}),
      },
    };
  }

  return managed ? { type: "remote_ag_ui", configuration: managed } : null;
}

async function findAccessibleProfile(
  executor: DatabaseExecutor,
  actor: AgentActor,
  id: string,
): Promise<AgentProfile | null> {
  const [row] = await joinedProfiles(executor, actor).where(
    and(
      eq(agents.id, id),
      isNull(agentProfiles.deletedAt),
      accessFilter(actor),
    ),
  );
  return row ? mapProfile(row) : null;
}

async function lockProfileMutationRows(executor: DatabaseExecutor, id: string) {
  await executor
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, id))
    .for("update");
  await executor
    .select({ agentId: agentProfiles.agentId })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, id))
    .for("update");
}

/**
 * Share-lock a profile so it stays readable to concurrent callers but cannot be deleted or renamed
 * until this transaction ends. `lockProfileMutationRows` takes the exclusive counterpart, so a
 * deletion racing a reference blocks here instead of committing underneath it.
 */
async function lockProfileReadRow(executor: DatabaseExecutor, id: string) {
  await executor
    .select({ agentId: agentProfiles.agentId })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, id))
    .for("share");
}

/**
 * The source columns for a role template the caller holds at that version, or a refusal.
 *
 * Read in the caller's frame on the caller's transaction: `role_templates` admits only its owner's
 * own frame, so another person's template id reads as absent, the way a foreign model id does.
 */
async function roleTemplateSource(
  executor: DatabaseExecutor,
  source: { id: string; version: number },
): Promise<{ roleTemplateId: string; roleTemplateVersion: number }> {
  if (!Number.isInteger(source.version) || source.version < 1) {
    throw new RoleTemplateSourceError();
  }
  const [template] = await executor
    .select({ version: roleTemplates.version })
    .from(roleTemplates)
    .where(eq(roleTemplates.id, source.id))
    .limit(1);
  if (!template || template.version < source.version) {
    throw new RoleTemplateSourceError();
  }
  return { roleTemplateId: source.id, roleTemplateVersion: source.version };
}

function requireManageable(actor: AgentActor, profile: AgentProfile) {
  if (profile.systemOwned) throw new ProtectedAgentError(profile.id);
  if (!canManageAgent(actor, profile)) {
    throw new AgentNotManageableError(profile.id);
  }
}

/**
 * Refuses a pool row the coworker's tenant may not bind: absent, switched off, or outside its plan.
 *
 * The tenant is the one stamped on the profile row (for a `team` Bot, the person saving it), never
 * the caller's guess or a default. The pool is platform-owned and readable by the application; the
 * subscription is read under row-level security on the same transaction, filtered to that tenant.
 */
async function assertPoolModelAllowed(
  transaction: Transaction,
  agentId: string,
  poolId: string,
): Promise<void> {
  const [record] = await transaction
    .select({ tenantId: agentProfiles.tenantId })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId))
    .limit(1);
  if (!record) throw new AgentNotFoundError(agentId);
  /*
   * Whose plan decides. A person's coworker: that person's. A shared Bot stamped `team` (G01-E) is
   * nobody's to bill; the resolver charges a pool call to the person who invokes it, so the binding
   * is checked against the plan of the person saving it, in whose frame this transaction runs.
   * A coworker stamped `system` or `platform`, or a save outside a person's frame, has no tenant to
   * meter a pool call to, so the resolver never honours its pool binding; storing one would report
   * a binding that silently falls back.
   */
  const planTenant =
    record.tenantId === TEAM_TENANT ? currentTenant() : record.tenantId;
  if (!isPersonTenant(planTenant)) {
    throw new PlatformModelNotAvailableError();
  }
  const [entry] = await transaction
    .select({ tiers: platformModelPool.tiers })
    .from(platformModelPool)
    .where(
      and(
        eq(platformModelPool.id, poolId),
        eq(platformModelPool.enabled, true),
      ),
    )
    .limit(1);
  if (!entry) throw new PlatformModelNotAvailableError();
  const [subscription] = await transaction
    .select({ planId: subscriptions.planId })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.tenantId, planTenant),
        eq(subscriptions.status, "active"),
      ),
    )
    .orderBy(
      desc(subscriptions.updatedAt),
      desc(subscriptions.createdAt),
      desc(subscriptions.id),
    )
    .limit(1);
  const plan = subscription?.planId ?? "free";
  if (!(entry.tiers as readonly string[]).includes(plan)) {
    throw new PlatformModelNotAvailableError();
  }
}

function newAgentId() {
  return `agent_${crypto.randomUUID()}`;
}

/**
 * A write that must change exactly one row, or the caller learns it did not (G01-E, I9).
 *
 * Row security does not raise on a row the frame may read but not write: the UPDATE matches nothing
 * and reports success. A Bot the caller can see (a teammate's public Bot, a catalogue Bot) and an
 * administrator's role both used to pass the store's own checks and then change nothing, and the
 * route answered with the old row as if it had been saved.
 */
function exactlyOne(rows: unknown[], id: string) {
  if (rows.length !== 1) throw new AgentNotManageableError(id);
}

/** The owner's explicit move of one Bot (0122 row guard): the only re-stamp outside `platform`. */
async function withTeamMove(
  transaction: Transaction,
  agentId: string,
  work: () => Promise<void>,
) {
  await transaction.execute(
    sql`select set_config('app.team_move', ${agentId}, true)`,
  );
  await work();
  // Transaction-local already; cleared anyway, so nothing later in this transaction moves a row.
  await transaction.execute(sql`select set_config('app.team_move', '', true)`);
}

/**
 * Move a Bot its owner made public into the shared `team` tenant (G01-E P8b), in the owner's frame.
 *
 * The profile first: the `agents` row's team policy asks whether the PROFILE is the caller's and
 * already `team`. Then the Bot's grants, so it keeps the tools it was granted wherever it runs. The
 * Bot's child rows (security policy, knowledge bindings, device projects) stay with the owner (I8).
 *
 * Only the owner moves a Bot: in any other frame the profile is invisible or unwritable, nothing
 * matches, and this throws. Setting `app.team_move` by hand opens nothing more.
 */
export async function moveToTeam(
  transaction: Transaction,
  agentId: string,
): Promise<void> {
  await withTeamMove(transaction, agentId, async () => {
    const profiles = await transaction
      .update(agentProfiles)
      .set({ tenantId: TEAM_TENANT })
      .where(
        and(
          eq(agentProfiles.agentId, agentId),
          ne(agentProfiles.tenantId, TEAM_TENANT),
        ),
      )
      .returning({ agentId: agentProfiles.agentId });
    if (profiles.length !== 1) throw new AgentNotFoundError(agentId);
    const moved = await transaction
      .update(agents)
      .set({ tenantId: TEAM_TENANT })
      .where(and(eq(agents.id, agentId), ne(agents.tenantId, TEAM_TENANT)))
      .returning({ id: agents.id });
    if (moved.length !== 1) throw new AgentNotFoundError(agentId);
    await transaction
      .update(pluginGrants)
      .set({ tenantId: TEAM_TENANT })
      .where(
        and(
          eq(pluginGrants.agentId, agentId),
          ne(pluginGrants.tenantId, TEAM_TENANT),
        ),
      );
  });
}

/**
 * The reverse of {@link moveToTeam}: a team Bot made private again goes back to its owner, in the
 * owner's frame. Grants first and the profile last, because every `team` policy on the way asks
 * whether the profile is still the caller's `team` profile.
 */
export async function moveToOwner(
  transaction: Transaction,
  agentId: string,
  ownerId: string,
): Promise<void> {
  await withTeamMove(transaction, agentId, async () => {
    await transaction
      .update(pluginGrants)
      .set({ tenantId: ownerId })
      .where(
        and(
          eq(pluginGrants.agentId, agentId),
          eq(pluginGrants.tenantId, TEAM_TENANT),
        ),
      );
    const moved = await transaction
      .update(agents)
      .set({ tenantId: ownerId })
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, TEAM_TENANT)))
      .returning({ id: agents.id });
    if (moved.length !== 1) throw new AgentNotFoundError(agentId);
    const profiles = await transaction
      .update(agentProfiles)
      .set({ tenantId: ownerId })
      .where(
        and(
          eq(agentProfiles.agentId, agentId),
          eq(agentProfiles.tenantId, TEAM_TENANT),
        ),
      )
      .returning({ agentId: agentProfiles.agentId });
    if (profiles.length !== 1) throw new AgentNotFoundError(agentId);
  });
}

/**
 * Where a Bot's rows belong after a write that set its visibility, decided in the frame that wrote it.
 *
 * Public moves the owner's own Bot to `team`, in the owner's frame. Private moves a `team` Bot back to its owner, unless it
 * is published: a publication is a separate, revocable fact (`team-bots`), and its audience reads the
 * Bot through `team`. Nothing moves outside a person frame: a `system` or `platform` stamp is the
 * catalogue's, and only the owner's frame may re-stamp (the row guard refuses any other).
 */
async function settleStamp(
  transaction: Transaction,
  agentId: string,
  stamp: string,
  visibility: CreateAgentInput["visibility"],
  ownerUserId: string | null,
) {
  const frame = currentTenant();
  if (visibility === "public") {
    if (isPersonTenant(frame) && stamp === frame && ownerUserId === frame) {
      await moveToTeam(transaction, agentId);
    }
    return;
  }
  if (stamp !== TEAM_TENANT || !isPersonTenant(ownerUserId)) return;
  if (await publishedToTeam(transaction, agentId)) return;
  await moveToOwner(transaction, agentId, ownerUserId);
}

/** Whether the Bot has a publication, counted only when stamped `team` as every publication is (0126). */
async function publishedToTeam(transaction: Transaction, agentId: string) {
  const [published] = await transaction
    .select({ agentId: teamBotPublications.agentId })
    .from(teamBotPublications)
    .where(
      and(
        eq(teamBotPublications.agentId, agentId),
        eq(teamBotPublications.tenantId, TEAM_TENANT),
      ),
    )
    .limit(1);
  return Boolean(published);
}

/**
 * Refuse the write that would leave a `team` Bot without an owner reachable by nobody: private and
 * unpublished ({@link OwnerlessBotPrivateError}). Asked before anything is written.
 */
async function refuseOwnerlessPrivate(
  transaction: Transaction,
  agentId: string,
  stamp: string | undefined,
  visibility: CreateAgentInput["visibility"],
  ownerUserId: string | null,
) {
  if (stamp !== TEAM_TENANT || visibility !== "private") return;
  if (isPersonTenant(ownerUserId)) return;
  if (await publishedToTeam(transaction, agentId)) return;
  throw new OwnerlessBotPrivateError(agentId);
}

/**
 * Which agent a token belongs to.
 *
 * Selected by hash and then compared in constant time. The lookup alone would be enough to identify
 * the row, and the comparison is what keeps a timing difference from confirming a partial guess
 * against an index.
 */
async function findByTokenHash(
  database: Database,
  hash: string,
): Promise<CallbackTokenHolder | null> {
  const rows = await database
    .select({
      agentId: agentProfiles.agentId,
      tenantId: agentProfiles.tenantId,
      hash: agentProfiles.callbackTokenHash,
    })
    .from(agentProfiles)
    .where(
      and(
        eq(agentProfiles.callbackTokenHash, hash),
        isNull(agentProfiles.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row?.hash) return null;
  return sameToken(row.hash, hash)
    ? { id: row.agentId, tenantId: row.tenantId }
    : null;
}

/** Hiding a Team Bot an administrator assigned to this person, which they cannot do. */
export class AgentAssignedError extends Error {
  constructor(_id: string) {
    super("This Bot was assigned to you by an admin and can't be hidden.");
    this.name = "AgentAssignedError";
  }
}

export function createAgentProfileStore(
  database: Database,
  managedAgentAgUiUrl: URL | undefined,
  /**
   * Where a customer agent's key is kept. Optional so a deployment without a vault still runs; an
   * agent with a key then simply cannot be created, which is better than storing it in the clear.
   */
  vault?: { store: CredentialStore; encryptionKey: string },
): AgentProfileStoreWithRoles {
  const managedConfiguration = managedAgentAgUiUrl
    ? { endpoint: managedAgentAgUiUrl.toString() }
    : undefined;

  return {
    async list(actor, hidden = false) {
      const rows = await joinedProfiles(database, actor).where(
        and(
          isNull(agentProfiles.deletedAt),
          accessFilter(actor),
          hidden
            ? isNotNull(agentPreferences.hiddenAt)
            : isNull(agentPreferences.hiddenAt),
        ),
      );
      return rows.map(mapProfile);
    },

    get(actor, id) {
      return findAccessibleProfile(database, actor, id);
    },

    async getWithin(executor, actor, id) {
      await lockProfileReadRow(executor, id);
      return findAccessibleProfile(executor, actor, id);
    },

    async create(actor, input, admit) {
      if (input.isolated === true) await requireMayIsolate(actor);
      return database.transaction(async (transaction) => {
        await admit?.(transaction);
        const id = newAgentId();
        const endpoint = input.endpoint
          ? { endpoint: input.endpoint }
          : managedConfiguration;
        const systemPrompt = input.systemPrompt?.trim();
        if (endpoint) {
          await transaction.insert(agents).values({
            id,
            name: input.name,
            type: "remote_ag_ui",
            // Their endpoint if they gave one, ours if they did not. Validated before it reaches
            // here; see endpoint.ts for why a stored URL is a security decision and not a text
            // field.
            //
            // The key, if there is one, goes to the vault and only its reference is stored here. See
            // auth-header.ts for why a bearer token must not sit next to the endpoint.
            configuration: {
              ...endpoint,
              // The framework they named, for an address they gave. See `frameworkOf`.
              ...(input.endpoint && input.harness
                ? { harness: input.harness }
                : {}),
              ...(input.auth && vault
                ? {
                    auth: await storeAgentAuth({
                      store: vault.store,
                      encryptionKey: vault.encryptionKey,
                      agentId: id,
                      header: input.auth.header,
                      value: input.auth.value,
                      executor: transaction,
                    }),
                  }
                : {}),
            },
          });
        } else if (systemPrompt) {
          /*
           * Nowhere to send it, so it runs here.
           *
           * This is the shape General Assistant and Knowledge already have, and the shape
           * `registeredAgentFromRow` reads: `built_in` plus a non-empty `configuration.systemPrompt`.
           * A key is deliberately not written on this branch — a key authenticates to an address and
           * this coworker has none, so storing one would leave a live credential in the vault that
           * nothing can ever present.
           */
          await transaction.insert(agents).values({
            id,
            name: input.name,
            type: "built_in",
            configuration: { systemPrompt },
          });
        } else {
          /*
           * No address, no Bot in the box, and no instruction to run on. There is nothing to create:
           * a `built_in` row with an empty prompt is a coworker `registeredAgentFromRow` drops on
           * the floor, and the Bot would exist on every screen while answering nobody.
           */
          throw new ManagedAgentUnavailableError();
        }
        await transaction.insert(agentProfiles).values({
          agentId: id,
          ownerUserId: actor.id,
          title: input.title,
          roleDescription: input.roleDescription,
          // The face the person picked in the form, or the id when nothing was picked.
          avatarSeed: input.avatarSeed ?? id,
          visibility: input.visibility,
          persona: input.persona ?? null,
          bible: input.bible ?? null,
          // Recorded whatever it runs on: a new coworker is never the 分身 (D4, revised 2026-11-04).
          ...(input.roleTemplate
            ? await roleTemplateSource(transaction, input.roleTemplate)
            : {}),
          isolated: input.isolated === true,
        });
        // Both rows took this frame's stamp; a public Bot then moves to `team` in the same transaction.
        await settleStamp(
          transaction,
          id,
          currentTenant(),
          input.visibility,
          actor.id,
        );

        const profile = await findAccessibleProfile(transaction, actor, id);
        if (!profile) throw new AgentNotFoundError(id);
        return profile;
      });
    },

    async update(actor, id, input, options) {
      if (input.isolated === true)
        await requireOwnerMayIsolate(database, actor, id);
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          if (options?.unchangedSince) {
            const [held] = await transaction
              .select({ updatedAt: agentProfiles.updatedAt })
              .from(agentProfiles)
              .where(eq(agentProfiles.agentId, id))
              .limit(1);
            if (held?.updatedAt.getTime() !== options.unchangedSince.getTime())
              throw new AgentChangedError(id);
          }
          /*
           * Before the manage check, so a tenant package's Bot is refused for what was asked of it
           * rather than with the general "built in and can't be changed", and the trail can say so.
           */
          if (
            input.isolated === true &&
            (profile.systemOwned || profile.ownerUserId === null)
          ) {
            throw new IsolationRefusedError("unowned");
          }
          requireManageable(actor, profile);

          const updatedAt = new Date();
          /**
           * The endpoint and the key change here too, not only at creation.
           *
           * The form sends both and the route validates both, so an edit that dropped them looked
           * like it had worked: the screen reported success and the Bot kept answering at the old
           * address, which is the worst way to move an endpoint. A key is replaced only when one is
           * supplied, because the form cannot show what is stored and sending nothing means "leave
           * it alone" rather than "remove it".
           */
          const [row] = await transaction
            .select({
              configuration: agents.configuration,
              type: agents.type,
              tenantId: agents.tenantId,
            })
            .from(agents)
            .where(eq(agents.id, id))
            .limit(1);
          await refuseOwnerlessPrivate(
            transaction,
            id,
            row?.tenantId,
            input.visibility,
            profile.ownerUserId,
          );
          const previous = (row?.configuration ?? {}) as Record<
            string,
            unknown
          >;
          /**
           * A coworker that runs here runs on its role description, so editing one has to move both.
           *
           * `create` writes the role description into `configuration.systemPrompt` for a coworker
           * with no address, and that prompt is the ONLY instruction such a coworker ever gets:
           * `registeredAgentFromRow` gives a `built_in` agent its `systemPrompt` and no standing
           * role message, so `agentProfiles.roleDescription` never reaches it. Left out of this
           * merge, an edit wrote the new text to the profile every screen reads and left the Bot
           * running on the original — permanently, with nothing anywhere to say so. That is the
           * worst shape a failed edit can take, and it is the same one the endpoint comment above
           * describes.
           *
           * Only for `built_in`, and that matters. A remote Bot has no `systemPrompt` and must not
           * acquire one — its instruction travels as the standing role message instead — and the
           * tenant package's Bots, whose `system_prompt` is deliberately not their
           * `role_description`, remain protected except for the editable personal starter.
           *
           * NOT FOR THE PERSONAL STARTER EITHER. It is seeded from the package, so what it does and
           * what it is told are two texts, as they are for every package Bot: its description is
           * what a conversation's header shows, and its instructions are edited on their own
           * (`input.instructions`). Moving its description into its prompt would leave it running on
           * one sentence written for a person.
           */
          /*
           * And only when the role description actually changed (ROLE1). A save that leaves it as it
           * was — the Bible written by hand, say — has nothing to move, and the 分身, whose
           * systemPrompt was never its role description, keeps the prompt it runs on.
           */
          const starter = previous.personalStarter === true;
          const described = input.roleDescription !== profile.roleDescription;
          const instructed =
            starter &&
            row !== undefined &&
            input.instructions !== undefined &&
            input.instructions !== profile.instructions;
          // An edit that sends the address the Bot already has leaves the stored one as it is.
          const repointed =
            input.endpoint !== undefined &&
            input.endpoint !== "" &&
            !sameAddress(input.endpoint, profile.endpoint);
          const configuration: Record<string, unknown> = {
            ...previous,
            ...(!starter && row?.type === "built_in" && described
              ? { systemPrompt: input.roleDescription }
              : {}),
            ...(instructed
              ? { [starterInstructionsKey(row.type)]: input.instructions }
              : {}),
            ...(repointed ? { endpoint: input.endpoint } : {}),
            ...(input.auth && vault
              ? {
                  auth: await storeAgentAuth({
                    store: vault.store,
                    encryptionKey: vault.encryptionKey,
                    agentId: id,
                    header: input.auth.header,
                    value: input.auth.value,
                    // An agent that already has a live key is being edited, not
                    // first-created, so the vault rotates rather than inserting
                    // a second live row for the same agent id.
                    previousCredentialId: authFromConfiguration(
                      row?.configuration,
                    )?.credentialId,
                    executor: transaction,
                  }),
                }
              : {}),
          };

          // A connection edited in the profile belongs to the person, not installer setup.
          if (
            previous.personalStarter === true &&
            (repointed || (input.auth && vault))
          ) {
            configuration.personalConnection = true;
          }

          if (!starter && row?.type !== "built_in" && described) {
            delete configuration.standingInstructions;
          }

          /*
           * The key this one replaces is already retired, by the rotation above.
           *
           * `storeAgentAuth` locks the previous credential, revokes it and inserts the replacement
           * inside this transaction, so there is nothing left here to retire. A second revoke from
           * outside the transaction would wait on the row lock this transaction is holding and never
           * be released, because the transaction cannot commit until the call it is awaiting
           * returns: editing a Bot's key would hang until the statement timed out, and the timeout
           * would then be reported as a key that is still live.
           */
          exactlyOne(
            await transaction
              .update(agents)
              .set({ name: input.name, configuration, updatedAt })
              .where(eq(agents.id, id))
              .returning({ id: agents.id }),
            id,
          );
          /*
           * The model binding is checked against the library instead of trusted, because a foreign
           * key is not stopped by row-level security: the constraint alone would accept another
           * tenant's model id, and the coworker would then answer on a model this person never
           * connected and never holds a key for.
           */
          // One model per coworker; refused before either id is looked up.
          if (input.modelRef && input.platformModelRef) {
            throw new ModelBindingConflictError();
          }
          if (input.modelRef) {
            if (row?.type !== "built_in") {
              throw new ModelBindingNotApplicableError(id);
            }
            const [model] = await transaction
              .select({ id: modelRegistry.id })
              .from(modelRegistry)
              .where(
                and(
                  eq(modelRegistry.id, input.modelRef),
                  eq(modelRegistry.enabled, true),
                ),
              )
              .limit(1);
            if (!model) throw new ModelNotInLibraryError();
          }
          /*
           * A platform pool binding (stories H1, K1), checked the same way: the foreign key alone
           * would take a switched-off row, or a Pro-only row for a Free tenant. The plan is the one
           * the RECORD's tenant is on, read on this transaction (whose session is that tenant's), and
           * no active subscription is Free — never Pro, never "no limit".
           */
          if (input.platformModelRef) {
            if (row?.type !== "built_in") {
              throw new ModelBindingNotApplicableError(id);
            }
            await assertPoolModelAllowed(
              transaction,
              id,
              input.platformModelRef,
            );
          }
          const written = await transaction
            .update(agentProfiles)
            .set({
              title: input.title,
              roleDescription: input.roleDescription,
              visibility: input.visibility,
              // Only when one was sent: an edit that never showed the avatar must not redraw it.
              ...(input.avatarSeed === undefined
                ? {}
                : { avatarSeed: input.avatarSeed }),
              ...(input.modelRef === undefined
                ? {}
                : { modelRef: input.modelRef }),
              ...(input.platformModelRef === undefined
                ? {}
                : { platformModelRef: input.platformModelRef }),
              // Binding one clears the other, so the one-binding CHECK is never what refuses a save.
              ...(input.modelRef ? { platformModelRef: null } : {}),
              ...(input.platformModelRef ? { modelRef: null } : {}),
              // Written whole rather than merged: a persona is read as one character, and a line the
              // person deleted should stop being said on the next turn.
              ...(input.persona === undefined
                ? {}
                : { persona: input.persona }),
              // The same three-way: absent leaves it, null clears it. Never copied into systemPrompt.
              ...(input.bible === undefined ? {} : { bible: input.bible }),
              // Absent leaves it alone; see `CreateAgentInput.isolated`.
              ...(input.isolated === undefined
                ? {}
                : { isolated: input.isolated }),
              updatedAt,
            })
            .where(eq(agentProfiles.agentId, id))
            .returning({ agentId: agentProfiles.agentId });
          exactlyOne(written, id);
          if (row) {
            await settleStamp(
              transaction,
              id,
              row.tenantId,
              input.visibility,
              profile.ownerUserId,
            );
          }

          const updated = await findAccessibleProfile(transaction, actor, id);
          if (!updated) throw new AgentNotFoundError(id);
          return updated;
        },
        { isolationLevel: "read committed" },
      );
    },

    async duplicate(actor, id, admit, options = {}) {
      /*
       * A copy is the duplicator's Bot, so it keeps a computer of its own only if they may give it
       * one. Asked up front for the reason `requireMayIsolate` gives, and answered for every
       * duplicate rather than only an isolated source's, because the source is read inside.
       */
      const mayKeepIsolated = await mayIsolate(actor.id);
      return database.transaction(async (transaction) => {
        await admit?.(transaction);
        const source = await findAccessibleProfile(transaction, actor, id);
        if (!source) throw new AgentNotFoundError(id);

        /*
         * The stored row, because a profile does not carry what a copy has to reproduce.
         *
         * `AgentProfile` projects `endpoint` out of the configuration and nothing else, which is all
         * an edit form needs and half of what this needs: a `built_in` coworker has no endpoint and
         * a prompt instead. Read here rather than widened into the profile, so the DTO every surface
         * gets does not start carrying a Bot's instructions. Inside the transaction, and after the
         * access check, so this cannot read a row the caller may not see.
         */
        const [stored] = await transaction
          .select({ type: agents.type, configuration: agents.configuration })
          .from(agents)
          .where(eq(agents.id, id))
          .limit(1);
        if (!stored) throw new AgentNotFoundError(id);

        // `auth` is a vault reference and is deliberately not carried: see `runForDuplicate`.
        const run = runForDuplicate(stored, managedConfiguration);
        // After the source read, so a source that brings its own endpoint or its own prompt needs no
        // managed Bot to fall back to.
        if (!run) {
          throw new ManagedAgentUnavailableError();
        }
        const duplicateId = newAgentId();
        await transaction.insert(agents).values({
          id: duplicateId,
          name: source.name,
          type: run.type,
          configuration: run.configuration,
        });
        await transaction.insert(agentProfiles).values({
          agentId: duplicateId,
          ownerUserId: actor.id,
          title: source.title,
          roleDescription: source.roleDescription,
          avatarSeed: source.avatarSeed,
          visibility: "private",
          // The copy is meant to behave like the original, which is the persona as much as the role.
          persona: source.persona,
          // And its handbook. Where those came from only for the template's own owner: somebody
          // else's template is not one the copy's owner can ever read or update from.
          bible: source.bible ?? null,
          ...(source.roleTemplate && source.ownerUserId === actor.id
            ? {
                roleTemplateId: source.roleTemplate.id,
                roleTemplateVersion: source.roleTemplate.version,
              }
            : {}),
          isolated: source.isolated && mayKeepIsolated,
          // The face it was shipped with travels with it, so a copy of a preset looks like the preset.
          presetPortrait: source.presetPortrait ?? null,
          ...(options.summonedFrom
            ? { summonedFrom: options.summonedFrom }
            : {}),
        });

        const duplicate = await findAccessibleProfile(
          transaction,
          actor,
          duplicateId,
        );
        if (!duplicate) throw new AgentNotFoundError(duplicateId);
        await options.alongside?.(transaction, duplicate);
        return duplicate;
      });
    },

    applyRole(actor, id, role, source) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          requireManageable(actor, profile);
          // D4 (revised 2026-11-04): only the 分身 is refused.
          if (!profile.acceptsRoleTemplate) {
            throw new RoleTemplateNotApplicableError();
          }
          const columns = await roleTemplateSource(transaction, source);
          /*
           * A `built_in` coworker runs on `configuration.systemPrompt` and nothing else carries its
           * role description to the model, so a template that changes the description has to move the
           * prompt too, exactly as `update` does for the same edit by hand. Without it the screen would
           * show the template's role while the Bot kept answering on the old one.
           */
          if (role.roleDescription !== profile.roleDescription) {
            const [row] = await transaction
              .select({
                configuration: agents.configuration,
                type: agents.type,
              })
              .from(agents)
              .where(eq(agents.id, id))
              .limit(1);
            if (row?.type === "built_in") {
              exactlyOne(
                await transaction
                  .update(agents)
                  .set({
                    configuration: {
                      ...((row.configuration ?? {}) as Record<string, unknown>),
                      systemPrompt: role.roleDescription,
                    },
                    updatedAt: new Date(),
                  })
                  .where(eq(agents.id, id))
                  .returning({ id: agents.id }),
                id,
              );
            }
          }
          exactlyOne(
            await transaction
              .update(agentProfiles)
              .set({
                title: role.title,
                roleDescription: role.roleDescription,
                persona: role.persona,
                bible: role.bible,
                ...columns,
                updatedAt: new Date(),
              })
              .where(eq(agentProfiles.agentId, id))
              .returning({ agentId: agentProfiles.agentId }),
            id,
          );
          const updated = await findAccessibleProfile(transaction, actor, id);
          if (!updated) throw new AgentNotFoundError(id);
          return updated;
        },
        { isolationLevel: "read committed" },
      );
    },

    setHidden(actor, id, hidden) {
      return database.transaction(async (transaction) => {
        const profile = await findAccessibleProfile(transaction, actor, id);
        if (!profile) throw new AgentNotFoundError(id);
        // An administrator put this Team Bot in this person's sidebar; it stays there.
        if (hidden) {
          const [assigned] = await transaction
            .select({ agentId: teamBotPublications.agentId })
            .from(teamBotPublications)
            .where(
              and(
                eq(teamBotPublications.agentId, id),
                sql`${assignedCondition(actor.id)}`,
              ),
            )
            .limit(1);
          if (assigned) throw new AgentAssignedError(id);
        }

        await transaction
          .insert(agentPreferences)
          .values({
            userId: actor.id,
            agentId: id,
            hiddenAt: hidden ? new Date() : null,
          })
          .onConflictDoUpdate({
            target: [agentPreferences.userId, agentPreferences.agentId],
            set: { hiddenAt: hidden ? new Date() : null },
          });
      });
    },

    /*
     * The same row as hiding, one column over, and the upsert sets only its own column: pinning a
     * hidden coworker keeps it hidden, and it comes back pinned when it is unhidden. Two people, or
     * two tabs, pinning at once meet on the (user, agent) primary key, so the second write updates
     * the row the first one made instead of failing.
     */
    setPinned(actor, id, pinned) {
      return database.transaction(async (transaction) => {
        const profile = await findAccessibleProfile(transaction, actor, id);
        if (!profile) throw new AgentNotFoundError(id);

        await transaction
          .insert(agentPreferences)
          .values({
            userId: actor.id,
            agentId: id,
            pinnedAt: pinned ? new Date() : null,
          })
          .onConflictDoUpdate({
            target: [agentPreferences.userId, agentPreferences.agentId],
            set: { pinnedAt: pinned ? new Date() : null },
          });
      });
    },

    softDelete(actor, id) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          requireManageable(actor, profile);

          const deletedAt = new Date();
          exactlyOne(
            await transaction
              .update(agentProfiles)
              .set({ deletedAt, updatedAt: deletedAt })
              .where(eq(agentProfiles.agentId, id))
              .returning({ agentId: agentProfiles.agentId }),
            id,
          );

          /*
           * And its key stops working.
           *
           * A deleted Bot left its credential in the vault, decryptable and still valid, with
           * nothing listing it and no screen able to reach it: deleting the Bot was the last chance
           * anybody had to retire it. The profile is a soft delete, deliberately, but the key is not
           * something to keep pending an undelete that would ask for a new one anyway.
           */
          if (vault) {
            const [row] = await transaction
              .select({ configuration: agents.configuration })
              .from(agents)
              .where(eq(agents.id, id))
              .limit(1);
            await retireReplacedKey(
              vault.store,
              (row?.configuration ?? {}) as Record<string, unknown>,
              {},
              // In this transaction, so the key is retired exactly when the deletion is. On its own
              // connection the revoke would commit even where the delete rolled back, leaving a Bot
              // that still exists and can no longer reach its endpoint.
              transaction,
            );
          }
        },
        { isolationLevel: "read committed" },
      );
    },

    issueCallbackToken(actor, id) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          /*
           * Whoever may change the agent may credential it.
           *
           * The same gate as renaming it or repointing its endpoint, and repointing the endpoint is
           * the more dangerous of the two: it decides which process the token is for.
           */
          requireManageable(actor, profile);

          const token = mintCallbackToken();
          const issuedAt = new Date();
          // A token that was not stored is never handed out: it would authenticate nothing.
          exactlyOne(
            await transaction
              .update(agentProfiles)
              .set({
                callbackTokenHash: hashCallbackToken(token),
                callbackTokenIssuedAt: issuedAt,
                updatedAt: issuedAt,
              })
              .where(eq(agentProfiles.agentId, id))
              .returning({ agentId: agentProfiles.agentId }),
            id,
          );

          // The only time it is readable. Nothing here writes it to a log.
          return token;
        },
        { isolationLevel: "read committed" },
      );
    },

    revokeCallbackToken(actor, id) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          requireManageable(actor, profile);

          const now = new Date();
          exactlyOne(
            await transaction
              .update(agentProfiles)
              .set({
                callbackTokenHash: null,
                callbackTokenIssuedAt: null,
                updatedAt: now,
              })
              .where(eq(agentProfiles.agentId, id))
              .returning({ agentId: agentProfiles.agentId }),
            id,
          );
        },
        { isolationLevel: "read committed" },
      );
    },

    agentForCallbackToken(hash) {
      /*
       * A NARROW PLATFORM READ (G01-E PCB). The one non-deleted profile whose stored hash is this
       * one, and only its id and stamp: what the route needs to decide which frame the call then runs
       * in. Everything after that runs in a person's frame, never in this one.
       */
      return asPlatform(() => findByTokenHash(database, hash));
    },
  };
}
