import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { staffingProposals } from "../src/db/schema/staffing";
import {
  createStaffingProposalStore,
  ProposalExpiredError,
  ProposalLimitError,
  ProposalNotFoundError,
  ProposalStateError,
} from "../src/staffing/store";
import type { GroupDraft } from "../src/staffing/types";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 提议存储：每人 20 份待确认的上限、pending 到 applying 只有一个赢家、过期读作 expired、
 * 别人的提议与不存在的提议一个样。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createStaffingProposalStore(database);
const suite = randomUUID().slice(0, 8);
const OWNER = `stf-${suite}-owner`;
const OTHER = `stf-${suite}-other`;
const people = [OWNER, OTHER];
const draft: GroupDraft = { name: "群", members: ["a", "b"] };

const as = <T>(person: string, work: () => Promise<T>) =>
  runAsTenant(person, work);
const make = (owner = OWNER, threadId: string | null = `t-${suite}`) =>
  store.create({
    ownerId: owner,
    proposedByAgentId: "agent-1",
    threadId,
    kind: "group",
    draft,
    baseVersion: null,
  });
const expireNow = (id: string) =>
  asPlatform(() =>
    database
      .update(staffingProposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(staffingProposals.id, id)),
  );
const clear = () =>
  asPlatform(() =>
    database
      .delete(staffingProposals)
      .where(inArray(staffingProposals.ownerId, people)),
  );

beforeAll(clear);
afterAll(async () => {
  await clear();
  await database.$client.close();
});

