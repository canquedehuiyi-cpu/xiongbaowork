import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, auditEvents, users } from "../src/db/schema";
import {
  knowledgeNotebooks,
  knowledgeSources,
} from "../src/db/schema/knowledge-foundations";
import { knowledgeBindings } from "../src/db/schema/knowledge-write-foundations";
import { createKnowledgeRoutes } from "../src/knowledge/routes";
import {
  createKnowledgeStore,
  KnowledgeScopeError,
} from "../src/knowledge/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Story RES1 (D08): an independent knowledge base a person creates, maintains and lends to their
 * own Wakers, on the real database as the app role, with two tenants.
 *
 * Each assertion about a stranger is preceded by the owner reading the same thing successfully, so a
 * 404 for the stranger is evidence of isolation rather than of a fixture that never worked.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createKnowledgeStore(database);
const suite = randomUUID().slice(0, 8);
const owner = `kb-${suite}-owner`;
const stranger = `kb-${suite}-stranger`;
const ownerWaker = `kb-${suite}-owner-waker`;
const ownerOtherWaker = `kb-${suite}-owner-waker-2`;
const strangerWaker = `kb-${suite}-stranger-waker`;

const guardFor =
  (actorId: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", {
      id: actorId,
      email: `${actorId}@example.test`,
      role: "user" as const,
    });
    await runAsTenant(actorId, () => next());
  };

