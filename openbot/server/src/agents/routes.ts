import { isDevActorEmail } from "../auth/dev-actor-email";
import { declaredHarness } from "@openbot/shared/harnesses";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditEventType, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AdminScope } from "../auth/admin-scope";
import type { AppVariables } from "../auth/guards";
import type { QuotaService } from "../quota/limits";
import { QuotaExceeded } from "../quota/limits";
import { capabilityFor, isPersonTenant } from "../tenant/context";
import { testAgentConnection } from "./connection-test";
import { checkAgentEndpoint } from "./endpoint";
import { takesModelChoice } from "./harness-model";
import { isolationState, mayIsolate } from "./isolation";
import { isManagedEndpoint } from "./managed-endpoint";
import { canManageAgent } from "./profile-policy";
import {
  AgentAssignedError,
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
  IsolationRefusedError,
  ManagedAgentUnavailableError,
  ModelBindingConflictError,
  ModelBindingNotApplicableError,
  ModelNotInLibraryError,
  OwnerlessBotPrivateError,
  PlatformModelNotAvailableError,
  ProtectedAgentError,
  RoleTemplateNotApplicableError,
  RoleTemplateSourceError,
} from "./profile-store";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
  Persona,
} from "./profile-types";
import { englishName } from "../brand";

type AgentInputParseResult =
  | { ok: true; value: CreateAgentInput }
  | { ok: false; error: string };

type AgentInputObject = {
  name?: unknown;
  title?: unknown;
  roleDescription?: unknown;
  visibility?: unknown;
  endpoint?: unknown;
  auth?: unknown;
  modelRef?: unknown;
  platformModelRef?: unknown;
  persona?: unknown;
  bible?: unknown;
  avatarSeed?: unknown;
  roleTemplate?: unknown;
  isolated?: unknown;
  instructions?: unknown;
  harness?: unknown;
};

/** The longest 工作手册 a coworker may carry (ROLE1, D3), in characters as the database counts them. */
export const BIBLE_MAX_CHARACTERS = 8000;

/**
 * What an avatar seed may be: what the form draws from and what every surface hands boring-avatars.
 *
 * Bounded and kept to word characters plus `-`, `:` and `.` — the shape existing seeds already have
 * (agent ids, `avatar-<uuid>`) — so a seed is never a place to park arbitrary text in a profile.
 */
const AVATAR_SEED = /^[\w:.-]{1,64}$/;

/**
 * Parse and validate what a user typed into the agent form.
 *
 * `allowPrivateHosts` is passed in rather than read from configuration here so this stays a pure
 * function: a developer's own agent lives on localhost, and a hosted deployment must refuse exactly
 * that, so the answer depends on the deployment and the test suite needs to exercise both.
 */
