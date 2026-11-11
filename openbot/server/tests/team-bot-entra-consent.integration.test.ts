import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, mcpServers, users } from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import { PluginRefusedError } from "../src/plugins/store";
import {
  createTeamBots,
  TEAM_BOT_CONSENT_MARKER,
} from "../src/team-bots/team-bots";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * A Team Bot and a server reached as the signed-in person (`entra_scope`, X6, review I-1).
 *
 * Such a server has no connection row for anybody, so the Team Bot rule that reads connections
 * took it for "nobody's own account" and sent a teammate's call out on the teammate's own Entra
 * identity with no card. It is the teammate's own account at that system, so it is asked for like
 * one: the consent card first, and the call only after allow once, always allow, or allow for every
 * Team Bot. Nor is it ever reached as the Bot's owner, who never connected it.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const prefix = `tb-entra-${randomUUID().slice(0, 8)}`;
const HR = `${prefix}-hr`;
const PLAIN = `${prefix}-plain`;
const createdUsers: string[] = [];
const createdAgents: string[] = [];
/** Which servers each person has their own account on, as the plugin store records it. */
const connected = new Map<string, Set<string>>();
const teamBots = createTeamBots({
  database,
  connectedServers: async (userId) => connected.get(userId) ?? new Set(),
});
let releaseRoleWriter: (() => Promise<void>) | undefined;

const as = <T>(actor: AgentActor, work: () => T): T =>
  runAsTenant(actor.id, work);

async function person(): Promise<AgentActor> {
  const id = `${prefix}-user-${randomUUID()}`;
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "Team Bot Entra" }),
  );
  createdUsers.push(id);
  await asPlatform(() => setRole(database, id, "user"));
  return { id, role: "user" };
}

async function teamBot(owner: AgentActor) {
  const profile = await as(owner, () =>
    profiles.create(owner, {
      name: "HR Helper",
      title: "HR",
      roleDescription: "Answers HR questions.",
      visibility: "private",
    }),
  );
  createdAgents.push(profile.id);
  await as(owner, () =>
    teamBots.publish(owner, profile.id, {
      audience: "team",
      emails: [],
      groups: [],
    }),
  );
  return profile.id;
}

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  // The servers an administrator added by URL are the team's (G01-E P10): one marked, one not.
  await asPlatform(() =>
    database.insert(mcpServers).values([
      {
        id: HR,
        tenantId: TEAM_TENANT,
        title: "HR",
        vendor: "hr.example.com",
        url: "https://hr.example.com/mcp",
        provenance: "custom",
        entraScope: "api://hr-api/.default",
      },
      {
        id: PLAIN,
        tenantId: TEAM_TENANT,
        title: "Plain",
        vendor: "plain.example.com",
        url: "https://plain.example.com/mcp",
        provenance: "custom",
      },
    ]),
  );
});

afterAll(async () => {
  await asPlatform(async () => {
    if (createdAgents.length) {
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, createdAgents));
      await database.delete(agents).where(inArray(agents.id, createdAgents));
    }
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [HR, PLAIN]));
    for (const id of createdUsers)
      await database.delete(users).where(eq(users.id, id));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

