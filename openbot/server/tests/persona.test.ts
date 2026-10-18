import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { PROVENANCE_GUIDANCE } from "../../shared/bot-prompt";
import { type Persona, personaIsEmpty } from "../../shared/persona";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import { buildAgents, standingRoleMessage } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  personaTemplates,
  users,
} from "../src/db/schema";
import { createPersonaRoutes } from "../src/personas/routes";
import { createPersonaTemplateStore } from "../src/personas/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 014 acceptance (spec D6): the persona a coworker's owner wrote reaches the model, on the
 * next turn rather than the next restart, and the same words can be handed to the next coworker
 * without being retyped.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenantA = `pa-${suite}`;
const tenantB = `pb-${suite}`;
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const templates = createPersonaTemplateStore(database);

const persona: Persona = {
  tone: "Plain and unhedged; short sentences.",
  principles: "Never invent a figure. Say what was read and where from.",
  habits: "Close every filing answer with the line: ⚠️ 需人工复核.",
};

const model = { provider: "openai" as const, defaultModel: "gpt-5.6-terra" };

test("the persona is a section, and an empty one is no section at all", () => {
  expect(personaIsEmpty(null)).toBeTrue();
  expect(personaIsEmpty({ tone: "  ", principles: "", habits: "" })).toBeTrue();
  expect(personaIsEmpty(persona)).toBeFalse();
});

test("a built-in coworker is told who it is, after its role and before what it holds", async () => {
  const built = await buildAgents(
    [
      {
        id: "risk-analyst",
        name: "Risk Analyst",
        type: "built_in" as const,
        systemPrompt: "Review the control evidence.",
        persona,
      },
    ],
    model,
    "synthetic-key",
  );
  const configuration = (
    built["risk-analyst"] as unknown as {
      configuration: { prompt: string };
    }
  ).configuration;
  const prompt = configuration.prompt;

  expect(prompt).toContain("Plain and unhedged; short sentences.");
  expect(prompt).toContain("⚠️ 需人工复核");
  // Order is the fix, not merely presence: the persona is who does the job, so it rides with the
  // role, and the instruments are what it reaches with.
  expect(prompt.indexOf("Review the control evidence.")).toBeLessThan(
    prompt.indexOf("Plain and unhedged"),
  );
  expect(prompt.indexOf("Plain and unhedged")).toBeLessThan(
    prompt.indexOf(PROVENANCE_GUIDANCE),
  );
});

test("a coworker with no persona is told nothing about one", async () => {
  const built = await buildAgents(
    [
      {
        id: "plain",
        name: "Plain",
        type: "built_in" as const,
        systemPrompt: "Answer questions.",
      },
    ],
    model,
    "synthetic-key",
  );
  const configuration = (
    built.plain as unknown as { configuration: { prompt: string } }
  ).configuration;
  // The failure this prevents is a coworker reading "This is who you are:" followed by nothing,
  // which teaches it that somebody wrote a persona and it was empty.
  expect(configuration.prompt).not.toContain("This is who you are");
});

test("a remote coworker's persona travels in its standing role", () => {
  const message = standingRoleMessage({
    id: "external",
    name: "External Analyst",
    title: "Contracted reviewer",
    roleDescription: "Reviews transaction monitoring.",
    persona,
  });
  // For a remote coworker this one message is the whole of its instruction, so a persona left out
  // here is a persona nobody ever wrote.
  expect(message.content).toContain("Never invent a figure.");
  expect(
    message.content.indexOf("Reviews transaction monitoring."),
  ).toBeLessThan(message.content.indexOf("Never invent a figure."));
});