export function parseAgentInput(
  input: unknown,
  allowPrivateHosts = false,
  /** Private addresses this deployment named as acceptable. Empty is the default posture. */
  allowedHosts: ReadonlySet<string> = new Set(),
  /** The deployment's own agent addresses, reachable at exactly those URLs; see checkAgentEndpoint. */
  managedEndpoints?: readonly (string | URL)[],
): AgentInputParseResult {
  if (!isAgentInputObject(input)) {
    return { ok: false, error: "Agent input must be a JSON object." };
  }

  const name = boundedText(
    input.name,
    80,
    "Name must be text between 1 and 80 characters.",
  );
  if (typeof name !== "string") return name;

  if (typeof input.title !== "string" || input.title.trim().length > 120) {
    return {
      ok: false,
      error: "Title must be text of 120 characters or fewer.",
    };
  }
  const title = input.title.trim();

  const roleDescription = boundedText(
    input.roleDescription,
    1000,
    "What it does must be text between 1 and 1000 characters.",
  );
  if (typeof roleDescription !== "string") return roleDescription;

  if (typeof input.visibility !== "string") {
    return { ok: false, error: "Visibility must be public or private." };
  }
  const visibility = input.visibility.trim();
  if (visibility !== "public" && visibility !== "private") {
    return { ok: false, error: "Visibility must be public or private." };
  }

  // The endpoint is optional and checked. Absent means the Bot in the box, which is what most people
  // want on their first go. Present means this server will POST to an address a person chose, so it
  // goes through the same target check as navigation before it is allowed anywhere near the database.
  let endpoint: string | undefined;
  if (input.endpoint !== undefined && input.endpoint !== "") {
    const verdict = checkAgentEndpoint(input.endpoint, {
      allowPrivateHosts,
      allowedHosts,
      ...(managedEndpoints ? { managedEndpoints } : {}),
    });
    if (!verdict.allowed) return { ok: false, error: verdict.reason };
    endpoint = verdict.url;
  }

  // The key is optional and write-only. An absent field leaves an existing key alone; sending one
  // replaces it. There is no way to read one back, here or anywhere.
  let auth: { header: string; value: string } | undefined;
  if (input.auth !== undefined && input.auth !== null) {
    const supplied = input.auth as { header?: unknown; value?: unknown };
    const value =
      typeof supplied.value === "string" ? supplied.value.trim() : "";
    if (value) {
      const header =
        typeof supplied.header === "string" && supplied.header.trim()
          ? supplied.header.trim()
          : "Authorization";
      if (!/^[A-Za-z0-9-]+$/.test(header)) {
        return { ok: false, error: "That is not a valid header name." };
      }
      // Refused here rather than discovered on the first run. This value is encrypted and stored,
      // and then sent as a header on every turn the Bot takes; one that cannot be a header value
      // throws inside `fetch` every one of those times, long after the form said it was saved.
      const unsendable = unsendableHeaderValue(value);
      if (unsendable) {
        return {
          ok: false,
          error: `That key contains ${unsendable}, so it cannot be sent as a header.`,
        };
      }
      auth = { header, value };
    }
  }

  /*
   * The model this coworker runs on, chosen from the tenant's own library. Absent leaves the binding
   * alone and an explicit null clears it — the same three-way the key above uses, because this is one
   * form and a save that dropped a field must not rewrite it. Whether the id is one this person holds
   * is decided in the store, where the library is read under this person's tenant scope.
   */
  const persona = parsePersona(input.persona);
  if (typeof persona === "string") return { ok: false, error: persona };
  const bible = parseBible(input.bible);
  if (typeof bible === "object" && bible !== null) return bible;

  // Optional on create and on update alike. Absent means "the default" on a create and "leave it"
  // on an update, so a form that never showed the avatar cannot redraw it; anything sent is checked.
  let avatarSeed: string | undefined;
  if (input.avatarSeed !== undefined) {
    if (
      typeof input.avatarSeed !== "string" ||
      !AVATAR_SEED.test(input.avatarSeed)
    ) {
      return {
        ok: false,
        error:
          "Avatar seed must be 1 to 64 letters, digits or the characters _ - : .",
      };
    }
    avatarSeed = input.avatarSeed;
  }

  const modelRef = parseModelReference(input.modelRef);
  if (modelRef === INVALID_REFERENCE) {
    return { ok: false, error: "Pick a model from your model library." };
  }
  /*
   * The platform pool (stories H1, K1), with the same three-way. Whether the row is enabled and the
   * tenant's plan may use it is decided in the store, under the record's own tenant.
   */
  const platformModelRef = parseModelReference(input.platformModelRef);
  if (platformModelRef === INVALID_REFERENCE) {
    return { ok: false, error: "请从平台体验模型中选择一个模型。" };
  }
  // One model per coworker: naming both is a form that does not know which one it meant.
  if (modelRef && platformModelRef) {
    return {
      ok: false,
      error: "一个员工只能绑定一个模型：请在模型库与平台体验模型之间二选一。",
    };
  }

  // Absent is "leave it as it is", so only a present value is checked. A string "true" is refused
  // rather than read as yes: this decides which computer a Bot runs on.
  if (input.isolated !== undefined && typeof input.isolated !== "boolean") {
    return { ok: false, error: "Isolated must be true or false." };
  }
  const isolated = input.isolated;

  /*
   * The framework a person named for an agent they run themselves, by its id in the harness list.
   * Kept only with an address: a Bot with none runs here, on OpenBot. See `frameworkOf`.
   */
  let harness: string | undefined;
  if (input.harness !== undefined && input.harness !== "") {
    const named = declaredHarness(input.harness);
    if (!named)
      return {
        ok: false,
        error: `${englishName()} doesn't know that framework. Pick one from the list.`,
      };
    if (endpoint) harness = named.id;
  }

  // Absent leaves them as they are. Only the personal starter keeps instructions apart from what
  // it does, and the same limit holds for them as held when they were edited as that text.
  let instructions: string | undefined;
  if (input.instructions !== undefined) {
    const bounded = boundedText(
      input.instructions,
      1000,
      "Instructions must be text between 1 and 1000 characters.",
    );
    if (typeof bounded !== "string") return bounded;
    instructions = bounded;
  }

  return {
    ok: true,
    value: {
      name,
      title,
      roleDescription,
      visibility,
      endpoint,
      auth,
      modelRef,
      platformModelRef,
      // Only sent when the form knew about it, so a save that never touched the persona boxes leaves
      // the stored one where it is.
      ...(persona === undefined ? {} : { persona }),
      // The same: a form that never showed the handbook leaves it alone.
      ...(bible === undefined ? {} : { bible }),
      ...(avatarSeed === undefined ? {} : { avatarSeed }),
      ...(isolated === undefined ? {} : { isolated }),
      ...(instructions === undefined ? {} : { instructions }),
      ...(harness === undefined ? {} : { harness }),
    },
  };
}

const INVALID_REFERENCE = Symbol("invalid model reference");

/**
 * A model id from the form: absent leaves the binding alone, null or empty clears it, a uuid binds.
 * Anything else is refused rather than guessed at.
 */
function parseModelReference(
  value: unknown,
): string | null | undefined | typeof INVALID_REFERENCE {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    return value;
  }
  return INVALID_REFERENCE;
}

/**
 * The persona boxes, or the sentence about why they were refused.
 *
 * Bounded per part because this text goes into every prompt the coworker takes: one long paste would
 * be paid for on every turn of every channel. A part that is only whitespace is stored as nothing —
 * a persona is read as one character, and an empty part must not reserve a line in the prompt.
 */
function parsePersona(value: unknown): Persona | undefined | string {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "That is not a persona.";
  }
  const given = value as Record<string, unknown>;
  const parts: Partial<Record<keyof Persona, string>> = {};
  for (const key of ["tone", "principles", "habits"] as const) {
    const entry = given[key];
    if (entry === undefined || entry === null) {
      parts[key] = "";
      continue;
    }
    if (typeof entry !== "string") return `The ${key} line must be text.`;
    const trimmed = entry.trim();
    if (trimmed.length > 2_000) {
      return `The ${key} line must be 2,000 characters or fewer.`;
    }
    parts[key] = trimmed;
  }
  return {
    tone: parts.tone ?? "",
    principles: parts.principles ?? "",
    habits: parts.habits ?? "",
  };
}

/**
 * The 工作手册 (ROLE1): absent leaves it, null or blank clears it, text up to 8000 characters writes it.
 *
 * Counted in code points, as the database's CHECK counts them, so a handbook the form accepted is one
 * the row accepts. Over the limit is refused, never cut: a handbook missing its last section reads as
 * complete to the model.
 */
function parseBible(
  value: unknown,
): string | null | undefined | { ok: false; error: string } {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string")
    return { ok: false, error: "手册必须是文字。" };
  const trimmed = value.trim();
  if (!trimmed) return null;
  if ([...trimmed].length > BIBLE_MAX_CHARACTERS) {
    return {
      ok: false,
      error: `手册不能超过 ${BIBLE_MAX_CHARACTERS} 字。`,
    };
  }
  return trimmed;
}

