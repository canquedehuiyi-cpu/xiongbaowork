import { afterEach, expect, test } from "bun:test";
import {
  BotPausedError,
  checkRunningTurnsForTests,
  configureBotLifecycle,
  guardBotTurn,
  resetBotLifecycleForTests,
} from "../src/agents/lifecycle";
import type { Database } from "../src/db/client";
import { currentTenant, runAsTenant } from "../src/tenant/context";

/**
 * The pause watcher against a database that can fail on demand. A turn must not start while the
 * pause cannot be read, but one failed read in the five-second poll must not stop every turn a
 * replica is running for every person: only a pause, or a database that stays unreadable, does.
 */
function flakyDatabase() {
  const state = { fail: false, pausedAt: null as Date | null };
  const query = {
    from: () => query,
    where: () => query,
    limit: async () => {
      if (state.fail) throw new Error("connection terminated unexpectedly");
      return [{ pausedAt: state.pausedAt }];
    },
  };
  const database = { select: () => query } as unknown as Database;
  return { database, state };
}

afterEach(() => resetBotLifecycleForTests());

test("a turn does not start while the pause cannot be read", async () => {
  const { database, state } = flakyDatabase();
  configureBotLifecycle({ database });
  state.fail = true;
  await expect(
    guardBotTurn({ ownerUserId: "ada", agentId: "bot" }),
  ).rejects.toBeInstanceOf(BotPausedError);
});

test("one failed read in the watcher leaves running turns alone", async () => {
  const { database, state } = flakyDatabase();
  configureBotLifecycle({ database });
  const ada = await guardBotTurn({ ownerUserId: "ada", agentId: "bot" });
  const grace = await guardBotTurn({ ownerUserId: "grace", agentId: "other" });

  state.fail = true;
  await checkRunningTurnsForTests();
  expect(ada.aborted).toBe(false);
  expect(grace.aborted).toBe(false);

  state.fail = false;
  await checkRunningTurnsForTests();
  state.fail = true;
  await checkRunningTurnsForTests();
  await checkRunningTurnsForTests();
  // A read that recovered in between starts the count again.
  expect(ada.aborted).toBe(false);
});

test("a database that stays unreadable stops the turns, and a pause stops them at once", async () => {
  const { database, state } = flakyDatabase();
  configureBotLifecycle({ database });
  const signal = await guardBotTurn({ ownerUserId: "ada", agentId: "bot" });
  state.fail = true;
  for (let check = 0; check < 3; check += 1) await checkRunningTurnsForTests();
  expect(signal.aborted).toBe(true);

  state.fail = false;
  const next = await guardBotTurn({ ownerUserId: "ada", agentId: "bot" });
  state.pausedAt = new Date();
  await checkRunningTurnsForTests();
  expect(next.aborted).toBe(true);
});

/*
 * G01-D: the watcher's interval has no frame of its own (or the frame of whoever's turn started it),
 * so each pause is re-read as the tenant its turn was started in. Run under the `throw` guard, so a
 * read left to the interval's frame fails instead of answering as `system`.
 */
test("the watcher re-reads each pause as the tenant its turn was started in", async () => {
  const reads: string[] = [];
  const query = {
    from: () => query,
    where: () => query,
    limit: async () => {
      reads.push(currentTenant());
      return [{ pausedAt: null }];
    },
  };
  configureBotLifecycle({
    database: { select: () => query } as unknown as Database,
  });
  await runAsTenant("ada", () =>
    guardBotTurn({ ownerUserId: "ada", agentId: "bot" }),
  );
  await runAsTenant("grace", () =>
    guardBotTurn({ ownerUserId: "grace", agentId: "other" }),
  );
  reads.length = 0;

  const saved = process.env.OPENBOT_TENANT_FRAME_GUARD;
  process.env.OPENBOT_TENANT_FRAME_GUARD = "throw";
  try {
    // From grace's frame too: the interval inherits whichever frame first started it.
    await checkRunningTurnsForTests();
    await runAsTenant("grace", () => checkRunningTurnsForTests());
  } finally {
    if (saved === undefined) delete process.env.OPENBOT_TENANT_FRAME_GUARD;
    else process.env.OPENBOT_TENANT_FRAME_GUARD = saved;
  }
  expect(reads).toEqual(["ada", "grace", "ada", "grace"]);
});
