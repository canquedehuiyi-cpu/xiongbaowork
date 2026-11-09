import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agents, skills, users } from "../src/db/schema";
import {
  PICKED_SKILL_PROP,
  pickedSkillGuidance,
} from "../src/plugins/picked-skill";
import { createPluginStore } from "../src/plugins/store";
import { grantedSkills } from "../src/plugins/tools";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A picked skill stays inside the tenant boundary that already decides which skills a run holds.
 *
 * The server only ever picks among `grantedSkills` for the Bot, which `listForAgent` resolves in the
 * asking person's frame under row security. So on a Team Bot, a teammate who types the owner's
 * private skill's command, or a host that states it in `forwardedProps`, is told nothing of it: the
 * teammate's frame holds only what the deployment ships, and the owner's own frame holds their skill.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null } as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

const suite = `pst-${randomUUID().slice(0, 8)}`;
const owner: AgentActor = { id: `${suite}-owner`, role: "user" };
const teammate: AgentActor = { id: `${suite}-teammate`, role: "user" };
const slug = `${suite}-private`;
const MARKER = `PRIVATE-${suite}`;
let agentId = "";

const as = <T>(actor: AgentActor, fn: () => T): T => runAsTenant(actor.id, fn);

beforeAll(async () => {
  await asPlatform(async () => {
    await database.insert(users).values(
      [owner, teammate].map((person) => ({
        id: person.id,
        email: `${person.id}@example.test`,
      })),
    );
  });
  await as(owner, async () => {
    await database.insert(skills).values({
      id: randomUUID(),
      slug,
      ownerUserId: owner.id,
      title: "Owner's private skill",
      summary: "Only the owner's.",
      instructions: `Write ${MARKER} on its own line.`,
      origin: "yours",
    });
  });
  const profile = await as(owner, () =>
    profiles.create(owner, {
      name: "Ledger Desk",
      title: "Finance",
      roleDescription: "Answers ledger questions.",
      visibility: "public",
    }),
  );
  agentId = profile.id;
  await as(owner, () => plugins.grant("skill", slug, agentId, owner.id));
});

afterAll(async () => {
  await asPlatform(async () => {
    if (agentId) await database.delete(agents).where(eq(agents.id, agentId));
    await database.delete(skills).where(eq(skills.slug, slug));
    await database
      .delete(users)
      .where(inArray(users.id, [owner.id, teammate.id]));
  });
  await database.$client.close();
});

const picked = (forwardedProps?: Record<string, unknown>) => ({
  messages: [
    {
      id: "q",
      role: "user" as const,
      content: forwardedProps ? "about the ledger" : `/${slug} the ledger`,
    },
  ],
  forwardedProps,
});

describe("a picked skill on a Team Bot", () => {
  test("the owner's own frame holds their skill, so picking it reaches the run", async () => {
    const held = await as(owner, () =>
      grantedSkills({ store: plugins, botId: agentId }),
    );
    expect(held.map((skill) => skill.slug)).toEqual([slug]);
    expect(pickedSkillGuidance(picked(), held)).toContain(MARKER);
  });

  test("a teammate typing the owner's private command is told nothing of it", async () => {
    const held = await as(teammate, () =>
      grantedSkills({ store: plugins, botId: agentId }),
    );
    expect(held.map((skill) => skill.slug)).not.toContain(slug);
    expect(pickedSkillGuidance(picked(), held)).toBeUndefined();
  });

  test("nor is a host that states it in forwardedProps for the teammate's turn", async () => {
    const held = await as(teammate, () =>
      grantedSkills({ store: plugins, botId: agentId }),
    );
    expect(
      pickedSkillGuidance(picked({ [PICKED_SKILL_PROP]: slug }), held),
    ).toBeUndefined();
  });
});
