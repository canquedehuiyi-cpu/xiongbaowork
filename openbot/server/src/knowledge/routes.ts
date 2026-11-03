import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import {
  KnowledgeConflictError,
  KnowledgeForbiddenError,
  KnowledgeNotFoundError,
  KnowledgeRefusedError,
  KnowledgeScopeError,
  type KnowledgeStore,
  KnowledgeTooLargeError,
} from "./store";

/**
 * `/api/knowledge`: a person's notebooks, the text kept in them, and which of their Wakers may read
 * which notebook. Every route is behind `requireUser`, which also opens the caller's tenant frame;
 * the store refuses to run outside it.
 *
 *   GET    /notebooks                                  list live notebooks
 *   POST   /notebooks                                  { title }
 *   GET    /notebooks/:id                              notebook, source summaries, bindings
 *   PATCH  /notebooks/:id                              { title, revision }        409 when stale
 *   DELETE /notebooks/:id                              { revision? }              soft delete, drops bindings
 *   POST   /notebooks/:id/sources                      { title, kind, content }   text|markdown, 64K chars
 *   GET    /notebooks/:id/sources/:sourceId
 *   PATCH  /notebooks/:id/sources/:sourceId            { title?, content?, revision }
 *   DELETE /notebooks/:id/sources/:sourceId
 *   PUT    /notebooks/:id/bindings/:agentId            { accessMode: "read_only" } 403 unless their Waker
 *   DELETE /notebooks/:id/bindings/:agentId
 *   GET    /for/:agentId                               the notebooks a Waker may read
 */
export function createKnowledgeRoutes(
  store: KnowledgeStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  // 64K characters can be four bytes each, and JSON escaping grows them further.
  routes.use("*", requireUser, bodyLimit({ maxSize: 1_048_576 }));
  routes.onError((error, context) => {
    if (error instanceof KnowledgeNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof KnowledgeConflictError)
      return context.json({ error: error.message }, 409);
    if (error instanceof KnowledgeForbiddenError)
      return context.json({ error: error.message }, 403);
    if (error instanceof KnowledgeTooLargeError)
      return context.json({ error: error.message }, 413);
    if (error instanceof KnowledgeRefusedError)
      return context.json({ error: error.message }, 400);
    if (error instanceof KnowledgeScopeError)
      return context.json({ error: error.message }, 403);
    console.error(
      JSON.stringify({
        type: "knowledge-route-error",
        error: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: "知识库暂时不可用，请稍后再试。" }, 503);
  });

  routes.get("/notebooks", async (context) =>
    context.json({
      notebooks: await store.listNotebooks(context.var.actor.id),
    }),
  );
  routes.post("/notebooks", async (context) =>
    context.json(
      {
        notebook: await store.createNotebook(
          context.var.actor.id,
          await body(context.req.raw),
        ),
      },
      201,
    ),
  );
  routes.get("/notebooks/:id", async (context) =>
    context.json(
      await store.getNotebook(context.var.actor.id, context.req.param("id")),
    ),
  );
  routes.patch("/notebooks/:id", async (context) =>
    context.json({
      notebook: await store.updateNotebook(
        context.var.actor.id,
        context.req.param("id"),
        await body(context.req.raw),
      ),
    }),
  );
  routes.delete("/notebooks/:id", async (context) =>
    context.json(
      await store.deleteNotebook(
        context.var.actor.id,
        context.req.param("id"),
        await optionalBody(context.req.raw),
      ),
    ),
  );

  routes.post("/notebooks/:id/sources", async (context) =>
    context.json(
      {
        source: await store.addSource(
          context.var.actor.id,
          context.req.param("id"),
          await body(context.req.raw),
        ),
      },
      201,
    ),
  );
  routes.get("/notebooks/:id/sources/:sourceId", async (context) =>
    context.json({
      source: await store.getSource(
        context.var.actor.id,
        context.req.param("id"),
        context.req.param("sourceId"),
      ),
    }),
  );
  routes.patch("/notebooks/:id/sources/:sourceId", async (context) =>
    context.json({
      source: await store.updateSource(
        context.var.actor.id,
        context.req.param("id"),
        context.req.param("sourceId"),
        await body(context.req.raw),
      ),
    }),
  );
  routes.delete("/notebooks/:id/sources/:sourceId", async (context) => {
    await store.removeSource(
      context.var.actor.id,
      context.req.param("id"),
      context.req.param("sourceId"),
    );
    return context.body(null, 204);
  });

  routes.put("/notebooks/:id/bindings/:agentId", async (context) =>
    context.json({
      binding: await store.bind(
        context.var.actor.id,
        context.req.param("id"),
        context.req.param("agentId"),
        await optionalBody(context.req.raw),
      ),
    }),
  );
  routes.delete("/notebooks/:id/bindings/:agentId", async (context) =>
    context.json(
      await store.unbind(
        context.var.actor.id,
        context.req.param("id"),
        context.req.param("agentId"),
      ),
    ),
  );

  routes.get("/for/:agentId", async (context) =>
    context.json({
      notebooks: await store.notebooksForAgent(
        context.var.actor.id,
        context.req.param("agentId"),
      ),
    }),
  );

  return routes;
}

async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new KnowledgeRefusedError("请以 JSON 格式提交。");
  try {
    return await request.json();
  } catch {
    throw new KnowledgeRefusedError("无法读取提交的内容。");
  }
}

/** A body that may be absent: DELETE and PUT without one take their defaults. */
async function optionalBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new KnowledgeRefusedError("无法读取提交的内容。");
  }
}