/**
 * The role template a new coworker starts from (ROLE1): absent, or a template id and the version
 * the form loaded. Whether it is the creator's is decided in the store, under their frame.
 */
function parseRoleTemplateSource(
  value: unknown,
): { id: string; version: number } | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const { id, version } = value as { id?: unknown; version?: unknown };
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id,
    ) ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    return null;
  }
  return { id, version };
}

function isAgentInputObject(input: unknown): input is AgentInputObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * What in this value stops it being a header, or null when nothing does.
 *
 * `new Headers()` refuses a line break, a NUL, and any code point above U+00FF, and it refuses them
 * by throwing a TypeError from inside `fetch` — which is not a decision this deployment gets to
 * take part in. Both surfaces below take a header value from the same box on the same form and
 * neither looked, so the throw arrived somewhere that reads as something else entirely: on the
 * connection test it lands in the catch written for a dead host, and the person is told "this server
 * could not reach that address", which sends them to their tunnel and their firewall over a key
 * they had just pasted with a wrapped line in it. A hyphen a document turned into an en dash does
 * the same thing, and looks like nothing at all in a password box.
 *
 * The description never contains the value. This is asked of a credential on one of the two paths,
 * and one character of a secret in an error message is one character too many.
 */
function unsendableHeaderValue(value: string): string | null {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x0d) return "a line break";
    if (code === 0) return "a null character";
    if (code > 0xff) return "a character that cannot go in a header value";
  }
  return null;
}

/**
 * Parse and validate the headers a person attaches to a connection test.
 *
 * Unvalidated, the route cast any object straight into the probe `fetch`, so an array value, a
 * nested object, or a `__proto__` key travelled into the network call and threw a TypeError 500 —
 * or probed header handling the deployment never meant to exercise. Names follow the same rule as
 * the stored agent auth header; values must be strings; the whole map is capped so a pasted dump
 * cannot balloon the probe.
 */
export function parseConnectionHeaders(
  input: unknown,
):
  | { ok: true; value: Record<string, string> | undefined }
  | { ok: false; error: string } {
  if (input === undefined) return { ok: true, value: undefined };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Headers must be an object of name to value." };
  }
  /*
   * A JSON body carrying `__proto__` does not arrive as an own property: `JSON.parse` sets the
   * object's prototype instead, so `Object.entries` never sees it and a name block-list below
   * would pass it straight through into the probe fetch. Refuse any headers object whose prototype
   * is not a plain one before reading entries.
   */
  if (Object.getPrototypeOf(input) !== Object.prototype) {
    return { ok: false, error: "Headers must be an object of name to value." };
  }
  const entries = Object.entries(input);
  if (entries.length > 32) {
    return { ok: false, error: "Headers must have at most 32 entries." };
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (
      name === "__proto__" ||
      name === "constructor" ||
      name === "prototype" ||
      !/^[A-Za-z0-9-]+$/.test(name) ||
      name.length > 64
    ) {
      return {
        ok: false,
        error: `That is not a valid header name: ${name.slice(0, 64)}.`,
      };
    }
    if (typeof value !== "string") {
      return {
        ok: false,
        error: `Header "${name}" must be a string value.`,
      };
    }
    if (value.length > 4096) {
      return {
        ok: false,
        error: `Header "${name}" must be at most 4096 characters.`,
      };
    }
    const unsendable = unsendableHeaderValue(value);
    if (unsendable) {
      return {
        ok: false,
        error: `Header "${name}" contains ${unsendable}, so it cannot be sent.`,
      };
    }
    headers[name] = value;
  }
  return { ok: true, value: entries.length === 0 ? undefined : headers };
}

