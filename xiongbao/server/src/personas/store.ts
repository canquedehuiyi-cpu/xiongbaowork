import { eq, sql } from "drizzle-orm";
import type { Persona } from "../../../shared/persona";
import { emptyRoleProfile } from "../../../shared/role-profile";
import type { Database } from "../db/client";
import { personaTemplates } from "../db/schema";
import { roleTemplates } from "../db/schema/roles";
import { currentTenant } from "../tenant/context";

/**
 * The tenant's saved personas (ticket 014), now a view of the role templates (story ROLE1, D6).
 *
 * A persona template became the persona part of a role template: migration 0133 copied every old
 * row into `role_templates`, and this keeps `/api/personas` answering as it did until the old screen
 * is replaced. Saving writes the persona of the role template of that name (making one with an empty
 * identity and handbook if there is none, and moving its version on if there is); the list reads
 * both tables, the role template winning a shared name, so a persona saved in the old table after
 * the copy and before this layer is not lost. `persona_templates` itself is left for a later clean-up.
 *
 * A template grants nothing and reaches no coworker by itself: applying one is a copy, which is why
 * deleting one needs no reference check.
 */
export type PersonaTemplate = {
  id: string;
  name: string;
  persona: Persona;
  updatedAt: Date;
};

export type PersonaTemplateStore = {
  list: () => Promise<PersonaTemplate[]>;
  /** Upsert by name inside the caller's tenant: saving "Careful Reviewer" again updates it. */
  save: (input: { name: string; persona: Persona }) => Promise<PersonaTemplate>;
  remove: (id: string) => Promise<boolean>;
};

export class PersonaNameError extends Error {
  constructor() {
    super("Give the persona a name between 1 and 80 characters.");
    this.name = "PersonaNameError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function personaOf(profile: unknown): Persona {
  const persona = (profile as { persona?: Partial<Persona> } | null)?.persona;
  return {
    tone: typeof persona?.tone === "string" ? persona.tone : "",
    principles:
      typeof persona?.principles === "string" ? persona.principles : "",
    habits: typeof persona?.habits === "string" ? persona.habits : "",
  };
}

export function createPersonaTemplateStore(
  database: Database,
): PersonaTemplateStore {
  return {
    async list() {
      const [roles, legacy] = await Promise.all([
        database.select().from(roleTemplates),
        database.select().from(personaTemplates),
      ]);
      const byName = new Map<string, PersonaTemplate>();
      for (const row of legacy) {
        byName.set(row.name, {
          id: row.id,
          name: row.name,
          persona: row.persona as Persona,
          updatedAt: row.updatedAt,
        });
      }
      for (const row of roles) {
        byName.set(row.name, {
          id: row.id,
          name: row.name,
          persona: personaOf(row.profile),
          updatedAt: row.updatedAt,
        });
      }
      return [...byName.values()].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    },

    async save(input) {
      const name = input.name.trim().slice(0, 80);
      if (name.length === 0) throw new PersonaNameError();
      const persona: Persona = {
        tone: input.persona.tone,
        principles: input.persona.principles,
        habits: input.persona.habits,
      };
      // The person's own role template of that name gets this persona; its identity and handbook stay.
      const [row] = await database
        .insert(roleTemplates)
        .values({
          ownerUserId: currentTenant(),
          name,
          profile: { ...emptyRoleProfile(), persona },
          version: 1,
        })
        .onConflictDoUpdate({
          target: [
            roleTemplates.tenantId,
            roleTemplates.ownerUserId,
            roleTemplates.name,
          ],
          set: {
            profile: sql`jsonb_set(${roleTemplates.profile}, '{persona}', ${JSON.stringify(persona)}::text::jsonb)`,
            version: sql`${roleTemplates.version} + 1`,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new PersonaNameError();
      return {
        id: row.id,
        name: row.name,
        persona: personaOf(row.profile),
        updatedAt: row.updatedAt,
      };
    },

    /*
     * Deleting a template takes nothing away from a coworker: the persona a coworker runs on is its
     * own copy. An id from either table is accepted, since the list shows both.
     */
    async remove(id) {
      if (!UUID.test(id)) return false;
      const [removed] = await database
        .delete(roleTemplates)
        .where(eq(roleTemplates.id, id))
        .returning({ id: roleTemplates.id });
      if (removed) return true;
      const [legacy] = await database
        .delete(personaTemplates)
        .where(eq(personaTemplates.id, id))
        .returning({ id: personaTemplates.id });
      return Boolean(legacy);
    },
  };
}
