import { createHash } from "node:crypto";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import {
  emptyRoleProfile,
  ROLE_LIMITS,
  type RoleProfile,
  sameRoleProfile,
  validateRoleProfile,
} from "../../../shared/role-profile";
import {
  AgentNotFoundError,
  type AgentProfileStoreWithRoles,
  type ProfileReadExecutor,
} from "../agents/profile-store";
import type {
  AgentActor,
  AgentProfile,
  AgentRoleContent,
} from "../agents/profile-types";
import type { Database } from "../db/client";
import { agentProfiles } from "../db/schema";
import { roleGenerationRequests, roleTemplates } from "../db/schema/roles";
import type { QuotaService } from "../quota/limits";
import type { FlowModelResolver } from "../wakerflows/model";
import {
  ROLE_FORMAT_MESSAGE,
  RoleGenerationRefusedError,
  type RoleGenerator,
  RoleProfileFormatError,
} from "./generator";

/**
 * Role templates (story ROLE1, spec §3.2 option C, §3.3).
 *
 * A template is a person's own: `role_templates` admits only its owner's frame (0082), so every read
 * and write here runs in the caller's frame and another person's template id reads as absent. Each
 * edit takes the version the editor loaded and moves it up by one, or is refused: two tabs cannot
 * silently overwrite each other.
 *
 * A coworker made from a template is a copy with a pointer back (D2): editing the template never
 * changes a coworker. The coworker shows "新版本" and is updated only when its owner applies the
 * template again, after seeing what changes. The package's seed role cards are offered beside the
 * person's own as read-only official templates (D5), derived on each read and never stored.
 */
export type RoleTemplate = {
  id: string;
  name: string;
  profile: RoleProfile;
  version: number;
  updatedAt: Date;
  official: false;
};

export type OfficialRoleTemplate = {
  id: string;
  name: string;
  profile: RoleProfile;
  version: 1;
  official: true;
};

/** Where a coworker's role came from, as its role section shows it. */
export type RoleSourceStatus = {
  acceptsRoleTemplate: boolean;
  source: {
    id: string;
    version: number;
    /** Null when the template is gone or not the asker's to read. */
    name: string | null;
    latestVersion: number | null;
    /** The template has moved on since the coworker took it. */
    hasUpdate: boolean;
    /**
     * The coworker was changed after taking that version. Null when it cannot be told: the template
     * has moved on, and only its current version is kept.
     */
    modified: boolean | null;
  } | null;
};

export class RoleTemplateNotFoundError extends Error {
  constructor() {
    super("角色模板不存在或已被删除。");
    this.name = "RoleTemplateNotFoundError";
  }
}

export class RoleTemplateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleTemplateValidationError";
  }
}

export class RoleTemplateNameTakenError extends Error {
  constructor() {
    super("已有同名的角色模板，请换一个名字。");
    this.name = "RoleTemplateNameTakenError";
  }
}

/** The editor's version is not the stored one: somebody saved in between. */
export class RoleTemplateVersionConflictError extends Error {
  constructor(readonly current: number) {
    super("模板已在别处被修改，请刷新后再保存。");
    this.name = "RoleTemplateVersionConflictError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One smart-generation request, as the editor polls it (§3.5). */
export type RoleGenerationOutcome = {
  requestId: string;
  state: "pending" | "completed" | "failed" | "unknown";
  profile: RoleProfile | null;
  error: string | null;
};

export const ROLE_GENERATION_UNCERTAIN_MESSAGE =
  "无法确认模型是否完成了这次生成，请发起新的生成。";

/** Smart generation is not wired on this deployment. */
export class RoleGenerationUnavailableError extends Error {
  constructor() {
    super("智能生成暂不可用。");
    this.name = "RoleGenerationUnavailableError";
  }
}

/** The request id was used before for a different description or model. */
export class RoleGenerationConflictError extends Error {
  constructor() {
    super("这个请求编号已用于另一次生成，请刷新后重试。");
    this.name = "RoleGenerationConflictError";
  }
}

function templateName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || [...name].length > ROLE_LIMITS.templateName) {
    throw new RoleTemplateValidationError("模板名称需要 1 到 80 个字。");
  }
  return name;
}

function profileOf(raw: unknown): RoleProfile {
  const result = validateRoleProfile(raw);
  if (!result.ok) throw new RoleTemplateValidationError(result.message);
  return result.profile;
}

/** A stored profile, read leniently: a row written before a rule tightened still opens. */
function storedProfile(raw: unknown): RoleProfile {
  const result = validateRoleProfile(raw);
  return result.ok ? result.profile : emptyRoleProfile();
}

function nameTaken(error: unknown): boolean {
  const violation = error as {
    errno?: unknown;
    code?: unknown;
    cause?: { errno?: unknown; code?: unknown };
  } | null;
  return [
    violation?.errno,
    violation?.code,
    violation?.cause?.errno,
    violation?.cause?.code,
  ].some((state) => String(state) === "23505");
}

