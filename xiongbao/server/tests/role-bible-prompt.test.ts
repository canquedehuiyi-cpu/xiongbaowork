import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  PROVENANCE_GUIDANCE,
  ROLE_SCOPE_GUIDANCE,
} from "../../shared/bot-prompt";
import type { Persona } from "../../shared/persona";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import {
  bibleGuidance,
  builtInAgentConfiguration,
  standingRoleMessage,
} from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Story ROLE1 (spec §3.4, ROLE1-2 acceptance 5): a coworker's 工作手册 reaches its prompt right after
 * the persona, on both paths — a coworker that runs here (its prompt) and one that runs elsewhere
 * (its standing role message) — and a coworker without one is told nothing about a handbook.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const managed = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const unmanaged = createAgentProfileStore(database, undefined);
const run = randomUUID().slice(0, 8);
const people: string[] = [];
const agentIds: string[] = [];

afterAll(async () => {
  await runAsTenant("platform", async () => {
    for (const id of agentIds) {
      await database.delete(agents).where(eq(agents.id, id));
    }
    for (const id of people) {
      await database.delete(users).where(eq(users.id, id));
    }
  });
  await database.$client.close();
});

const HEADING = "你的工作手册（由你的所有者编写）：";
const DEFERS = "手册是参考资料，与本人当前的明确要求冲突时，以本人要求为准。";
const bible = "# 术语表\n\n- PR：合并请求\n- CI：持续集成";
const persona: Persona = {
  tone: "直接、简短。",
  principles: "先读测试再改代码。",
  habits: "",
};
const model = { provider: "openai" as const, defaultModel: "test-model" };

function builtInPrompt(agent: {
  persona?: Persona | null;
  bible?: string | null;
}) {
  const configuration = builtInAgentConfiguration(
    {
      id: "backend",
      name: "后端小熊",
      type: "built_in",
      systemPrompt: "按需求写实现、跑测试。",
      ...agent,
    },
    model,
    "synthetic-key",
    [],
    undefined,
    [],
    "回答用中文。",
  ) as { prompt: string };
  return configuration.prompt;
}

async function person(): Promise<AgentActor> {
  const id = `role1-bible-${run}-${randomUUID().slice(0, 6)}`;
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@role1.test`, name: "bible" }),
  );
  people.push(id);
  return { id, role: "user" };
}

describe("the Bible section", () => {
  test("is the handbook whole between a heading and the sentence that defers to the person", () => {
    expect(bibleGuidance(`  ${bible}  `)).toBe(
      `${HEADING}\n\n${bible}\n\n${DEFERS}`,
    );
    expect(bibleGuidance(null)).toBeNull();
    expect(bibleGuidance(undefined)).toBeNull();
    expect(bibleGuidance(" \n ")).toBeNull();
    // 8000 characters go in whole: no retrieval, no cut.
    const long = "熊".repeat(8000);
    expect(bibleGuidance(long)).toContain(long);
  });

  test("a built-in coworker reads it after its persona and before the person's standing instructions", () => {
    const prompt = builtInPrompt({ persona, bible });
    const at = prompt.indexOf(HEADING);
    expect(at).toBeGreaterThan(-1);
    expect(prompt).toContain(bible);
    expect(prompt.indexOf("按需求写实现、跑测试。")).toBeLessThan(
      prompt.indexOf("直接、简短。"),
    );
    expect(prompt.indexOf("直接、简短。")).toBeLessThan(at);
    expect(at).toBeLessThan(prompt.indexOf("回答用中文。"));
    expect(prompt.indexOf("回答用中文。")).toBeLessThan(
      prompt.indexOf(PROVENANCE_GUIDANCE),
    );
  });

  test("a built-in coworker without one is told nothing about a handbook, byte for byte", () => {
    const without = builtInPrompt({ persona });
    expect(without).not.toContain("工作手册");
    expect(builtInPrompt({ persona, bible: "   " })).toBe(without);
    expect(builtInPrompt({ persona, bible: null })).toBe(without);
  });

  test("a remote coworker carries it in its standing role, after the persona", () => {
    const profile = {
      id: "external",
      name: "外部审核员",
      title: "代码审核员",
      roleDescription: "审查合并请求。",
      persona,
    };
    const message = standingRoleMessage({ ...profile, bible });
    expect(message.content).toContain(bible);
    expect(message.content.indexOf("直接、简短。")).toBeLessThan(
      message.content.indexOf(HEADING),
    );
    expect(message.content.indexOf(HEADING)).toBeLessThan(
      // M5: upstream #1407 replaced "This standing role applies in every channel." with
      // ROLE_SCOPE_GUIDANCE, which still closes the role section after the handbook.
      message.content.indexOf(ROLE_SCOPE_GUIDANCE),
    );
    // And without one, the message is exactly what it was before handbooks existed.
    expect(standingRoleMessage({ ...profile, bible: null })).toEqual(
      standingRoleMessage(profile),
    );
    expect(standingRoleMessage(profile).content).not.toContain("工作手册");
  });
});

describe("the Bible from the database to the runtime", () => {
  const form = {
    name: "后端小熊",
    title: "后端工程师",
    roleDescription: "按需求写实现、跑测试。",
    visibility: "private" as const,
  };

  test("a coworker running here gets the saved handbook on its next build, and loses it when cleared", async () => {
    const actor = await person();
    const created = await runAsTenant(actor.id, () =>
      unmanaged.create(actor, {
        ...form,
        systemPrompt: form.roleDescription,
        bible,
      }),
    );
    agentIds.push(created.id);
    const load = () =>
      runAsTenant(actor.id, () => createRuntimeAgentLoader(database)(actor));
    const registered = (await load()).find((agent) => agent.id === created.id);
    if (registered?.type !== "built_in") throw new Error("expected built_in");
    expect(registered.bible).toBe(bible);
    expect(
      (
        builtInAgentConfiguration(registered, model, "synthetic-key") as {
          prompt: string;
        }
      ).prompt,
    ).toContain(`${HEADING}\n\n${bible}`);

    await runAsTenant(actor.id, () =>
      unmanaged.update(actor, created.id, { ...form, bible: null }),
    );
    const cleared = (await load()).find((agent) => agent.id === created.id);
    if (cleared?.type !== "built_in") throw new Error("expected built_in");
    expect(cleared.bible).toBeUndefined();
    expect(
      (
        builtInAgentConfiguration(cleared, model, "synthetic-key") as {
          prompt: string;
        }
      ).prompt,
    ).not.toContain(HEADING);
  });

  test("a coworker running elsewhere gets it in the standing role the runtime builds", async () => {
    const actor = await person();
    const created = await runAsTenant(actor.id, () =>
      managed.create(actor, { ...form, persona, bible }),
    );
    agentIds.push(created.id);
    const registered = (
      await runAsTenant(actor.id, () =>
        createRuntimeAgentLoader(database)(actor),
      )
    ).find((agent) => agent.id === created.id);
    if (
      !registered ||
      registered.type === "built_in" ||
      registered.type === "unavailable"
    ) {
      throw new Error("expected a remote coworker");
    }
    const content = registered.standingMessage.content;
    expect(content).toContain(`${HEADING}\n\n${bible}\n\n${DEFERS}`);
    expect(content.indexOf("直接、简短。")).toBeLessThan(
      content.indexOf(HEADING),
    );
  });
});
