import type { Persona } from "../../../shared/persona";

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
   * Who this coworker is, as its owner wrote it.
   *
   * Null means nothing was ever written, which is not the same as three empty boxes: only the first
   * sends no persona section at all.
   */
  persona: Persona | null;
  /**
   * Whether this agent holds a credential for calling tools back.
   *
   * A boolean, never the token: the token exists in a readable form once, in the response that issued
   * it. A surface only needs to know whether to offer "generate" or "rotate".
   */
  hasCallbackToken: boolean;
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
   * The coworker's persona. Absent on an update leaves it where it is; an object writes it, and the
   * server decides which parts are worth sending to a model at all.
   */
  persona?: Persona;
};