const shape = (row: typeof roleTemplates.$inferSelect): RoleTemplate => ({
  id: row.id,
  name: row.name,
  profile: storedProfile(row.profile),
  version: row.version,
  updatedAt: row.updatedAt,
  official: false,
});

/**
 * What applying a profile writes on a coworker. A blank title or role description keeps the
 * coworker's own — a coworker always has both, and a template copied from an old persona template
 * has neither — while persona and handbook are replaced whole.
 */
export function roleContentFor(
  profile: RoleProfile,
  current: Pick<AgentProfile, "title" | "roleDescription">,
): AgentRoleContent {
  return {
    title: profile.identity.title || current.title,
    roleDescription:
      profile.identity.roleDescription || current.roleDescription,
    persona: profile.persona,
    bible: profile.bible || null,
  };
}

/** A coworker's current role, as a profile, for the diff and the "changed since" check. */
export function roleProfileOfAgent(agent: AgentProfile): RoleProfile {
  return {
    identity: { title: agent.title, roleDescription: agent.roleDescription },
    persona: agent.persona ?? emptyRoleProfile().persona,
    bible: agent.bible ?? "",
  };
}

/**
 * The package's seed role cards (D5) as read-only templates: identity from the card, and for a Bot
 * that runs here its system prompt as the working principles it is. Persona and handbook otherwise
 * empty. Ids are `official:<agent id>`, never a uuid, so no coworker can record one as its source.
 */
export function officialTemplatesFrom(
  agents: readonly {
    id: string;
    name: string;
    title: string;
    roleDescription: string;
    type: string;
    configuration: Record<string, unknown>;
  }[],
): OfficialRoleTemplate[] {
  const cut = (text: string, limit: number) =>
    [...text.trim()].slice(0, limit).join("");
  return agents.map((agent) => {
    const prompt = agent.configuration.systemPrompt;
    return {
      id: `official:${agent.id}`,
      name: cut(agent.name, ROLE_LIMITS.templateName),
      profile: {
        identity: {
          title: cut(agent.title, ROLE_LIMITS.title).replace(/\s+/g, " "),
          roleDescription: cut(
            agent.roleDescription,
            ROLE_LIMITS.roleDescription,
          ),
        },
        persona: {
          tone: "",
          principles:
            agent.type === "built_in" && typeof prompt === "string"
              ? cut(prompt, ROLE_LIMITS.personaPart)
              : "",
          habits: "",
        },
        bible: "",
      },
      version: 1 as const,
      official: true as const,
    };
  });
}

export type RoleTemplateStore = ReturnType<typeof createRoleTemplateStore>;