describe("a Team Bot reaching a server marked as reached as the signed-in person", () => {
  test("a teammate is asked first, and their own Entra identity is used only once they allow it", async () => {
    const owner = await person();
    const teammate = await person();
    const bot = await teamBot(owner);
    const ask = (ref: string) =>
      as(teammate, () => teamBots.credentialActorFor(teammate.id, bot)(ref));

    // No consent: the card, and nothing goes out as anybody.
    const refusal = await ask(`${HR}/salary`).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PluginRefusedError);
    expect((refusal as Error).message).toStartWith(TEAM_BOT_CONSENT_MARKER);
    expect((refusal as Error).message).toContain(HR);

    // Allow once is one call: looked at when the Bot picks whose account, spent at the send, where
    // the plugin store asks against the row it sends the token for (re-review N-1).
    await as(teammate, () => teamBots.consent(teammate, bot, HR, "allow_once"));
    expect(await ask(`${HR}/salary`)).toBe(teammate.id);
    await as(teammate, () => teamBots.ownSignInConsent(teammate.id, bot, HR));
    await expect(ask(`${HR}/salary`)).rejects.toThrow(PluginRefusedError);
    await expect(
      as(teammate, () => teamBots.ownSignInConsent(teammate.id, bot, HR)),
    ).rejects.toThrow(TEAM_BOT_CONSENT_MARKER);

    // Always allow, until skipped.
    await as(teammate, () =>
      teamBots.consent(teammate, bot, HR, "allow_always"),
    );
    expect(await ask(`${HR}/salary`)).toBe(teammate.id);
    await as(teammate, () => teamBots.consent(teammate, bot, HR, "skip"));
    await expect(ask(`${HR}/salary`)).rejects.toThrow(PluginRefusedError);
  });

  test("allow for every Team Bot covers it too", async () => {
    const owner = await person();
    const teammate = await person();
    const bot = await teamBot(owner);
    const ask = () =>
      as(teammate, () =>
        teamBots.credentialActorFor(teammate.id, bot)(`${HR}/salary`),
      );
    await expect(ask()).rejects.toThrow(PluginRefusedError);
    await as(teammate, () =>
      teamBots.consent(teammate, bot, HR, "allow_all_team_bots"),
    );
    expect(await ask()).toBe(teammate.id);
    await as(teammate, () => teamBots.clearConsents(teammate));
    await expect(ask()).rejects.toThrow(PluginRefusedError);
  });

  test("it is never reached as the Bot's owner, even where the owner's connections name it", async () => {
    const owner = await person();
    const teammate = await person();
    const bot = await teamBot(owner);
    connected.set(owner.id, new Set([HR, PLAIN]));
    // The unmarked server goes on as before: the owner's connected account.
    expect(
      await as(teammate, () =>
        teamBots.credentialActorFor(teammate.id, bot)(`${PLAIN}/read`),
      ),
    ).toBe(owner.id);
    // The marked one asks the teammate instead of reaching as the owner.
    await expect(
      as(teammate, () =>
        teamBots.credentialActorFor(teammate.id, bot)(`${HR}/salary`),
      ),
    ).rejects.toThrow(TEAM_BOT_CONSENT_MARKER);
  });

  test("the owner on their own Team Bot, and a server nobody connects, are unchanged", async () => {
    const owner = await person();
    const teammate = await person();
    const bot = await teamBot(owner);
    expect(
      await as(owner, () =>
        teamBots.credentialActorFor(owner.id, bot)(`${HR}/salary`),
      ),
    ).toBe(owner.id);
    expect(
      await as(teammate, () =>
        teamBots.credentialActorFor(teammate.id, bot)(`${PLAIN}/read`),
      ),
    ).toBe(teammate.id);
  });

  test("a check-in reads it as the teammate's own only with a standing consent", async () => {
    const owner = await person();
    const teammate = await person();
    const bot = await teamBot(owner);
    connected.set(owner.id, new Set([HR]));
    const lands = await as(teammate, () =>
      teamBots.unaskedOwnAccount(teammate.id, bot),
    );
    if (!lands) throw new Error("a Team Bot someone else published answers");
    expect(await as(teammate, () => lands(`${HR}/salary`))).toBe(false);
    await as(teammate, () =>
      teamBots.consent(teammate, bot, HR, "allow_always"),
    );
    expect(await as(teammate, () => lands(`${HR}/salary`))).toBe(true);
  });

  test("a server marked after the Bot picked whose account is still asked about at the send (re-review N-1)", async () => {
    const owner = await person();
    const teammate = await person();
    const bot = await teamBot(owner);
    const late = `${prefix}-late`;
    await asPlatform(() =>
      database.insert(mcpServers).values({
        id: late,
        tenantId: TEAM_TENANT,
        title: "Late",
        vendor: "late.example.com",
        url: "https://late.example.com/mcp",
        provenance: "custom",
      }),
    );
    try {
      // Unmarked, and nobody has an account on it: the rule answers the teammate, with no card.
      expect(
        await as(teammate, () =>
          teamBots.credentialActorFor(teammate.id, bot)(`${late}/read`),
        ),
      ).toBe(teammate.id);
      // An admin marks it before the call is sent.
      await asPlatform(() =>
        database
          .update(mcpServers)
          .set({ entraScope: "api://late/.default" })
          .where(eq(mcpServers.id, late)),
      );
      // The send asks again, on the row it sends for: the card, not the teammate's identity.
      await expect(
        as(teammate, () => teamBots.ownSignInConsent(teammate.id, bot, late)),
      ).rejects.toThrow(TEAM_BOT_CONSENT_MARKER);
      // The owner on their own Bot is not asked.
      await as(owner, () => teamBots.ownSignInConsent(owner.id, bot, late));
    } finally {
      await asPlatform(() =>
        database.delete(mcpServers).where(eq(mcpServers.id, late)),
      );
    }
  });
});