export function createAgentRoutes(
  store: AgentProfileStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Whether this deployment may talk to its own network. True on a laptop, false when hosted. */
  allowPrivateHosts = false,
  /** Where a Bot's own refusal is recorded. Absent in tests that do not care about the trail. */
  auditStore?: AuditStore,
  /**
   * Private addresses this deployment named as acceptable for an agent to live at.
   *
   * Separate from `allowPrivateHosts` on purpose: that one opens the network, this one opens an
   * address. A hosted deployment sets this and leaves the other off.
   */
  allowedHosts: ReadonlySet<string> = new Set(),
  /**
   * Which Bots a Bot may hand work to, for the screen that grants it.
   *
   * A named object rather than another positional argument: every parameter above this one is
   * optional, so a misplaced one typechecks and silently does nothing, and this list is already at
   * the length where that stops being hypothetical.
   *
   * Absent in a deployment with no plugin store, which is a deployment where no Bot may address any
   * other. The screen is then told the capability is off rather than shown a control that grants
   * nothing.
   */
  handoff?: {
    /** Whether the deployment's own caps leave the capability switched on at all. */
    enabled: boolean;
    /** The Bots this one may address today, read per call so a revoked grant stops showing. */
    reachableFrom: (agentId: string) => Promise<readonly string[]>;
    /**
     * Whether this Bot can be a grantee at all: any Bot that exists, built in or at its own
     * endpoint, since both reach the same handoff desk. Optional so a caller without a plugin store
     * answers "no" rather than crashing the read.
     */
    canHandOn?: (agentId: string) => Promise<boolean | undefined>;
  },
  /**
   * Whether a coworker can be created with no endpoint, i.e. run here.
   *
   * It runs on the managed Bot when there is one, and otherwise in this server on its role
   * description (`create`'s `built_in` branch). This exists so a screen can say so before somebody
   * fills in three steps of a form that was always going to fail.
   */
  builtInAvailable = false,
  /**
   * The managed Bot's own address, so a coworker created without an endpoint can be told apart.
   *
   * Creation bakes this address into the coworker's stored configuration, and afterwards nothing in
   * the row says whether a person supplied it. The difference matters to exactly one screen: a
   * coworker running here calls tools back with the deployment's own credential and needs no setup,
   * while one a person hosts needs a callback token put into their process. Without this flag the
   * dialog nagged built-in coworkers about a credential they never needed.
   */
  managedEndpoint?: string,
  /**
   * How many coworkers this tenant's plan allows, when this deployment counts them (ticket 022).
   *
   * The route passes admission into the store's transaction. The count and write use its own session,
   * holding a tenant lock until commit; concurrent requests cannot spend the same remaining seat.
   */
  quota?: QuotaService,
  /**
   * How an administrator reaches somebody else's Bot (G01-E P8b, Q1, R10). Their own frame shows them
   * what it shows anyone: their own Bots, the team's and the catalogue. On the Bot's own read, edit
   * and delete routes, an administrator holding the capability also finds another person's Bot as
   * `platform`, and changes it in its OWNER's frame (`adminActAsOwner`), so the write is the owner's
   * as far as the team policies are concerned and the trail row lands with the owner. Absent, those
   * routes answer an administrator exactly as they answer anyone.
   */
  adminScope?: Pick<
    AdminScope,
    "adminCapability" | "adminActAsOwner" | "asAdminPlatform"
  >,
  /**
   * The deployment's own token and the addresses it belongs to, so a connection test against one of
   * them knocks the way a real run will.
   *
   * A named object rather than two more positional strings, for the reason the handoff parameter
   * gives: everything above it is optional, and a misplaced string typechecks.
   *
   * `endpoints` is every address this deployment runs — the Bot in the box and any harness picked
   * during setup — because the run path had to learn that same lesson: matching only the first left
   * the picked harness answering 401 to everything.
   */
  managedRun?: { token: string; endpoints: readonly (string | URL)[] },
  /**
   * Whether this deployment can give one Bot a computer of its own (`deploymentCanIsolate`).
   *
   * Absent is no: a deployment that never said it can make a second computer is not trusted to.
   */
  isolation?: { available: boolean },
  /**
   * The name this server's container reaches the person's machine by (`OPENBOT_THIS_MACHINE_HOST`),
   * so a connection test dials an agent on their loopback where a run will. See onThisMachine.
   */
  dial?: { thisMachineHost?: string },
) {
  const isolationAvailable = isolation?.available ?? false;
  /** The plan's refusal as a response, or null when there is room. A create and a duplicate answer alike. */
  const overPlan = async (tenantId: string): Promise<Response | null> => {
    if (!quota) return null;
    try {
      await quota.assertCapacity(tenantId, "wakers");
      return null;
    } catch (thrown) {
      if (!(thrown instanceof QuotaExceeded)) throw thrown;
      return Response.json(thrown.body, { status: 402 });
    }
  };
  /** The dto with the one fact only this closure knows: whether the coworker runs on our own Bot. */
  const dto = (actor: AgentActor, agent: AgentProfile) => ({
    ...agentDto(actor, agent),
    // A string comparison on purpose: two absent values must not read as "runs on our Bot".
    builtIn:
      typeof agent.endpoint === "string" && agent.endpoint === managedEndpoint,
    /*
     * Whether it runs on this deployment's model, so a person can pick the model and effort per
     * conversation: a `built_in` Bot (no endpoint), or the harness picked in setup when it is one of
     * OpenBot's own that takes the choice. A Bot on any other framework picks its own model.
     */
    runsOnOpenBotModel:
      agent.endpoint === null || takesModelChoice(agent.endpoint),
    /*
     * Whether OpenBot gives it a key on every run, as it does at every address it runs itself: the
     * Bot in the box and the harness picked in setup (see runtime-agents.ts). Such a Bot uses its
     * tools with no key of its own, so its Setup page must not say it can't.
     */
    keyFromOpenBot:
      typeof agent.endpoint === "string" &&
      managedRun !== undefined &&
      isManagedEndpoint(agent.endpoint, managedRun.endpoints),
  });
  /**
   * The dtos, each with whether its computer of its own is in effect now.
   *
   * Asked of the OWNER's switch, read now, so an administrator withdrawing "Isolated Bots" shows on
   * the Bot's page at its next load without anybody editing the Bot. Read once per owner and one
   * owner at a time, and only for Bots that asked: a roster is mostly people's own Bots, and most of
   * those are not isolated.
   */
  const dtos = async (actor: AgentActor, list: readonly AgentProfile[]) => {
    const owners = new Map<string, boolean>();
    for (const agent of list) {
      if (!agent.isolated || !agent.ownerUserId) continue;
      if (owners.has(agent.ownerUserId)) continue;
      owners.set(agent.ownerUserId, await mayIsolate(agent.ownerUserId));
    }
    return list.map((agent) => ({
      ...dto(actor, agent),
      ...isolationState(
        agent,
        isolationAvailable,
        agent.ownerUserId ? (owners.get(agent.ownerUserId) ?? false) : false,
      ),
    }));
  };
  const dtoOf = async (actor: AgentActor, agent: AgentProfile) =>
    (await dtos(actor, [agent]))[0];
  const routes = new Hono<{ Variables: AppVariables }>();

  /*
   * Signed in, and for an administrator the request-scoped capability the admin doors below demand.
   * `adminCapability` re-reads the role, so a role removed since sign-in holds nothing here.
   */
  const adminCapability: MiddlewareHandler<{ Variables: AppVariables }> =
    adminScope?.adminCapability ?? ((_context, next) => next());
  const signedInAsAdmin: MiddlewareHandler<{
    Variables: AppVariables;
  }> = (context, next) =>
    requireUser(context, async () => {
      await adminCapability(context, next);
    });
  /** The admin doors, only for an administrator who holds the capability in this request. */
  const adminDoors = (actor: AgentActor) =>
    adminScope && actor.role === "admin" && capabilityFor(actor.id) === "admin"
      ? adminScope
      : undefined;
  /**
   * Where an administrator's write on this Bot must run, read as `platform` because the Bot may be
   * one the administrator's own frame cannot see:
   * - another person's Bot: in that OWNER's frame (`adminActAsOwner`), so the write is the owner's as
   *   far as the team policies are concerned and the trail row lands with the owner;
   * - a Bot nobody owns any more (its owner's account was deleted, `owner_user_id` set null): no
   *   person's frame may write it, a team Bot's included, so as `platform` (`asAdminPlatform`);
   * - otherwise (not an administrator with the capability, their own Bot, no such Bot) the caller's
   *   own frame, which answers exactly as it answers anyone.
   */
  const adminTarget = async (
    actor: AgentActor,
    agentId: string,
  ): Promise<{ owner: string } | "platform" | undefined> => {
    const doors = adminDoors(actor);
    if (!doors) return undefined;
    const found = await doors.asAdminPlatform(actor, () =>
      store.get(actor, agentId),
    );
    if (!found) return undefined;
    const owner = found.ownerUserId;
    if (owner === null) return "platform";
    return isPersonTenant(owner) && owner !== actor.id ? { owner } : undefined;
  };
  /** `work` where {@link adminTarget} says an administrator's write belongs, else here. */
  const asOwnerWhereAdmin = async <T>(
    actor: AgentActor,
    agentId: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const target = await adminTarget(actor, agentId);
    const doors = adminDoors(actor);
    if (!target || !doors) return work();
    return target === "platform"
      ? doors.asAdminPlatform(actor, work)
      : doors.adminActAsOwner(actor, target.owner, work);
  };

  /**
   * The Bot declined something, and says so.
   *
   * The audit trail records what a Bot did, decided by the gateway on the way to an action. A model
   * that refuses before calling any tool takes no action, so this records the attempted request.
   *
   * Self-reported, and said so in the row. The Bot calls this because its tool description tells it
   * to, so a model that declines without a tool call still writes nothing. This is evidence, not enforcement:
   * nothing is prevented by it, and a reader must not mistake an empty list for an untroubled Bot.
   */
  routes.post("/:agentId/declined", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    const body = (await context.req.json().catch(() => null)) as {
      reason?: unknown;
      request?: unknown;
    } | null;

    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      return context.json({ error: "A reason is required." }, 400);
    }

    /*
     * The same question every other route here asks first: is this a Bot the caller may reach?
     *
     * The row says "reportedBy: the Bot itself", and the Bot reports through the person's session,
     * so the trail's only way of knowing the report came from a Bot is that the person could have
     * been talking to that Bot. Without this check, any signed-in person could write a decline
     * against any id at all, a coworker they cannot see included, and an administrator reading the
     * trail would take it for something the Bot said. Not found rather than forbidden, as the store
     * answers everywhere else, so the check does not confirm which ids exist.
     */
    const agent = await store.get(context.var.actor, agentId);
    if (!agent) {
      return context.json({ error: "Couldn't find that Bot." }, 404);
    }

    if (auditStore) {
      const actor = context.var.actor;
      await recordAuditEvent(auditStore, {
        eventType: "bot.declined",
        targetType: "agent",
        targetId: agentId,
        ...(actor?.id && !isDevActorEmail(actor.email)
          ? { actorUserId: actor.id }
          : {}),
        payload: {
          bot: agentId,
          actor: actor?.email ?? "unknown",
          reason: reason.slice(0, 500),
          // What it was asked, in the Bot's own words and only if it offered them. Truncated for the
          // same reason every other payload here is: a trail is not a transcript.
          ...(typeof body?.request === "string" && body.request.trim()
            ? { request: body.request.trim().slice(0, 500) }
            : {}),
          reportedBy: "the Bot itself",
        },
      });
    }

    return context.json({ recorded: true });
  });

  routes.get("/", requireUser, async (context) => {
    try {
      const hidden = context.req.query("hidden") === "true";
      const agents = await store.list(context.var.actor, hidden);
      return context.json({
        agents: await dtos(context.var.actor, agents),
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * What kinds of coworker this deployment can create, for the screen that asks.
   *
   * Static per process: whether a managed Bot exists is deployment configuration, not data. Above
   * the parameterised route on purpose, so "capabilities" can never be read as an agent id.
   */
  routes.get("/capabilities", requireUser, (context) =>
    context.json({
      capabilities: {
        builtInAvailable,
        // Whether this person may tick it is a switch, read from `/api/admin/enterprise/me`.
        isolationAvailable,
      },
    }),
  );

  routes.get("/:agentId", signedInAsAdmin, async (context) => {
    // A whitespace id would reach the store query and answer 500 on some backends instead of a
    // 400 for a malformed call. Existence stays a 404; shape is checked here.
    if (!context.req.param("agentId").trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      const actor = context.var.actor;
      const agentId = context.req.param("agentId");
      const doors = adminDoors(actor);
      const agent =
        (await store.get(actor, agentId)) ??
        // Somebody else's private Bot is reached from the admin pages only, as `platform` (Q1).
        (doors
          ? await doors.asAdminPlatform(actor, () => store.get(actor, agentId))
          : null);
      if (!agent) {
        return context.json({ error: "Couldn't find that Bot." }, 404);
      }
      return context.json({ agent: await dtoOf(context.var.actor, agent) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * Try an endpoint before saving it.
   *
   * Deliberately not part of create: a person needs to know whether their agent answers before they
   * commit to it, and they need to be able to try again without creating dead
   * Bots on the way. It runs the same target check as saving, so it cannot probe addresses that
   * registration would refuse.
   */
  routes.post("/test-connection", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      endpoint?: unknown;
      headers?: unknown;
    } | null;
    const parsed = parseConnectionHeaders(body?.headers);
    if (!parsed.ok) {
      return context.json({ error: parsed.error }, 400);
    }
    /*
     * An address this deployment runs is knocked on with this deployment's token.
     *
     * Nobody types that token — the run path attaches it by recognising the address — so a test
     * that left it off reported "The agent refused this request. If it needs a key, add it as a
     * header." for the Bot in the box and for the harness picked during setup. Both work; the
     * advice was to break them.
     *
     * The person's own headers are applied over these rather than under, because a header they
     * typed is a thing they can see and change, and this one is not.
     */
    const ours =
      managedRun &&
      typeof body?.endpoint === "string" &&
      isManagedEndpoint(body.endpoint, managedRun.endpoints);
    const headers = {
      ...(ours ? { "x-openbot-agent-token": managedRun.token } : {}),
      ...parsed.value,
    };
    const result = await testAgentConnection(body?.endpoint, {
      // Absent rather than empty when there is nothing to send, so a deployment with no managed Bot
      // probes exactly as it did before this.
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      allowPrivateHosts,
      allowedHosts,
      // Our own addresses are reachable at exactly their URLs: the test must not refuse the Bot
      // this deployment started, and must not open anything else on its host.
      ...(managedRun ? { managedEndpoints: managedRun.endpoints } : {}),
      ...(dial?.thisMachineHost
        ? { thisMachineHost: dial.thisMachineHost }
        : {}),
    });
    // 200 either way: the request succeeded, and the verdict is the payload. A failed connection test
    // is an answer, not an error, and a 4xx here would have the surface render it as a broken button.
    return context.json(result);
  });

  /**
   * Record something that changed a Bot.
   *
   * One helper rather than eight copies, because the eight routes below all answer the same question
   * and the payload has to be the same shape for a reader filtering the trail.
   *
   * Never fatal. The change is already made and the caller has been told so; a trail that is briefly
   * unavailable is not a reason to report a failure that did not happen.
   */
  const record = async (
    context: Context<{ Variables: AppVariables }>,
    eventType: Extract<AuditEventType, `bot.${string}`>,
    /** Undefined only for a Bot that was refused before it existed. */
    agentId: string | undefined,
    payload: Record<string, unknown> = {},
  ): Promise<void> => {
    if (!auditStore) return;
    const actor = context.var.actor;
    try {
      await recordAuditEvent(auditStore, {
        eventType,
        targetType: "agent",
        ...(agentId ? { targetId: agentId } : {}),
        ...(actor?.id && !isDevActorEmail(actor.email)
          ? { actorUserId: actor.id }
          : {}),
        payload: {
          bot: agentId ?? null,
          actor: actor?.email ?? "unknown",
          ...payload,
        },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "bot-audit-write-failed",
          eventType,
          agentId,
          error: String(error),
        }),
      );
    }
  };

  /**
   * A computer of its own, asked for and refused, on the trail and in the answer.
   *
   * Recorded because nothing else would be: the Bot is unchanged, or was never made, so the row is
   * the only evidence of the attempt. Against the Bot it was asked for, or against no Bot on a create.
   * The answer has the shape the enterprise gate gives a refused capability, so a screen reads both
   * the same way.
   */
  const refuseIsolation = async (
    context: Context<{ Variables: AppVariables }>,
    reason: "capability" | "unowned" | "deployment",
    message: string,
    agentId: string | undefined,
    name: string,
  ): Promise<Response> => {
    await record(context, "bot.isolation_refused", agentId, {
      reason,
      name,
      ...(agentId ? {} : { attempted: "create" }),
    });
    return context.json(
      {
        error: message,
        ...(reason === "capability" ? { capability: "isolatedComputers" } : {}),
      },
      reason === "deployment" ? 400 : 403,
    );
  };
  /** Said where a deployment's computers cannot make one more. */
  const NO_ISOLATION =
    "This deployment can't give a Bot a computer of its own, so it runs on yours.";

  routes.post("/", requireUser, async (context) => {
    // Malformed JSON is a recoverable client-input error and is validated by the same parser.
    const body = await context.req.json().catch(() => null);
    const parsed = parseAgentInput(
      body,
      allowPrivateHosts,
      allowedHosts,
      managedRun?.endpoints,
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    if (parsed.value.isolated === true && !isolationAvailable) {
      return refuseIsolation(
        context,
        "deployment",
        NO_ISOLATION,
        undefined,
        parsed.value.name,
      );
    }
    // Create-only (ROLE1): the template the form started from. `update` never reads it.
    const roleTemplate = parseRoleTemplateSource(
      isAgentInputObject(body) ? body.roleTemplate : undefined,
    );
    if (roleTemplate === null) {
      return context.json({ error: "所选角色模板无效，请重新选择。" }, 400);
    }

    // The plan is asked before the row is written, and answers with its arithmetic.
    const blocked = await overPlan(context.var.actor.id);
    if (blocked) return blocked;

    try {
      /*
       * A coworker with no address runs here, on the text this form already requires.
       *
       * "Agent endpoint (optional)" was not optional on the recommended one-container image: with
       * nothing to bind to, `create` refused with "This deployment has no managed Bot", so a person
       * could not make a coworker at all on the image the README tells them to deploy. The role
       * description is what such a coworker runs on — the same field a `built_in` Bot in the tenant
       * package carries, for the same purpose — and passing it only when no endpoint was given keeps
       * every other path exactly as it was: give an address and it is a remote Bot, as before.
       */
      const agent = await store.create(
        context.var.actor,
        {
          ...parsed.value,
          ...(parsed.value.endpoint
            ? {}
            : { systemPrompt: parsed.value.roleDescription }),
          ...(roleTemplate ? { roleTemplate } : {}),
        },
        quota
          ? (transaction) =>
              quota.assertCapacityWithin(
                transaction,
                context.var.actor.id,
                "wakers",
              )
          : undefined,
      );
      /*
       * The endpoint, because that is where conversation content will be sent, and whether a key was
       * attached, because "this Bot authenticates" is a fact and the key itself never is.
       *
       * And who may reach it. `visibility` is not a display preference: `accessFilter` admits a
       * `public` coworker to every signed-in person, and `canRunAgent` is `canAccessAgent`, so public
       * means everybody in the deployment may act as this Bot and spend the grants it holds. A row
       * that cannot say which it was cannot reconstruct who could use this coworker at the time.
       */
      await record(context, "bot.created", agent.id, {
        name: parsed.value.name,
        visibility: parsed.value.visibility,
        ...(parsed.value.endpoint ? { endpoint: parsed.value.endpoint } : {}),
        hasKey: Boolean(parsed.value.auth),
        // Which computer it runs on is who it can reach, so a computer of its own is worth naming.
        ...(parsed.value.isolated ? { isolated: true } : {}),
      });
      return context.json(
        { agent: await dtoOf(context.var.actor, agent) },
        201,
      );
    } catch (error) {
      if (error instanceof IsolationRefusedError) {
        return refuseIsolation(
          context,
          error.reason,
          error.message,
          undefined,
          parsed.value.name,
        );
      }
      return mapStoreError(context, error);
    }
  });

  routes.patch("/:agentId", signedInAsAdmin, async (context) => {
    // Malformed JSON is a recoverable client-input error and is validated by the same parser.
    const parsed = parseAgentInput(
      await context.req.json().catch(() => null),
      allowPrivateHosts,
      allowedHosts,
      managedRun?.endpoints,
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    if (parsed.value.isolated === true && !isolationAvailable) {
      return refuseIsolation(
        context,
        "deployment",
        NO_ISOLATION,
        context.req.param("agentId"),
        parsed.value.name,
      );
    }

    try {
      const actor = context.var.actor;
      const agentId = context.req.param("agentId");
      // The write and its trail row together, in the owner's frame when an administrator acts.
      const agent = await asOwnerWhereAdmin(actor, agentId, async () => {
        const updated = await store.update(actor, agentId, parsed.value);
        /*
         * What changed, not the new values. Repointing the endpoint is the dangerous edit and is worth
         * naming; a replaced key is worth knowing about and is never worth recording.
         *
         * `visibility` is carried the way `name` is — on every row, whether or not this edit moved it —
         * because it is the second dangerous edit and the route has no before to compare against.
         * Public admits every signed-in person to this coworker, and `canRunAgent` is `canAccessAgent`,
         * so it hands them the right to act as it and spend what it was granted. Without the value on
         * each row, an edit that opened a coworker to the whole deployment is byte-identical to one
         * that corrected its title, and the trail cannot say when it was opened or by whom. Recorded on
         * every row rather than only on the row that changed it, so reading the trail forward tells you
         * what was reachable at any point, which is what an incident asks.
         */
        await record(context, "bot.updated", updated.id, {
          name: parsed.value.name,
          visibility: parsed.value.visibility,
          ...(parsed.value.endpoint ? { endpoint: parsed.value.endpoint } : {}),
          ...(parsed.value.auth ? { keyReplaced: true } : {}),
          // Only when the edit said, since absent leaves it as it was and the route has no before.
          ...(parsed.value.isolated === undefined
            ? {}
            : { isolated: parsed.value.isolated }),
        });
        return updated;
      });
      // M3: upstream's `sharedApps` (#757 shared use, `afterExposureChange`) is out of scope.
      return context.json({ agent: await dtoOf(actor, agent) });
    } catch (error) {
      if (error instanceof IsolationRefusedError) {
        return refuseIsolation(
          context,
          error.reason,
          error.message,
          context.req.param("agentId"),
          parsed.value.name,
        );
      }
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/duplicate", requireUser, async (context) => {
    if (!context.req.param("agentId").trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    // Copying a coworker takes a seat exactly as naming a new one does.
    const blocked = await overPlan(context.var.actor.id);
    if (blocked) return blocked;
    try {
      const agent = await store.duplicate(
        context.var.actor,
        context.req.param("agentId"),
        quota
          ? (transaction) =>
              quota.assertCapacityWithin(
                transaction,
                context.var.actor.id,
                "wakers",
              )
          : undefined,
      );
      // Recorded against the copy, naming the original: a duplicate inherits an endpoint, so the
      // reader needs to know a second Bot now points at it.
      await record(context, "bot.duplicated", agent.id, {
        copiedFrom: context.req.param("agentId"),
        // Kept only when the person duplicating may give it a computer of its own.
        ...(agent.isolated ? { isolated: true } : {}),
      });
      return context.json(
        { agent: await dtoOf(context.var.actor, agent) },
        201,
      );
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/hide", requireUser, async (context) => {
    try {
      await store.setHidden(
        context.var.actor,
        context.req.param("agentId"),
        true,
      );
      await record(context, "bot.hidden", context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/unhide", requireUser, async (context) => {
    try {
      await store.setHidden(
        context.var.actor,
        context.req.param("agentId"),
        false,
      );
      await record(context, "bot.unhidden", context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/pin", requireUser, async (context) => {
    try {
      await store.setPinned(
        context.var.actor,
        context.req.param("agentId"),
        true,
      );
      await record(context, "bot.pinned", context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/unpin", requireUser, async (context) => {
    try {
      await store.setPinned(
        context.var.actor,
        context.req.param("agentId"),
        false,
      );
      await record(context, "bot.unpinned", context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /*
   * Issue this agent its callback credential, and show it once.
   *
   * A POST because it writes and because it replaces: calling it again rotates, which is how a leaked
   * token is retired. The token is in the response and nowhere else, ever again, and it is not written
   * to the audit payload either: a trail that records credentials is a credential store with worse
   * access control.
   */
  routes.post("/:agentId/callback-token", requireUser, async (context) => {
    try {
      const token = await store.issueCallbackToken(
        context.var.actor,
        context.req.param("agentId"),
      );
      // That one was issued, never what it is. A trail that records credentials is a credential
      // store with worse access control.
      await record(
        context,
        "bot.callback_token_issued",
        context.req.param("agentId"),
      );
      return context.json({ token }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /** Take it away. The agent may still hold a conversation; it may not reach anything outside one. */
  routes.delete("/:agentId/callback-token", requireUser, async (context) => {
    try {
      await store.revokeCallbackToken(
        context.var.actor,
        context.req.param("agentId"),
      );
      await record(
        context,
        "bot.callback_token_revoked",
        context.req.param("agentId"),
      );
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/:agentId", signedInAsAdmin, async (context) => {
    if (!context.req.param("agentId").trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      const actor = context.var.actor;
      const agentId = context.req.param("agentId");
      await asOwnerWhereAdmin(actor, agentId, async () => {
        await store.softDelete(actor, agentId);
        await record(context, "bot.deleted", agentId);
      });
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * Which Bots this Bot may hand work to.
   *
   * On the Bot's own screen rather than under the connector catalogue, because it is a fact about
   * this Bot and not about a vendor: the catalogue's entries have a fixed list of tools, and the
   * Bots a deployment has are whatever somebody made.
   *
   * `enabled` is reported separately from the grants, because the two fail differently. A grant with
   * the capability switched off is a row in the database that will never be read, and a screen that
   * offered it without saying so would be a switch wired to nothing.
   */
  routes.get("/:agentId/handoff", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    if (!agentId.trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      // Asked of the store, so a Bot somebody may not see is "not found" here as everywhere else,
      // rather than a list of who it can reach.
      const agent = await store.get(context.var.actor, agentId);
      if (!agent)
        return context.json({ error: "Couldn't find that Bot." }, 404);
      return context.json({
        handoff: {
          enabled: handoff?.enabled ?? false,
          // Granting is an administrator's, the same as it is on every other grant.
          canGrant: context.var.actor.role === "admin",
          reachable: handoff ? await handoff.reachableFrom(agentId) : [],
          // Whether this Bot can hold such a grant at all; the write path refuses one that cannot,
          // and the screen should say so before a person flips switches that can only bounce.
          grantable: handoff?.canHandOn
            ? ((await handoff.canHandOn(agentId)) ?? false)
            : false,
        },
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

function boundedText(
  value: unknown,
  maximumLength: number,
  error: string,
): string | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error };
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength
    ? trimmed
    : { ok: false, error };
}

function agentDto(actor: AgentActor, agent: AgentProfile) {
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title,
    roleDescription: agent.roleDescription,
    avatarSeed: agent.avatarSeed,
    visibility: agent.visibility,
    hidden: agent.hidden,
    pinned: agent.pinned,
    systemOwned: agent.systemOwned,
    // Published so the edit form can show it. Safe to expose: it is an address the person supplied,
    // and any credential for it lives in the vault, never in this row.
    endpoint: agent.endpoint,
    // Which entry of this person's model library the coworker answers on. Null is the deployment's.
    modelRef: agent.modelRef,
    // Which platform pool model it answers on instead, if any. Never both.
    platformModelRef: agent.platformModelRef,
    persona: agent.persona,
    // ROLE1: the handbook, the template it came from, and whether a template may be applied at all.
    // The store always sets all three; a profile without them publishes none.
    bible: agent.bible,
    roleTemplate: agent.roleTemplate,
    acceptsRoleTemplate: agent.acceptsRoleTemplate,
    hasAuth: agent.hasAuth,
    // Whether one exists, never what it is.
    hasCallbackToken: agent.hasCallbackToken,
    // What the owner asked for. Whether it is in effect is `isolationActive`, added by the route.
    isolated: agent.isolated,
    // 召唤员工: where it was summoned from and its preset portrait; null for one made by hand.
    summonedFrom: agent.summonedFrom ?? null,
    presetPortrait: agent.presetPortrait ?? null,
    // The personal starter's, for its Setup page. No other Bot's DTO carries any.
    ...(agent.instructions ? { instructions: agent.instructions } : {}),
    // What runs it, by name, so a page can say that where it would otherwise show an address.
    ...(agent.framework ? { framework: agent.framework } : {}),
    canManage: canManageAgent(actor, agent),
    // Ownership, kept separate from permission. `canManage` is also true for an administrator on
    // another user's coworker, so a roster that split "mine" on it would file other people's work
    // under yours, and only for administrators, who are the least likely to notice.
    mine: agent.ownerUserId === actor.id,
    assignedToMe: agent.assignedToMe ?? false,
  };
}

function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof QuotaExceeded) return context.json(error.body, 402);
  if (error instanceof AgentNotFoundError) {
    return context.json({ error: "Couldn't find that Bot." }, 404);
  }
  if (error instanceof AgentNotManageableError) {
    return context.json({ error: "You can't manage this Bot." }, 403);
  }
  if (error instanceof ProtectedAgentError) {
    return context.json(
      { error: "This Bot is built in and can't be changed." },
      403,
    );
  }
  if (error instanceof ManagedAgentUnavailableError) {
    return context.json({ error: error.message }, 400);
  }
  if (error instanceof ModelNotInLibraryError) {
    return context.json({ error: error.message }, 400);
  }
  if (error instanceof ModelBindingNotApplicableError) {
    return context.json({ error: error.message }, 400);
  }
  if (error instanceof PlatformModelNotAvailableError) {
    return context.json({ error: error.message }, 400);
  }
  if (error instanceof ModelBindingConflictError) {
    return context.json({ error: error.message }, 400);
  }
  if (
    error instanceof RoleTemplateNotApplicableError ||
    error instanceof RoleTemplateSourceError
  ) {
    return context.json({ error: error.message }, 400);
  }
  if (error instanceof AgentAssignedError) {
    return context.json({ error: error.message }, 409);
  }
  if (error instanceof OwnerlessBotPrivateError) {
    return context.json({ error: error.message }, 409);
  }
  // Every route that can raise this records it first; this is the answer for any that is added later.
  if (error instanceof IsolationRefusedError) {
    return context.json(
      {
        error: error.message,
        ...(error.reason === "capability"
          ? { capability: "isolatedComputers" }
          : {}),
      },
      403,
    );
  }
  throw error;
}
