import type { Persona } from "../../../shared/persona";
import type { PortraitPreset } from "../portraits/store";

export type AgentVisibility = "public" | "private";
export type { Persona };

export type AgentActor = {
  id: string;
  role: "admin" | "user";
};

export type AgentProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  visibility: AgentVisibility;
  ownerUserId: string | null;
  systemOwned: boolean;
  hidden: boolean;
  pinned: boolean;
  /** An administrator assigned this Team Bot to this person; it stays in their sidebar. */
  assignedToMe?: boolean;
  deletedAt: Date | null;
  /** Where this coworker runs. Null for the Bot in the box. */
  endpoint: string | null;
  /** Whether a key is set for it. Never the key. */
  hasAuth: boolean;
  /**
   * Which entry of this tenant's model library this coworker runs on.
   *
   * Null means the deployment's model. Only a coworker that runs here can be bound — a remote Bot
   * answers on its own server, and a model chosen there is not this deployment's to pick.
   */
  modelRef: string | null;
  /**
   * Which platform pool model this coworker runs on instead (stories H1, K1): the experience models
   * the platform keys itself. Never set together with `modelRef`; null means it is not on the pool.
   */
  platformModelRef: string | null;
  /**
   * Who this coworker is, as its owner wrote it.
   *
   * Null means nothing was ever written, which is not the same as three empty boxes: only the first
   * sends no persona section at all.
   */
  persona: Persona | null;
  /**
   * The coworker's 工作手册 (story ROLE1, the "Bible"), sent in full after the persona. Null means none.
   *
   * Optional on the type only so profiles written by hand in tests before it existed still check;
   * the store always sets it, and this and the two fields below.
   */
  bible?: string | null;
  /**
   * The role template the identity, persona and Bible were last taken from, at that template's
   * version. Null means none. Kept after the coworker is edited: a screen compares contents to say so.
   */
  roleTemplate?: { id: string; version: number } | null;
  /**
   * Whether a role template may be applied to this coworker (ROLE1, D4 as revised 2026-11-04). False
   * only for the 分身, which runs on a prompt that is deliberately not its role description and speaks
   * as the person. Any other coworker, `built_in` included, takes one; for a `built_in` one the
   * template's role description is copied over `configuration.systemPrompt`, as an edit by hand is.
   */
  acceptsRoleTemplate?: boolean;
  /**
   * Whether this agent holds a credential for calling tools back.
   *
   * A boolean, never the token: the token exists in a readable form once, in the response that issued
   * it. A surface only needs to know whether to offer "generate" or "rotate".
   */
  hasCallbackToken: boolean;
  /**
   * The agent this coworker was summoned from, or null for one made by hand. Optional on the type
   * only so profiles written by hand in tests before it existed still check; the store always sets
   * it and `presetPortrait`, and absent reads as null.
   */
  summonedFrom?: string | null;
  /** The preset portrait it uses, or null for none. Optional for the same reason. */
  presetPortrait?: PortraitPreset | null;
  /**
   * Whether its owner asked for it to have a computer of its own rather than share theirs.
   *
   * What was asked for, not what happens: an administrator can withdraw "Isolated Bots" from the
   * owner, and then the Bot runs on the shared computer while this stays true, so that giving the
   * switch back restores it. `agents/isolation.ts` decides whether it is in effect now.
   */
  isolated: boolean;
  /**
   * What the personal starter is told, kept apart from `roleDescription`, which says what it does.
   *
   * The starter is the one Bot a person may edit whose instructions are not its description: the
   * package writes a `system_prompt` for the model and a `role_description` for the person, and a
   * conversation's header shows the second. Every other Bot answers null or leaves it out: a Bot a
   * person made runs on its role description, and a package's own Bot keeps its prompt to itself.
   */
  instructions?: string | null;
  /**
   * What runs it, by the name a person reads ("LangChain", "OpenBot"), or absent when
   * OpenBot doesn't know, such as an agent connected by address with no framework named. Read from
   * what runs it, never its subtitle (`frameworkOf`).
   */
  framework?: string;
};

export type CreateAgentInput = Pick<
  AgentProfile,
  "name" | "title" | "roleDescription" | "visibility"
> & {
  /**
   * The AG-UI endpoint this Bot runs on, or undefined for the one in the box.
   *
   * This field is the AG-UI endpoint for a customer-provided agent. Without it the Bot runs on the
   * built-in endpoint.
   */
  endpoint?: string;
  /**
   * A key this agent sits behind, if any.
   *
   * Write-only. It goes to the vault and is never read back to a person: the edit form shows that a
   * key is set, not what it is. Absent on an update means "leave whatever is there alone", which is
   * why it is optional rather than defaulting to empty; a blank field must not drop a key.
   */
  auth?: { header: string; value: string };
  /**
   * Whether this Bot gets a computer of its own.
   *
   * Optional for the reason `auth` is: absent on an update leaves it as it is, so an edit to a
   * Bot's name never moves it between computers, and absent on a create means no. True needs the
   * "Isolated Bots" switch for whoever sends it; false is always allowed.
   */
  isolated?: boolean;
  /**
   * New instructions for the personal starter. Absent leaves them as they are, and any other Bot
   * ignores it: its instructions are its role description.
   */
  instructions?: string;
  /**
   * The framework a person named for an agent they run themselves, by its id in
   * `shared/harnesses.json`. Read at creation only, and kept in its configuration so the Bot is told
   * what runs it whatever its subtitle says (`frameworkOf`).
   */
  harness?: string;
  /**
   * Which model in the tenant's own library this coworker runs on.
   *
   * Absent means leave the binding alone, `null` means clear it, an id means bind it — the same
   * three-way the key beside it uses, because the edit form is one form and a save that dropped an
   * unrelated field would otherwise silently rewrite it. Validated against the library rather than
   * trusted: the foreign key alone would accept another tenant's model id, since a foreign key is
   * not stopped by row-level security.
   */
  modelRef?: string | null;
  /**
   * Which platform pool model this coworker runs on (stories H1, K1), with the same three-way as
   * `modelRef`. Binding one clears the other, and naming both is refused. Validated against the
   * pool's enabled rows and the record tenant's plan, never trusted from the form.
   */
  platformModelRef?: string | null;
  /**
   * The coworker's persona. Absent on an update leaves it where it is; an object writes it, and the
   * server decides which parts are worth sending to a model at all.
   */
  persona?: Persona;
  /**
   * The coworker's 工作手册 (ROLE1). Absent on an update leaves it where it is; null clears it; text
   * (at most 8000 characters) replaces it. Never written into a `built_in` coworker's systemPrompt.
   */
  bible?: string | null;
  /**
   * The seed the coworker's abstract avatar is drawn from.
   *
   * Absent on a create means the new id, which is what every coworker got before the seed could be
   * chosen; absent on an update leaves the stored one where it is. Never a picture, only the string
   * boring-avatars turns into one, so the parser keeps it to a short run of safe characters.
   */
  avatarSeed?: string;
};

/** The role content a template hands a coworker (ROLE1): identity, persona and Bible, nothing else. */
export type AgentRoleContent = {
  title: string;
  roleDescription: string;
  persona: Persona;
  bible: string | null;
};

/**
 * Where a coworker stands for the person asking, on the list that offers to summon it (`summon.ts`).
 * `preset`: a shared package coworker; `avatar`: their own 分身; null: any other, already theirs.
 */
export type SummonState = {
  summonKind: "preset" | "avatar" | null;
  summoned: boolean;
};
