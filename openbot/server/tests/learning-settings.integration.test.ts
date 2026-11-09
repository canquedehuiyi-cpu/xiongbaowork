import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  learningSettings,
  learningThreadBindings,
} from "../src/db/schema/learning";
import { createLearningSettingsStore } from "../src/learning/settings";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const threads: string[] = [];
/*
 * This fork reads and writes only inside a tenant frame. The deployment's settings are an
 * administrator's, written in the platform frame; a thread's assignment is the person's own row,
 * written in their frame (0154), and read back here in the platform frame, which sees every row.
 */
const asPlatform = <T>(work: () => T) => runAsTenant("platform", work);
const as = <T>(person: string, work: () => T) => runAsTenant(person, work);
afterAll(async () => {
  await asPlatform(async () => {
    if (threads.length)
      await database
        .delete(learningThreadBindings)
        .where(inArray(learningThreadBindings.threadId, threads));
    await database
      .delete(learningSettings)
      .where(eq(learningSettings.id, "current"));
  });
  await database.$client.close();
});

describe("durable Learning settings", () => {
  test("a fresh database enables learning without a default container", async () => {
    const store = createLearningSettingsStore(database);
    expect(await asPlatform(() => store.read())).toEqual({
      enabled: true,
      defaultTarget: null,
      agents: {},
    });
  });

  test.each([
    [false, null],
    [true, null],
    [false, { containerId: "saved-default", revision: "saved-revision" }],
  ] as const)(
    "saved enabled=%j and target=%j override defaults across independent stores and restart",
    async (enabled, defaultTarget) => {
      const first = createLearningSettingsStore(database, {
        containerId: "environment-default",
      });
      const second = createLearningSettingsStore(database, {
        containerId: "other-environment",
      });
      const settings = {
        enabled,
        defaultTarget,
        agents: {
          bot: { containerId: "support", revision: "7" },
          excluded: null,
        },
      };
      await asPlatform(() => first.write(settings));
      expect(await asPlatform(() => second.read())).toEqual(settings);
      const restartedDatabase = createDatabase(testDatabaseUrl(), TEST_POOL);
      try {
        const restarted = createLearningSettingsStore(restartedDatabase, {
          containerId: "restart-default",
        });
        expect(await asPlatform(() => restarted.read())).toEqual(settings);
      } finally {
        await restartedDatabase.$client.close();
      }
    },
  );

  test("concurrent servers agree on one first assignment including exclusions", async () => {
    const first = createLearningSettingsStore(database);
    const second = createLearningSettingsStore(database);
    const threadId = `learning-${randomUUID()}`;
    threads.push(threadId);
    const values = await Promise.all([
      as("owner", () =>
        first.bindThread({
          userId: "owner",
          threadId,
          agentId: "one",
          containerId: null,
        }),
      ),
      as("owner", () =>
        second.bindThread({
          userId: "owner",
          threadId,
          agentId: "two",
          containerId: "support",
        }),
      ),
    ]);
    expect(values[0]).toBe(values[1]);
    const restarted = createLearningSettingsStore(database);
    expect(
      await as("owner", () =>
        restarted.bindThread({
          userId: "owner",
          threadId,
          agentId: "three",
          containerId: "changed",
        }),
      ),
    ).toBe(values[0]);
    expect(
      await asPlatform(() =>
        database
          .select()
          .from(learningThreadBindings)
          .where(eq(learningThreadBindings.threadId, threadId)),
      ),
    ).toHaveLength(1);
  });
  test("two users independently bind the same supplied thread ID", async () => {
    const store = createLearningSettingsStore(database);
    const threadId = `learning-${randomUUID()}`;
    threads.push(threadId);
    expect(
      await as("attacker", () =>
        store.bindThread({
          userId: "attacker",
          threadId,
          agentId: "bot",
          containerId: "unrelated",
        }),
      ),
    ).toBe("unrelated");
    expect(
      await as("owner", () =>
        store.bindThread({
          userId: "owner",
          threadId,
          agentId: "bot",
          containerId: "support",
        }),
      ),
    ).toBe("support");
    expect(
      await asPlatform(() =>
        database
          .select()
          .from(learningThreadBindings)
          .where(eq(learningThreadBindings.threadId, threadId)),
      ),
    ).toHaveLength(2);
    // Row security: each person's frame sees only their own assignment (0154).
    const seenBy = (person: string) =>
      as(person, () =>
        database
          .select({ containerId: learningThreadBindings.containerId })
          .from(learningThreadBindings)
          .where(eq(learningThreadBindings.threadId, threadId)),
      );
    expect(await seenBy("owner")).toEqual([{ containerId: "support" }]);
    expect(await seenBy("attacker")).toEqual([{ containerId: "unrelated" }]);
  });
});