async function call(
  actorId: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
) {
  const routes = createKnowledgeRoutes(store, guardFor(actorId));
  const response = await routes.request(
    new Request(`http://openbot.test${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field
    json: (text ? JSON.parse(text) : null) as Record<string, any>,
  };
}

async function wakerFor(tenant: string, agentId: string) {
  await runAsTenant(tenant, async () => {
    await database.insert(agents).values({
      id: agentId,
      tenantId: tenant,
      name: `Waker ${agentId}`,
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId,
      tenantId: tenant,
      ownerUserId: tenant,
      title: "知识助理",
      roleDescription: "Reads the owner's notes.",
      avatarSeed: agentId,
      visibility: "private",
    });
  });
}

const auditTypesFor = (tenant: string, targetId: string) =>
  runAsTenant(tenant, () =>
    database
      .select({
        eventType: auditEvents.eventType,
        payload: auditEvents.payload,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetId, targetId),
          like(auditEvents.eventType, "knowledge.%"),
        ),
      ),
  );

beforeAll(async () => {
  // Each person is seeded in their own frame: a test has no unframed fallback since G01-E.
  for (const [id, name] of [
    [owner, "Owner"],
    [stranger, "Stranger"],
  ] as const)
    await runAsTenant(id, () =>
      database
        .insert(users)
        .values({ id, email: `${id}@example.test`, name })
        .onConflictDoNothing(),
    );
  await wakerFor(owner, ownerWaker);
  await wakerFor(owner, ownerOtherWaker);
  await wakerFor(stranger, strangerWaker);
});

afterAll(async () => {
  for (const [tenant, ids] of [
    [owner, [ownerWaker, ownerOtherWaker]],
    [stranger, [strangerWaker]],
  ] as const) {
    await runAsTenant(tenant, async () => {
      await database
        .delete(knowledgeNotebooks)
        .where(eq(knowledgeNotebooks.ownerUserId, tenant));
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, [...ids]));
      await database.delete(agents).where(inArray(agents.id, [...ids]));
    });
  }
  // Cleanup spans both people this file seeded, which only the platform reaches.
  await runAsTenant("platform", () =>
    database.delete(users).where(inArray(users.id, [owner, stranger])),
  );
  await database.$client.close();
});

describe("RES1 knowledge base", () => {
  let notebookId = "";
  let sourceId = "";

  test("an owner creates a notebook; a stranger cannot see, rename or delete it", async () => {
    const created = await call(owner, "POST", "/notebooks", {
      title: "  产品手册  ",
    });
    expect(created.status).toBe(201);
    expect(created.json.notebook.title).toBe("产品手册");
    expect(created.json.notebook.revision).toBe(1);
    notebookId = created.json.notebook.id;

    const mine = await call(owner, "GET", "/notebooks");
    expect(mine.json.notebooks.map((n: { id: string }) => n.id)).toContain(
      notebookId,
    );
    expect((await call(owner, "GET", `/notebooks/${notebookId}`)).status).toBe(
      200,
    );

    const theirs = await call(stranger, "GET", "/notebooks");
    expect(theirs.status).toBe(200);
    expect(
      theirs.json.notebooks.map((n: { id: string }) => n.id),
    ).not.toContain(notebookId);
    expect(
      (await call(stranger, "GET", `/notebooks/${notebookId}`)).status,
    ).toBe(404);
    expect(
      (
        await call(stranger, "PATCH", `/notebooks/${notebookId}`, {
          title: "x",
          revision: 1,
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(stranger, "DELETE", `/notebooks/${notebookId}`)).status,
    ).toBe(404);
    expect(
      (
        await call(stranger, "POST", `/notebooks/${notebookId}/sources`, {
          title: "x",
          content: "x",
        })
      ).status,
    ).toBe(404);

    // The row is stamped with the owner's tenant, and the database itself hides it from the stranger.
    const [row] = await runAsTenant(owner, () =>
      database
        .select()
        .from(knowledgeNotebooks)
        .where(eq(knowledgeNotebooks.id, notebookId)),
    );
    expect(row?.tenantId).toBe(owner);
    expect(row?.ownerUserId).toBe(owner);
    const leaked = await runAsTenant(stranger, () =>
      database
        .select()
        .from(knowledgeNotebooks)
        .where(eq(knowledgeNotebooks.id, notebookId)),
    );
    expect(leaked).toEqual([]);
    expect(
      (await auditTypesFor(owner, notebookId)).map((e) => e.eventType),
    ).toContain("knowledge.notebook_created");
  });

  test("a rename needs the current revision and a stale one is a 409 that changes nothing", async () => {
    const renamed = await call(owner, "PATCH", `/notebooks/${notebookId}`, {
      title: "产品手册 v2",
      revision: 1,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.notebook.revision).toBe(2);

    const stale = await call(owner, "PATCH", `/notebooks/${notebookId}`, {
      title: "覆盖",
      revision: 1,
    });
    expect(stale.status).toBe(409);
    const read = await call(owner, "GET", `/notebooks/${notebookId}`);
    expect(read.json.notebook.title).toBe("产品手册 v2");
    expect(read.json.notebook.revision).toBe(2);

    expect(
      (
        await call(owner, "PATCH", `/notebooks/${notebookId}`, {
          title: "无版本",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(owner, "PATCH", `/notebooks/${notebookId}`, {
          title: "",
          revision: 2,
        })
      ).status,
    ).toBe(400);
    const audits = (await auditTypesFor(owner, notebookId)).filter(
      (e) => e.eventType === "knowledge.notebook_updated",
    );
    expect(audits).toHaveLength(1);
  });

  test("text and markdown sources carry a sha256 digest and the 64K character cap", async () => {
    const text = "熊宝的发布日期是周二。";
    const added = await call(
      owner,
      "POST",
      `/notebooks/${notebookId}/sources`,
      {
        title: "发布说明",
        kind: "text",
        content: text,
      },
    );
    expect(added.status).toBe(201);
    sourceId = added.json.source.id;
    expect(added.json.source.digest).toBe(
      createHash("sha256").update(text, "utf8").digest("hex"),
    );
    expect(added.json.source.chars).toBe([...text].length);
    expect(added.json.source.revision).toBe(1);

    const markdown = await call(
      owner,
      "POST",
      `/notebooks/${notebookId}/sources`,
      {
        title: "目录",
        kind: "markdown",
        content: "# 标题\n\n- 一\n- 二",
      },
    );
    expect(markdown.status).toBe(201);
    expect(markdown.json.source.kind).toBe("markdown");

    // Exactly at the cap, counted in characters (three UTF-8 bytes each here), is accepted.
    const atCap = await call(
      owner,
      "POST",
      `/notebooks/${notebookId}/sources`,
      {
        title: "满额",
        content: "熊".repeat(65_536),
      },
    );
    expect(atCap.status).toBe(201);
    expect(atCap.json.source.chars).toBe(65_536);

    const overCap = await call(
      owner,
      "POST",
      `/notebooks/${notebookId}/sources`,
      {
        title: "超额",
        content: "a".repeat(65_537),
      },
    );
    expect(overCap.status).toBe(413);
    expect(
      (
        await call(owner, "POST", `/notebooks/${notebookId}/sources`, {
          title: "空",
          content: "   ",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(owner, "POST", `/notebooks/${notebookId}/sources`, {
          title: "网页",
          kind: "url",
          content: "https://example.test",
        })
      ).status,
    ).toBe(400);

    const listed = await call(owner, "GET", `/notebooks/${notebookId}`);
    expect(
      listed.json.sources.map((s: { title: string }) => s.title).sort(),
    ).toEqual(["发布说明", "满额", "目录"].sort());
    // Summaries carry no text; the text is read one source at a time.
    expect(listed.json.sources[0].content).toBeUndefined();
    const read = await call(
      owner,
      "GET",
      `/notebooks/${notebookId}/sources/${sourceId}`,
    );
    expect(read.json.source.content).toBe(text);
    expect(
      (
        await call(
          stranger,
          "GET",
          `/notebooks/${notebookId}/sources/${sourceId}`,
        )
      ).status,
    ).toBe(404);

    const audit = await auditTypesFor(owner, sourceId);
    expect(audit.map((e) => e.eventType)).toEqual(["knowledge.source_added"]);
    // The trail records what changed, never the text itself.
    expect(JSON.stringify(audit[0]?.payload)).not.toContain("周二");
  });

  test("editing and removing a source are revisioned, and removing one is audited", async () => {
    const next = "熊宝的发布日期改到周三。";
    const edited = await call(
      owner,
      "PATCH",
      `/notebooks/${notebookId}/sources/${sourceId}`,
      {
        content: next,
        revision: 1,
      },
    );
    expect(edited.status).toBe(200);
    expect(edited.json.source.revision).toBe(2);
    expect(edited.json.source.digest).toBe(
      createHash("sha256").update(next, "utf8").digest("hex"),
    );
    const stale = await call(
      owner,
      "PATCH",
      `/notebooks/${notebookId}/sources/${sourceId}`,
      {
        content: "旧版本覆盖",
        revision: 1,
      },
    );
    expect(stale.status).toBe(409);
    expect(
      (await call(owner, "GET", `/notebooks/${notebookId}/sources/${sourceId}`))
        .json.source.content,
    ).toBe(next);

    // A delete from a stale view is refused like a stale edit, and erases nothing.
    const kept = await call(owner, "POST", `/notebooks/${notebookId}/sources`, {
      title: "两个标签页",
      content: "第一版",
    });
    const keptId = kept.json.source.id;
    const keptPath = `/notebooks/${notebookId}/sources/${keptId}`;
    expect(
      (await call(owner, "PATCH", keptPath, { content: "第二版", revision: 1 }))
        .status,
    ).toBe(200);
    expect(
      (await call(owner, "DELETE", keptPath, { revision: 1 })).status,
    ).toBe(409);
    expect((await call(owner, "GET", keptPath)).json.source.content).toBe(
      "第二版",
    );
    expect(
      (await auditTypesFor(owner, keptId)).map((e) => e.eventType),
    ).not.toContain("knowledge.source_removed");
    expect(
      (await call(owner, "DELETE", keptPath, { revision: "2" })).status,
    ).toBe(400);
    expect(
      (await call(owner, "DELETE", keptPath, { revision: 2 })).status,
    ).toBe(204);
    expect((await call(owner, "GET", keptPath)).status).toBe(404);

    const scratch = await call(
      owner,
      "POST",
      `/notebooks/${notebookId}/sources`,
      {
        title: "草稿",
        content: "临时",
      },
    );
    const scratchId = scratch.json.source.id;
    expect(
      (
        await call(
          stranger,
          "DELETE",
          `/notebooks/${notebookId}/sources/${scratchId}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          owner,
          "DELETE",
          `/notebooks/${notebookId}/sources/${scratchId}`,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await call(
          owner,
          "GET",
          `/notebooks/${notebookId}/sources/${scratchId}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await auditTypesFor(owner, scratchId)).map((e) => e.eventType).sort(),
    ).toEqual(["knowledge.source_added", "knowledge.source_removed"].sort());
    expect(
      (await auditTypesFor(owner, sourceId)).map((e) => e.eventType),
    ).toContain("knowledge.source_updated");
  });

  test("read-only bindings go only to the owner's own Wakers", async () => {
    const granted = await call(
      owner,
      "PUT",
      `/notebooks/${notebookId}/bindings/${ownerWaker}`,
      {
        accessMode: "read_only",
      },
    );
    expect(granted.status).toBe(200);
    expect(granted.json.binding.accessMode).toBe("read_only");

    // Somebody else's Waker, a Waker that does not exist, and write access are all refused.
    expect(
      (
        await call(
          owner,
          "PUT",
          `/notebooks/${notebookId}/bindings/${strangerWaker}`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          owner,
          "PUT",
          `/notebooks/${notebookId}/bindings/kb-${suite}-nobody`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          owner,
          "PUT",
          `/notebooks/${notebookId}/bindings/${ownerOtherWaker}`,
          {
            accessMode: "read_write",
          },
        )
      ).status,
    ).toBe(400);
    // The stranger cannot lend the owner's notebook to their own Waker either.
    expect(
      (
        await call(
          stranger,
          "PUT",
          `/notebooks/${notebookId}/bindings/${strangerWaker}`,
        )
      ).status,
    ).toBe(404);

    const forWaker = await call(owner, "GET", `/for/${ownerWaker}`);
    expect(forWaker.status).toBe(200);
    expect(forWaker.json.notebooks).toEqual([
      { notebookId, title: "产品手册 v2", accessMode: "read_only" },
    ]);
    expect(
      (await call(owner, "GET", `/for/${ownerOtherWaker}`)).json.notebooks,
    ).toEqual([]);
    expect((await call(owner, "GET", `/for/${strangerWaker}`)).status).toBe(
      403,
    );
    expect((await call(stranger, "GET", `/for/${ownerWaker}`)).status).toBe(
      403,
    );

    const detail = await call(owner, "GET", `/notebooks/${notebookId}`);
    expect(
      detail.json.bindings.map((b: { agentId: string }) => b.agentId),
    ).toEqual([ownerWaker]);

    // Revoke and grant again so both events are on the trail.
    expect(
      (
        await call(
          owner,
          "DELETE",
          `/notebooks/${notebookId}/bindings/${ownerWaker}`,
        )
      ).json.removed,
    ).toBe(true);
    expect(
      (await call(owner, "GET", `/for/${ownerWaker}`)).json.notebooks,
    ).toEqual([]);
    expect(
      (
        await call(
          owner,
          "PUT",
          `/notebooks/${notebookId}/bindings/${ownerWaker}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          owner,
          "PUT",
          `/notebooks/${notebookId}/bindings/${ownerOtherWaker}`,
        )
      ).status,
    ).toBe(200);
    const events = (await auditTypesFor(owner, notebookId)).map(
      (e) => e.eventType,
    );
    expect(
      events.filter((e) => e === "knowledge.binding_granted"),
    ).toHaveLength(3);
    expect(
      events.filter((e) => e === "knowledge.binding_revoked"),
    ).toHaveLength(1);
  });

  test("soft delete hides the notebook and drops every binding in the same step", async () => {
    const stale = await call(owner, "DELETE", `/notebooks/${notebookId}`, {
      revision: 1,
    });
    expect(stale.status).toBe(409);
    expect(
      (await call(owner, "GET", `/for/${ownerWaker}`)).json.notebooks,
    ).toHaveLength(1);

    const deleted = await call(owner, "DELETE", `/notebooks/${notebookId}`, {
      revision: 2,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.json).toEqual({ deleted: true, bindingsRemoved: 2 });

    expect((await call(owner, "GET", `/notebooks/${notebookId}`)).status).toBe(
      404,
    );
    expect(
      (await call(owner, "GET", "/notebooks")).json.notebooks.map(
        (n: { id: string }) => n.id,
      ),
    ).not.toContain(notebookId);
    expect(
      (await call(owner, "GET", `/for/${ownerWaker}`)).json.notebooks,
    ).toEqual([]);
    expect(
      (
        await call(
          owner,
          "PUT",
          `/notebooks/${notebookId}/bindings/${ownerWaker}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await call(owner, "DELETE", `/notebooks/${notebookId}`)).status,
    ).toBe(404);

    await runAsTenant(owner, async () => {
      const [row] = await database
        .select()
        .from(knowledgeNotebooks)
        .where(eq(knowledgeNotebooks.id, notebookId));
      expect(row?.deletedAt).toBeInstanceOf(Date);
      expect(
        await database
          .select()
          .from(knowledgeBindings)
          .where(eq(knowledgeBindings.notebookId, notebookId)),
      ).toEqual([]);
      // Sources stay with the deleted notebook; they are simply unreachable.
      expect(
        (
          await database
            .select()
            .from(knowledgeSources)
            .where(eq(knowledgeSources.notebookId, notebookId))
        ).length,
      ).toBe(3);
    });
    const deletion = (await auditTypesFor(owner, notebookId)).find(
      (e) => e.eventType === "knowledge.notebook_deleted",
    );
    expect(deletion?.payload).toMatchObject({ notebookId, revision: 3 });
  });

  test("the store refuses an actor that is not the tenant frame, and runs nowhere without one", async () => {
    await expect(
      runAsTenant(stranger, () => store.listNotebooks(owner)),
    ).rejects.toBeInstanceOf(KnowledgeScopeError);
    await expect(
      store.createNotebook(owner, { title: "无帧" }),
    ).rejects.toBeInstanceOf(KnowledgeScopeError);
    await expect(
      runAsTenant(stranger, () =>
        store.createNotebook(owner, { title: "冒名" }),
      ),
    ).rejects.toBeInstanceOf(KnowledgeScopeError);
    const names = (
      await runAsTenant(owner, () => store.listNotebooks(owner))
    ).map((n) => n.title);
    expect(names).not.toContain("冒名");
    expect(names).not.toContain("无帧");
  });
});