describe("staffing proposal store", () => {
  test("a created proposal reads back with a seven day expiry", async () => {
    const made = await as(OWNER, make);
    const read = await as(OWNER, () => store.get(made.id));
    expect(read).toEqual(made);
    expect(read?.status).toBe("pending");
    const days =
      (made.expiresAt.getTime() - made.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
    await clear();
  });

  test("the twenty-first pending proposal is refused", async () => {
    await as(OWNER, async () => {
      for (let i = 0; i < 20; i++) await make();
      await expect(make()).rejects.toBeInstanceOf(ProposalLimitError);
    });
    await as(OTHER, async () => {
      expect((await make(OTHER)).status).toBe("pending");
    });
    await clear();
  });

  test("claim moves pending to applying once", async () => {
    const made = await as(OWNER, make);
    const results = await as(OWNER, () =>
      Promise.allSettled([
        store.claim(made.id, OWNER),
        store.claim(made.id, OWNER),
      ]),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ProposalStateError,
    );
    expect(
      (won[0] as PromiseFulfilledResult<{ status: string }>).value.status,
    ).toBe("applying");
    await clear();
  });

  test("a pending proposal past its expiry reads as expired and cannot be claimed", async () => {
    const made = await as(OWNER, make);
    await expireNow(made.id);
    await as(OWNER, async () => {
      await expect(store.claim(made.id, OWNER)).rejects.toBeInstanceOf(
        ProposalExpiredError,
      );
      expect((await store.get(made.id))?.status).toBe("expired");
    });
    await clear();
  });

  test("reading an expired pending proposal stores it as expired", async () => {
    const made = await as(OWNER, make);
    await expireNow(made.id);
    expect((await as(OWNER, () => store.get(made.id)))?.status).toBe("expired");
    const stored = await asPlatform(() =>
      database
        .select()
        .from(staffingProposals)
        .where(eq(staffingProposals.id, made.id)),
    );
    expect(stored[0]?.status).toBe("expired");
    await clear();
  });

  test("editing after claim is refused", async () => {
    const made = await as(OWNER, make);
    await as(OWNER, async () => {
      await store.claim(made.id, OWNER);
      await expect(
        store.updateDraft(made.id, OWNER, {
          name: "新群",
          members: ["a", "b"],
        }),
      ).rejects.toBeInstanceOf(ProposalStateError);
    });
    await clear();
  });

  test("editing a pending proposal replaces its draft", async () => {
    const made = await as(OWNER, make);
    const next = { name: "新群", members: ["a", "b", "c"] };
    const updated = await as(OWNER, () =>
      store.updateDraft(made.id, OWNER, next),
    );
    expect(updated.draft).toEqual(next);
    await clear();
  });

  test("another person cannot claim, edit or discard", async () => {
    const made = await as(OWNER, make);
    await as(OWNER, async () => {
      await expect(store.claim(made.id, OTHER)).rejects.toBeInstanceOf(
        ProposalNotFoundError,
      );
      await expect(
        store.updateDraft(made.id, OTHER, draft),
      ).rejects.toBeInstanceOf(ProposalNotFoundError);
      await expect(store.discard(made.id, OTHER)).rejects.toBeInstanceOf(
        ProposalNotFoundError,
      );
      expect((await store.get(made.id))?.status).toBe("pending");
    });
    await clear();
  });

  test("a proposal that does not exist reads as not found", async () => {
    await as(OWNER, async () => {
      expect(await store.get(randomUUID())).toBeNull();
      await expect(store.claim(randomUUID(), OWNER)).rejects.toBeInstanceOf(
        ProposalNotFoundError,
      );
    });
  });

  test("discard only works on pending", async () => {
    const made = await as(OWNER, make);
    await as(OWNER, async () => {
      expect((await store.discard(made.id, OWNER)).status).toBe("discarded");
      await expect(store.discard(made.id, OWNER)).rejects.toBeInstanceOf(
        ProposalStateError,
      );
      await expect(store.claim(made.id, OWNER)).rejects.toBeInstanceOf(
        ProposalStateError,
      );
    });
    await clear();
  });

  test("finish records the result, and a partial one can be reopened for a retry", async () => {
    const made = await as(OWNER, make);
    await as(OWNER, async () => {
      await expect(store.finish(made.id, "applied", [])).rejects.toBeInstanceOf(
        ProposalStateError,
      );
      await store.claim(made.id, OWNER);
      const result = [
        { step: "create", outcome: "done" as const },
        { step: "routine", outcome: "failed" as const, message: "额度已满" },
      ];
      const partial = await store.finish(made.id, "partially_applied", result);
      expect(partial.status).toBe("partially_applied");
      expect(partial.result).toEqual(result);
      expect((await store.reopenFailed(made.id, OWNER)).status).toBe(
        "applying",
      );
      const done = await store.finish(made.id, "applied", result);
      expect(done.status).toBe("applied");
      await expect(store.reopenFailed(made.id, OWNER)).rejects.toBeInstanceOf(
        ProposalStateError,
      );
    });
    await clear();
  });

  test("release puts an applying proposal back to pending", async () => {
    const made = await as(OWNER, make);
    await as(OWNER, async () => {
      await expect(store.release(made.id, OWNER)).rejects.toBeInstanceOf(
        ProposalStateError,
      );
      await store.claim(made.id, OWNER);
      await expect(store.release(made.id, OTHER)).rejects.toBeInstanceOf(
        ProposalNotFoundError,
      );
      expect((await store.release(made.id, OWNER)).status).toBe("pending");
      expect((await store.claim(made.id, OWNER)).status).toBe("applying");
    });
    await clear();
  });

  test("countCreatedSince counts that owner's proposals in that thread from the given time", async () => {
    const before = new Date(Date.now() - 60_000);
    await as(OWNER, async () => {
      const first = await make(OWNER, `t-${suite}`);
      await make(OWNER, `t-${suite}`);
      await make(OWNER, `other-${suite}`);
      await make(OWNER, null);
      await store.discard(first.id, OWNER);
      expect(await store.countCreatedSince(OWNER, `t-${suite}`, before)).toBe(
        2,
      );
      expect(await store.countCreatedSince(OWNER, null, before)).toBe(1);
      expect(
        await store.countCreatedSince(
          OWNER,
          `t-${suite}`,
          new Date(Date.now() + 60_000),
        ),
      ).toBe(0);
    });
    await as(OTHER, async () => {
      await make(OTHER, `t-${suite}`);
      expect(await store.countCreatedSince(OTHER, `t-${suite}`, before)).toBe(
        1,
      );
    });
    await clear();
  });
});