export function createRoleTemplateStore(options: {
  database: Database;
  profiles: AgentProfileStoreWithRoles;
  /** The package's seed cards, read per call. Absent offers none. */
  official?: () => readonly OfficialRoleTemplate[];
  /** Smart generation (§3.5): the person's own library only (D7), the call, and the plan's quota. */
  models?: FlowModelResolver;
  generator?: RoleGenerator;
  quota?: Pick<QuotaService, "assertCapacity">;
}) {
  const { database, profiles } = options;

  /**
   * A request as stored, settled first: one still `pending` after its lease ran out belonged to a
   * call that died with its process, and is recorded as `unknown`, never replayed — the provider may
   * have done, and charged for, the work.
   */
  const readRequest = async (requestId: string) => {
    await database
      .update(roleGenerationRequests)
      .set({
        state: "unknown",
        error: ROLE_GENERATION_UNCERTAIN_MESSAGE,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(roleGenerationRequests.requestId, requestId),
          eq(roleGenerationRequests.state, "pending"),
          lt(roleGenerationRequests.leaseExpiresAt, sql`now()`),
        ),
      );
    const [row] = await database
      .select()
      .from(roleGenerationRequests)
      .where(eq(roleGenerationRequests.requestId, requestId))
      .limit(1);
    return row ?? null;
  };

  const outcome = (
    row: typeof roleGenerationRequests.$inferSelect,
  ): RoleGenerationOutcome => {
    const known = ["pending", "completed", "failed", "unknown"] as const;
    const state = (known as readonly string[]).includes(row.state)
      ? (row.state as RoleGenerationOutcome["state"])
      : "unknown";
    return {
      requestId: row.requestId,
      state,
      profile: state === "completed" ? storedProfile(row.profile) : null,
      error: row.error,
    };
  };

  /** The call's result, written only while the request is still this call's to settle. */
  const settle = (
    requestId: string,
    result:
      | { state: "completed"; profile: RoleProfile }
      | { state: "failed" | "unknown"; error: string },
  ) =>
    database
      .update(roleGenerationRequests)
      .set({
        state: result.state,
        profile: result.state === "completed" ? result.profile : null,
        error: result.state === "completed" ? null : result.error,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(roleGenerationRequests.requestId, requestId),
          eq(roleGenerationRequests.state, "pending"),
        ),
      );

  const find = async (
    executor: ProfileReadExecutor,
    id: string,
  ): Promise<RoleTemplate | null> => {
    if (!UUID.test(id)) return null;
    const [row] = await executor
      .select()
      .from(roleTemplates)
      .where(eq(roleTemplates.id, id))
      .limit(1);
    return row ? shape(row) : null;
  };

  return {
    official(): OfficialRoleTemplate[] {
      return [...(options.official?.() ?? [])];
    },

    async list(): Promise<RoleTemplate[]> {
      const rows = await database
        .select()
        .from(roleTemplates)
        .orderBy(asc(roleTemplates.name));
      return rows.map(shape);
    },

    async get(id: string): Promise<RoleTemplate> {
      const template = await find(database, id);
      if (!template) throw new RoleTemplateNotFoundError();
      return template;
    },

    async create(
      actor: AgentActor,
      input: { name: unknown; profile: unknown },
    ): Promise<RoleTemplate> {
      const name = templateName(input.name);
      const profile = profileOf(input.profile);
      try {
        const [row] = await database
          .insert(roleTemplates)
          .values({ ownerUserId: actor.id, name, profile, version: 1 })
          .returning();
        if (!row) throw new RoleTemplateNotFoundError();
        return shape(row);
      } catch (error) {
        if (nameTaken(error)) throw new RoleTemplateNameTakenError();
        throw error;
      }
    },

    /**
     * Save an edit made on `version`. The update names that version, so a save made on a stale copy
     * changes nothing and is refused with the current number; a successful one is `version + 1`.
     */
    async update(
      id: string,
      input: { name?: unknown; profile: unknown; version: unknown },
    ): Promise<RoleTemplate> {
      if (!UUID.test(id)) throw new RoleTemplateNotFoundError();
      if (
        typeof input.version !== "number" ||
        !Number.isInteger(input.version) ||
        input.version < 1
      ) {
        throw new RoleTemplateValidationError("缺少模板版本，请刷新后再保存。");
      }
      const profile = profileOf(input.profile);
      const name =
        input.name === undefined ? undefined : templateName(input.name);
      try {
        const [row] = await database
          .update(roleTemplates)
          .set({
            profile,
            ...(name === undefined ? {} : { name }),
            version: sql`${roleTemplates.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(roleTemplates.id, id),
              eq(roleTemplates.version, input.version),
            ),
          )
          .returning();
        if (row) return shape(row);
      } catch (error) {
        if (nameTaken(error)) throw new RoleTemplateNameTakenError();
        throw error;
      }
      const current = await find(database, id);
      if (!current) throw new RoleTemplateNotFoundError();
      throw new RoleTemplateVersionConflictError(current.version);
    },

    /**
     * Delete a template. The coworkers made from it keep their content; their source is cleared, in
     * the application because no foreign key can cross the two tables' row security (§3.3).
     */
    async remove(actor: AgentActor, id: string): Promise<void> {
      if (!UUID.test(id)) throw new RoleTemplateNotFoundError();
      await database.transaction(async (transaction) => {
        const [removed] = await transaction
          .delete(roleTemplates)
          .where(eq(roleTemplates.id, id))
          .returning({ id: roleTemplates.id });
        if (!removed) throw new RoleTemplateNotFoundError();
        await transaction
          .update(agentProfiles)
          .set({ roleTemplateId: null, roleTemplateVersion: null })
          .where(
            and(
              eq(agentProfiles.roleTemplateId, id),
              eq(agentProfiles.ownerUserId, actor.id),
            ),
          );
      });
    },

    /**
     * Apply a template to a coworker (§3.3): identity, persona and Bible replaced, the template and
     * version recorded. `version` is the one whose diff the person confirmed; if the template has
     * moved on since, nothing is written and they are shown the new one.
     */
    async apply(
      actor: AgentActor,
      templateId: string,
      input: { agentId: unknown; version: unknown },
    ): Promise<AgentProfile> {
      const template = await find(database, templateId);
      if (!template) throw new RoleTemplateNotFoundError();
      if (typeof input.agentId !== "string" || !input.agentId.trim()) {
        throw new RoleTemplateValidationError("请选择要套用模板的员工。");
      }
      if (input.version !== template.version) {
        throw new RoleTemplateVersionConflictError(template.version);
      }
      const agent = await profiles.get(actor, input.agentId);
      // The same answer the agent routes give for a coworker this person cannot see.
      if (!agent) throw new AgentNotFoundError(input.agentId);
      return profiles.applyRole(
        actor,
        agent.id,
        roleContentFor(template.profile, agent),
        { id: template.id, version: template.version },
      );
    },

    /** Where a coworker's role came from and whether its template has moved on (§3.3). */
    async sourceStatus(
      actor: AgentActor,
      agentId: string,
    ): Promise<RoleSourceStatus | null> {
      const agent = await profiles.get(actor, agentId);
      if (!agent) return null;
      const acceptsRoleTemplate = agent.acceptsRoleTemplate ?? false;
      const source = agent.roleTemplate ?? null;
      if (!source) return { acceptsRoleTemplate, source: null };
      const template = await find(database, source.id);
      if (!template) {
        return {
          acceptsRoleTemplate,
          source: {
            ...source,
            name: null,
            latestVersion: null,
            hasUpdate: false,
            modified: null,
          },
        };
      }
      const applied = roleContentFor(template.profile, agent);
      const modified =
        template.version === source.version
          ? !sameRoleProfile(roleProfileOfAgent(agent), {
              identity: {
                title: applied.title,
                roleDescription: applied.roleDescription,
              },
              persona: applied.persona,
              bible: applied.bible ?? "",
            })
          : null;
      return {
        acceptsRoleTemplate,
        source: {
          ...source,
          name: template.name,
          latestVersion: template.version,
          hasUpdate: template.version > source.version,
          modified,
        },
      };
    },
    /** The models smart generation may use: the person's own library, never a platform one (D7). */
    async modelChoices(actor: AgentActor) {
      return options.models ? options.models.choices(actor.id) : [];
    },

    /** A generation request as it stands now, or null for one this person never made. */
    async generation(requestId: string): Promise<RoleGenerationOutcome | null> {
      if (!UUID.test(requestId)) return null;
      const row = await readRequest(requestId);
      return row ? outcome(row) : null;
    },

    /**
     * Smart generation (§3.5), once per request id. The order is the contract: a repeat answers from
     * the stored row and never calls the model again; a new request is refused for a model that is
     * not the person's own, enabled and keyed, before any row is written or any call made; then the
     * quota; then the claim, which a concurrent twin loses on the primary key; then the one call. The
     * profile is returned to the editor and saved nowhere else.
     */
    async generate(
      actor: AgentActor,
      input: { requestId: unknown; modelRef: unknown; description: unknown },
    ): Promise<RoleGenerationOutcome> {
      if (typeof input.requestId !== "string" || !UUID.test(input.requestId)) {
        throw new RoleTemplateValidationError(
          "缺少有效的请求编号，请刷新后重试。",
        );
      }
      const requestId = input.requestId;
      const description =
        typeof input.description === "string" ? input.description.trim() : "";
      if (!description) {
        throw new RoleTemplateValidationError("请先用一句话描述这个角色。");
      }
      if ([...description].length > 500) {
        throw new RoleTemplateValidationError("角色描述不能超过 500 字。");
      }
      if (typeof input.modelRef !== "string" || !input.modelRef) {
        throw new RoleTemplateValidationError("请选择可用的模型。");
      }
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ modelRef: input.modelRef, description }))
        .digest("hex");
      const answer = (row: typeof roleGenerationRequests.$inferSelect) => {
        if (row.fingerprint !== fingerprint) {
          throw new RoleGenerationConflictError();
        }
        return outcome(row);
      };

      const existing = await readRequest(requestId);
      if (existing) return answer(existing);

      const { models, generator } = options;
      if (!models || !generator) throw new RoleGenerationUnavailableError();
      const resolved = await models.resolve(actor.id, input.modelRef);
      await options.quota?.assertCapacity(actor.id, "tasksPerMonth");

      const [claimed] = await database
        .insert(roleGenerationRequests)
        .values({
          ownerUserId: actor.id,
          requestId,
          fingerprint,
          modelRef: resolved.modelRef,
          state: "pending",
          dispatchStartedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();
      if (!claimed) {
        // A twin claimed it first; its row is the answer, whatever state it is in.
        const twin = await readRequest(requestId);
        if (!twin) throw new RoleTemplateNotFoundError();
        return answer(twin);
      }

      try {
        const profile = await generator.generate({
          model: resolved.model,
          description,
        });
        await settle(requestId, { state: "completed", profile });
      } catch (error) {
        if (error instanceof RoleProfileFormatError) {
          await settle(requestId, {
            state: "failed",
            error: ROLE_FORMAT_MESSAGE,
          });
        } else if (error instanceof RoleGenerationRefusedError) {
          await settle(requestId, { state: "failed", error: error.message });
        } else {
          // A timeout, a dropped line, anything unclassified: maybe done and charged, never replayed.
          await settle(requestId, {
            state: "unknown",
            error: ROLE_GENERATION_UNCERTAIN_MESSAGE,
          });
        }
      }
      const settled = await readRequest(requestId);
      return outcome(settled ?? claimed);
    },
  };
}