test("a persona written through the store is what the next read carries", async () => {
  const actor = await newPerson(tenantA);
  const created = await runAsTenant(tenantA, () =>
    profileStore.create(actor, {
      name: `dev-${suite}`,
      title: "Developer",
      roleDescription: "Writes the code.",
      visibility: "private",
    }),
  );
  expect(created.persona).toBeNull();

  const updated = await runAsTenant(tenantA, () =>
    profileStore.update(actor, created.id, {
      name: `dev-${suite}`,
      title: "Developer",
      roleDescription: "Writes the code.",
      visibility: "private",
      persona,
    }),
  );
  expect(updated.persona?.habits).toBe(persona.habits);

  // An edit that never mentions the persona leaves it where it is — the form posts the whole
  // profile, so without this a rename would quietly drop the character.
  const renamed = await runAsTenant(tenantA, () =>
    profileStore.update(actor, created.id, {
      name: `dev-${suite}`,
      title: "Senior developer",
      roleDescription: "Writes the code.",
      visibility: "private",
    }),
  );
  expect(renamed.persona?.principles).toBe(persona.principles);

  // A copy carries it: the duplicate is meant to behave like the original.
  const copy = await runAsTenant(tenantA, () =>
    profileStore.duplicate(actor, created.id),
  );
  expect(copy.persona?.tone).toBe(persona.tone);

  await runAsTenant(tenantA, () =>
    database.delete(agents).where(inArray(agents.id, [created.id, copy.id])),
  );
});

test("a saved persona is handed to the next coworker by name", async () => {
  const saved = await runAsTenant(tenantA, () =>
    templates.save({ name: "Careful reviewer", persona }),
  );
  expect(saved.name).toBe("Careful reviewer");

  const listed = await runAsTenant(tenantA, () => templates.list());
  expect(listed.map((entry) => entry.name)).toEqual(["Careful reviewer"]);
  expect(listed[0]?.persona.habits).toBe(persona.habits);

  // Saving the same name again updates it rather than accumulating a second persona under it.
  const revised = await runAsTenant(tenantA, () =>
    templates.save({
      name: "Careful reviewer",
      persona: { ...persona, tone: "Plain, and unhedged." },
    }),
  );
  expect(revised.id).toBe(saved.id);
  const after = await runAsTenant(tenantA, () => templates.list());
  expect(after.length).toBe(1);
  expect(after[0]?.persona.tone).toBe("Plain, and unhedged.");

  const removed = await runAsTenant(tenantA, () => templates.remove(saved.id));
  expect(removed).toBeTrue();
});

test("one tenant's personas are not another tenant's to read or delete", async () => {
  await newPerson(tenantB);
  const saved = await runAsTenant(tenantA, () =>
    templates.save({ name: `mine-${suite}`, persona }),
  );

  const seenByB = await runAsTenant(tenantB, () => templates.list());
  expect(seenByB.map((entry) => entry.name)).not.toContain(`mine-${suite}`);

  const deletedByB = await runAsTenant(tenantB, () =>
    templates.remove(saved.id),
  );
  expect(deletedByB).toBeFalse();

  const stillThere = await runAsTenant(tenantA, () => templates.list());
  expect(stillThere.map((entry) => entry.name)).toContain(`mine-${suite}`);
});

test("the persona routes refuse an empty persona and answer with the saved one", async () => {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: tenantA, role: "user" });
    await next();
  };
  const routes = createPersonaRoutes(templates, requireUser);

  const empty = await runAsTenant(tenantA, () =>
    routes.request(
      new Request("http://openbot.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Empty",
          persona: { tone: "   ", principles: "", habits: "" },
        }),
      }),
    ),
  );
  expect(empty.status).toBe(400);

  const created = await runAsTenant(tenantA, () =>
    routes.request(
      new Request("http://openbot.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Via route", persona }),
      }),
    ),
  );
  expect(created.status).toBe(201);
  const body = (await created.json()) as { template: { name: string } };
  expect(body.template.name).toBe("Via route");

  const listed = await runAsTenant(tenantA, () =>
    routes.request(new Request("http://openbot.test/")),
  );
  const names = (
    (await listed.json()) as {
      templates: { name: string }[];
    }
  ).templates.map((entry) => entry.name);
  expect(names).toContain("Via route");
});

afterAll(async () => {
  for (const tenant of [tenantA, tenantB]) {
    await runAsTenant(tenant, async () => {
      await database.delete(agentProfiles);
      await database.delete(agents);
      await database.delete(personaTemplates);
      await database.delete(users);
    });
  }
});

async function newPerson(tenant: string): Promise<AgentActor> {
  return runAsTenant(tenant, async () => {
    await database
      .insert(users)
      .values({ id: tenant, email: `${tenant}@example.test`, name: tenant })
      .onConflictDoNothing();
    return { id: tenant, role: "user" as const };
  });
}
