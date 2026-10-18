import { asc, eq } from "drizzle-orm";
import type { Persona } from "../../../shared/persona";
import type { Database } from "../db/client";
import { personaTemplates } from "../db/schema";

/**
 * The tenant's saved personas (ticket 014).
 *
 * A template is a persona with a name on it and nothing else: it grants no capability, holds no
 * credential, and cannot reach a coworker by itself. The copy is what makes it worth keeping — a
 * reviewer persona written once is handed to the next reviewer instead of retyped from memory, which
 * is how the sixth one ends up with a shorter version of the rule everybody meant.
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

export function createPersonaTemplateStore(
  database: Database,
): PersonaTemplateStore {
  return {
    async list() {
      const rows = await database
        .select()
        .from(personaTemplates)
        .orderBy(asc(personaTemplates.name));
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        persona: row.persona as Persona,
        updatedAt: row.updatedAt,
      }));
    },

    async save(input) {
      const name = input.name.trim().slice(0, 80);
      if (name.length === 0) throw new PersonaNameError();
      // Two tenants may name one persona the same thing, which is why the unique index is per
      // tenant; inside one tenant, saving the same name again is the update this endpoint means.
      const [row] = await database
        .insert(personaTemplates)
        .values({ name, persona: input.persona })
        .onConflictDoUpdate({
          target: [personaTemplates.tenantId, personaTemplates.name],
          set: { persona: input.persona, updatedAt: new Date() },
        })
        .returning();
      return {
        id: row.id,
        name: row.name,
        persona: row.persona as Persona,
        updatedAt: row.updatedAt,
      };
    },

    /*
     * Deleting a template takes nothing away from a coworker: the persona a coworker runs on is its
     * own copy, written when the person picked the template. That is the reason a template can be
     * removed without a reference check, and the reason editing one does not silently rewrite the
     * six reviewers it was handed to.
     */
    async remove(id) {
      const [removed] = await database
        .delete(personaTemplates)
        .where(eq(personaTemplates.id, id))
        .returning({ id: personaTemplates.id });
      return Boolean(removed);
    },
  };
}
