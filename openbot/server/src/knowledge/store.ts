import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { type AuditEventInput, commitOwnerAssembly } from "../audit";
import type { Database } from "../db/client";
import { agentProfiles, agents } from "../db/schema";
import {
  knowledgeNotebooks,
  knowledgeSources,
} from "../db/schema/knowledge-foundations";
import { knowledgeBindings } from "../db/schema/knowledge-write-foundations";
import { TEAM_TENANT } from "../db/schema/tenant";
import { isPersonTenant, runAsTenant, tenantFrame } from "../tenant/context";

/**
 * A person's own knowledge base (D08, story RES1): notebooks, the text they keep in them, and which
 * of their Wakers may read which notebook.
 *
 * WHOSE ROWS. Every row is stamped with the tenant and owner of the caller frame, and the frame is
 * checked against the actor on every call: the tables' policies admit `owner_user_id = tenant_id`
 * under `app.tenant_id`, so a store that trusted a passed-in id while running in somebody else's
 * frame would be one forgotten guard away from writing into the wrong workspace. Nothing here falls
 * back to a default tenant; a call outside a person frame (none, `system`, `platform`, or the `team`
 * stamp) is refused.
 *
 * WHAT IS NOT HERE YET. Directories, file/url/document sources and `read_write` bindings have tables
 * but no writer: a Waker may only ever be granted read access, and writes from a run need the claim
 * machinery in `knowledge_write_claims`, which is its own package.
 */

/** The cap the table enforces (`knowledge_source_raw_check`), in characters as PostgreSQL counts them. */
export const KNOWLEDGE_SOURCE_MAX_CHARS = 65_536;
const TITLE_MAX_CHARS = 120;

export type KnowledgeSourceKind = "text" | "markdown";
export type KnowledgeAccessMode = "read_only";

export class KnowledgeNotFoundError extends Error {
  constructor(message = "找不到这个知识库。") {
    super(message);
    this.name = "KnowledgeNotFoundError";
  }
}
export class KnowledgeConflictError extends Error {
  constructor(message = "内容已被修改，请刷新后再保存。") {
    super(message);
    this.name = "KnowledgeConflictError";
  }
}
export class KnowledgeForbiddenError extends Error {
  constructor(message = "只能授权给你自己的 Waker。") {
    super(message);
    this.name = "KnowledgeForbiddenError";
  }
}
export class KnowledgeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeRefusedError";
  }
}
export class KnowledgeTooLargeError extends Error {
  constructor() {
    super("单个资料最多 64K 字符。");
    this.name = "KnowledgeTooLargeError";
  }
}
/** The actor and the tenant frame disagree. Never a person's mistake, so never a 4xx they can fix. */
export class KnowledgeScopeError extends Error {
  constructor() {
    super("知识库请求的身份与当前工作区不一致。");
    this.name = "KnowledgeScopeError";
  }
}

export type KnowledgeNotebook = {
  id: string;
  title: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};
export type KnowledgeSourceSummary = {
  id: string;
  notebookId: string;
  title: string;
  kind: string;
  digest: string | null;
  chars: number;
  revision: number;
  updatedAt: Date;
};
export type KnowledgeSource = KnowledgeSourceSummary & { content: string };
export type KnowledgeBinding = {
  agentId: string;
  notebookId: string;
  accessMode: string;
  updatedAt: Date;
};
export type KnowledgeExcerpt = {
  notebookId: string;
  notebookTitle: string;
  sourceId: string;
  sourceTitle: string;
  excerpt: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const chars = (value: string) => [...value].length;
/** Whether a string survives a UTF-8 round trip, i.e. holds no lone surrogate PostgreSQL would refuse. */
const wellFormed = (value: string) =>
  Buffer.from(value, "utf8").toString("utf8") === value;

/** Refuses unless the caller frame is the actor's own workspace. */
function assertFrame(actorId: string): void {
  if (!isPersonTenant(actorId)) throw new KnowledgeScopeError();
  if (actorId !== tenantFrame()) throw new KnowledgeScopeError();
}

/**
 * Run `work` in the actor's own frame, for callers that hold a run's actor rather than a request.
 *
 * Entering the frame is only allowed from no frame at all or from the same one: a run already
 * scoped to another workspace is refused rather than silently re-scoped.
 */
export function inActorTenant<T>(
  actorId: string,
  work: () => Promise<T>,
): Promise<T> {
  // `tenantFrame()`, not `currentTenant()`: "no frame yet" is the case this exists for, and asking
  // `currentTenant()` there throws.
  const frame = tenantFrame();
  if (!isPersonTenant(actorId))
    return Promise.reject(new KnowledgeScopeError());
  if (frame !== undefined && frame !== "" && frame !== actorId)
    return Promise.reject(new KnowledgeScopeError());
  return runAsTenant(actorId, work);
}

function title(value: unknown, what = "知识库"): string {
  if (typeof value !== "string")
    throw new KnowledgeRefusedError(`请填写${what}名称。`);
  const trimmed = value.trim();
  if (trimmed.includes("\u0000") || !wellFormed(trimmed))
    throw new KnowledgeRefusedError(`${what}名称包含无效字符。`);
  if (chars(trimmed) < 1 || chars(trimmed) > TITLE_MAX_CHARS)
    throw new KnowledgeRefusedError(`${what}名称需为 1 到 120 个字符。`);
  return trimmed;
}

function revisionOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new KnowledgeRefusedError("请提供当前版本号。");
  return value;
}

function kindOf(value: unknown): KnowledgeSourceKind {
  if (value === undefined || value === "text") return "text";
  if (value === "markdown") return "markdown";
  throw new KnowledgeRefusedError("目前只支持纯文本或 Markdown 资料。");
}

function contentOf(value: unknown): { content: string; digest: string } {
  if (typeof value !== "string" || value.trim() === "")
    throw new KnowledgeRefusedError("资料内容不能为空。");
  if (chars(value) > KNOWLEDGE_SOURCE_MAX_CHARS)
    throw new KnowledgeTooLargeError();
  // PostgreSQL text holds neither NUL nor a lone surrogate; either would fail the insert as a 503.
  if (value.includes("\u0000") || !wellFormed(value))
    throw new KnowledgeRefusedError("资料内容包含无效字符。");
  return {
    content: value,
    digest: createHash("sha256").update(value, "utf8").digest("hex"),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new KnowledgeRefusedError("请求内容格式不正确。");
  return value as Record<string, unknown>;
}

const notebookColumns = {
  id: knowledgeNotebooks.id,
  title: knowledgeNotebooks.title,
  revision: knowledgeNotebooks.revision,
  createdAt: knowledgeNotebooks.createdAt,
  updatedAt: knowledgeNotebooks.updatedAt,
};
const sourceSummaryColumns = {
  id: knowledgeSources.id,
  notebookId: knowledgeSources.notebookId,
  title: knowledgeSources.title,
  kind: knowledgeSources.kind,
  digest: knowledgeSources.digest,
  chars: sql<number>`char_length(${knowledgeSources.content})`.mapWith(Number),
  revision: knowledgeSources.revision,
  updatedAt: knowledgeSources.updatedAt,
};

/** Moves a slice boundary off the second half of a surrogate pair, so an excerpt never splits one. */
function boundary(content: string, at: number): number {
  const code = content.charCodeAt(at);
  return code >= 0xdc00 && code <= 0xdfff ? at - 1 : at;
}

/**
 * A short window around each hit, so a search hands the model a passage rather than a document.
 *
 * Matched on the original text with a case-insensitive pattern rather than on `toLowerCase()` copies:
 * lowering can change a string's length (`İ` becomes two code units), and offsets found in the copy
 * would then cut the wrong window out of the original.
 */
function excerptsOf(content: string, query: string, limit: number): string[] {
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu",
  );
  const found: string[] = [];
  while (found.length < limit) {
    const match = pattern.exec(content);
    if (!match) break;
    const at = match.index;
    const start = Math.max(0, boundary(content, at - 160));
    const end = Math.min(
      content.length,
      boundary(content, at + match[0].length + 160),
    );
    found.push(
      `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`,
    );
  }
  return found;
}

export function createKnowledgeStore(database: Database) {
  const audit = (
    actorId: string,
    eventType: AuditEventInput["eventType"],
    targetType: string,
    targetId: string,
    payload: Record<string, unknown>,
  ): AuditEventInput => ({
    eventType,
    targetType,
    targetId,
    actorUserId: actorId,
    payload,
  });

  /** A live (not soft-deleted) notebook of the actor's, or 404. Cross-tenant ids are simply absent. */
  const liveNotebook = async (actorId: string, notebookId: string) => {
    if (!UUID.test(notebookId)) throw new KnowledgeNotFoundError();
    const [row] = await database
      .select(notebookColumns)
      .from(knowledgeNotebooks)
      .where(
        and(
          eq(knowledgeNotebooks.id, notebookId),
          eq(knowledgeNotebooks.tenantId, actorId),
          eq(knowledgeNotebooks.ownerUserId, actorId),
          isNull(knowledgeNotebooks.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new KnowledgeNotFoundError();
    return row;
  };

  const sourceOf = async (
    actorId: string,
    notebookId: string,
    sourceId: string,
  ): Promise<KnowledgeSource> => {
    await liveNotebook(actorId, notebookId);
    if (!UUID.test(sourceId))
      throw new KnowledgeNotFoundError("找不到这份资料。");
    const [row] = await database
      .select({ ...sourceSummaryColumns, content: knowledgeSources.content })
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.id, sourceId),
          eq(knowledgeSources.notebookId, notebookId),
          eq(knowledgeSources.tenantId, actorId),
          eq(knowledgeSources.ownerUserId, actorId),
        ),
      )
      .limit(1);
    if (!row) throw new KnowledgeNotFoundError("找不到这份资料。");
    return row;
  };

  /**
   * Whether `agentId` is one of the actor's own, live Wakers: a private one in the actor's own
   * workspace, or one they published to the team (G01-E stamps that Bot `team`, its profile keeps
   * them as `owner_user_id`). The binding itself always stays in the owner's own tenant, which is
   * what the `knowledge_binding_team_bot_*` policies of 0122 admit; a teammate running the published
   * Waker holds no binding of their own, so nothing of the owner's is offered to their run.
   */
  const ownsWaker = async (actorId: string, agentId: string) => {
    if (typeof agentId !== "string" || !agentId || agentId.length > 200)
      return false;
    const [row] = await database
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
      .where(
        and(
          eq(agents.id, agentId),
          or(
            and(
              eq(agents.tenantId, actorId),
              eq(agentProfiles.tenantId, actorId),
            ),
            and(
              eq(agents.tenantId, TEAM_TENANT),
              eq(agentProfiles.tenantId, TEAM_TENANT),
            ),
          ),
          eq(agentProfiles.ownerUserId, actorId),
          isNull(agentProfiles.deletedAt),
        ),
      )
      .limit(1);
    return Boolean(row);
  };

  const bindingsFor = (actorId: string, agentId: string) =>
    database
      .select({
        notebookId: knowledgeNotebooks.id,
        title: knowledgeNotebooks.title,
        accessMode: knowledgeBindings.accessMode,
      })
      .from(knowledgeBindings)
      .innerJoin(
        knowledgeNotebooks,
        and(
          eq(knowledgeNotebooks.id, knowledgeBindings.notebookId),
          eq(knowledgeNotebooks.tenantId, knowledgeBindings.tenantId),
          eq(knowledgeNotebooks.ownerUserId, knowledgeBindings.ownerUserId),
          isNull(knowledgeNotebooks.deletedAt),
        ),
      )
      .where(
        and(
          eq(knowledgeBindings.tenantId, actorId),
          eq(knowledgeBindings.ownerUserId, actorId),
          eq(knowledgeBindings.agentId, agentId),
        ),
      )
      .orderBy(asc(knowledgeNotebooks.title));

  return {
    async listNotebooks(actorId: string): Promise<KnowledgeNotebook[]> {
      assertFrame(actorId);
      return database
        .select(notebookColumns)
        .from(knowledgeNotebooks)
        .where(
          and(
            eq(knowledgeNotebooks.tenantId, actorId),
            eq(knowledgeNotebooks.ownerUserId, actorId),
            isNull(knowledgeNotebooks.deletedAt),
          ),
        )
        .orderBy(desc(knowledgeNotebooks.updatedAt))
        .limit(500);
    },

    async createNotebook(
      actorId: string,
      input: unknown,
    ): Promise<KnowledgeNotebook> {
      assertFrame(actorId);
      const name = title(record(input).title);
      const id = randomUUID();
      return commitOwnerAssembly(
        database,
        audit(actorId, "knowledge.notebook_created", "knowledge_notebook", id, {
          notebookId: id,
          title: name,
          revision: 1,
        }),
        async (tx) => {
          const [row] = await tx
            .insert(knowledgeNotebooks)
            .values({
              id,
              tenantId: actorId,
              ownerUserId: actorId,
              title: name,
            })
            .returning(notebookColumns);
          if (!row) throw new Error("Notebook insert returned no row.");
          return { value: row, changed: true };
        },
      );
    },

    async getNotebook(actorId: string, notebookId: string) {
      assertFrame(actorId);
      const notebook = await liveNotebook(actorId, notebookId);
      const sources: KnowledgeSourceSummary[] = await database
        .select(sourceSummaryColumns)
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.notebookId, notebookId),
            eq(knowledgeSources.tenantId, actorId),
            eq(knowledgeSources.ownerUserId, actorId),
          ),
        )
        .orderBy(asc(knowledgeSources.title));
      const bindings: KnowledgeBinding[] = await database
        .select({
          agentId: knowledgeBindings.agentId,
          notebookId: knowledgeBindings.notebookId,
          accessMode: knowledgeBindings.accessMode,
          updatedAt: knowledgeBindings.updatedAt,
        })
        .from(knowledgeBindings)
        .where(
          and(
            eq(knowledgeBindings.notebookId, notebookId),
            eq(knowledgeBindings.tenantId, actorId),
            eq(knowledgeBindings.ownerUserId, actorId),
          ),
        )
        .orderBy(asc(knowledgeBindings.agentId));
      return { notebook, sources, bindings };
    },

    /** Rename with optimistic concurrency: a stale `revision` is a 409, never a silent overwrite. */
    async updateNotebook(
      actorId: string,
      notebookId: string,
      input: unknown,
    ): Promise<KnowledgeNotebook> {
      assertFrame(actorId);
      const body = record(input);
      const name = title(body.title);
      const expected = revisionOf(body.revision);
      await liveNotebook(actorId, notebookId);
      return commitOwnerAssembly(
        database,
        audit(
          actorId,
          "knowledge.notebook_updated",
          "knowledge_notebook",
          notebookId,
          { notebookId, title: name, revision: expected + 1 },
        ),
        async (tx) => {
          const [row] = await tx
            .update(knowledgeNotebooks)
            .set({
              title: name,
              revision: sql`${knowledgeNotebooks.revision} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(knowledgeNotebooks.id, notebookId),
                eq(knowledgeNotebooks.tenantId, actorId),
                eq(knowledgeNotebooks.ownerUserId, actorId),
                eq(knowledgeNotebooks.revision, expected),
                isNull(knowledgeNotebooks.deletedAt),
              ),
            )
            .returning(notebookColumns);
          if (!row) throw new KnowledgeConflictError();
          return { value: row, changed: true };
        },
      );
    },

    /**
     * Soft delete. The notebook row stays (sources keep their history), but every binding goes in the
     * same transaction: a deleted notebook must stop being readable by any Waker at once, not when
     * somebody remembers to revoke it.
     */
    async deleteNotebook(
      actorId: string,
      notebookId: string,
      input: unknown = {},
    ): Promise<{ deleted: true; bindingsRemoved: number }> {
      assertFrame(actorId);
      const body: Record<string, unknown> =
        input === undefined || input === null ? {} : record(input);
      const expected =
        body.revision === undefined ? undefined : revisionOf(body.revision);
      const current = await liveNotebook(actorId, notebookId);
      const revision = expected ?? current.revision;
      const removedAgents = await database
        .select({ agentId: knowledgeBindings.agentId })
        .from(knowledgeBindings)
        .where(
          and(
            eq(knowledgeBindings.notebookId, notebookId),
            eq(knowledgeBindings.tenantId, actorId),
            eq(knowledgeBindings.ownerUserId, actorId),
          ),
        );
      return commitOwnerAssembly(
        database,
        audit(
          actorId,
          "knowledge.notebook_deleted",
          "knowledge_notebook",
          notebookId,
          {
            notebookId,
            revision: revision + 1,
            bindingsRemoved: removedAgents.map((row) => row.agentId),
          },
        ),
        async (tx) => {
          const [row] = await tx
            .update(knowledgeNotebooks)
            .set({
              deletedAt: new Date(),
              updatedAt: new Date(),
              revision: sql`${knowledgeNotebooks.revision} + 1`,
            })
            .where(
              and(
                eq(knowledgeNotebooks.id, notebookId),
                eq(knowledgeNotebooks.tenantId, actorId),
                eq(knowledgeNotebooks.ownerUserId, actorId),
                eq(knowledgeNotebooks.revision, revision),
                isNull(knowledgeNotebooks.deletedAt),
              ),
            )
            .returning({ id: knowledgeNotebooks.id });
          if (!row) throw new KnowledgeConflictError();
          const dropped = await tx
            .delete(knowledgeBindings)
            .where(
              and(
                eq(knowledgeBindings.notebookId, notebookId),
                eq(knowledgeBindings.tenantId, actorId),
                eq(knowledgeBindings.ownerUserId, actorId),
              ),
            )
            .returning({ agentId: knowledgeBindings.agentId });
          return {
            value: { deleted: true as const, bindingsRemoved: dropped.length },
            changed: true,
          };
        },
      );
    },

    async addSource(
      actorId: string,
      notebookId: string,
      input: unknown,
    ): Promise<KnowledgeSource> {
      assertFrame(actorId);
      const body = record(input);
      const name = title(body.title, "资料");
      const kind = kindOf(body.kind);
      const { content, digest } = contentOf(body.content);
      await liveNotebook(actorId, notebookId);
      const id = randomUUID();
      return commitOwnerAssembly(
        database,
        audit(actorId, "knowledge.source_added", "knowledge_source", id, {
          notebookId,
          sourceId: id,
          title: name,
          kind,
          digest,
          chars: chars(content),
        }),
        async (tx) => {
          const [row] = await tx
            .insert(knowledgeSources)
            .values({
              id,
              tenantId: actorId,
              ownerUserId: actorId,
              notebookId,
              title: name,
              kind,
              rawContent: content,
              content,
              digest,
              status: "ready",
            })
            .returning({
              ...sourceSummaryColumns,
              content: knowledgeSources.content,
            });
          if (!row) throw new Error("Source insert returned no row.");
          await tx
            .update(knowledgeNotebooks)
            .set({ updatedAt: new Date() })
            .where(eq(knowledgeNotebooks.id, notebookId));
          return { value: row, changed: true };
        },
      );
    },

    async getSource(
      actorId: string,
      notebookId: string,
      sourceId: string,
    ): Promise<KnowledgeSource> {
      assertFrame(actorId);
      return sourceOf(actorId, notebookId, sourceId);
    },

    /** Edit a source's title and/or text against its own revision. */
    async updateSource(
      actorId: string,
      notebookId: string,
      sourceId: string,
      input: unknown,
    ): Promise<KnowledgeSource> {
      assertFrame(actorId);
      const body = record(input);
      const expected = revisionOf(body.revision);
      const name =
        body.title === undefined ? undefined : title(body.title, "资料");
      const next =
        body.content === undefined ? undefined : contentOf(body.content);
      if (name === undefined && next === undefined)
        throw new KnowledgeRefusedError("请提供要修改的名称或内容。");
      const current = await sourceOf(actorId, notebookId, sourceId);
      return commitOwnerAssembly(
        database,
        audit(
          actorId,
          "knowledge.source_updated",
          "knowledge_source",
          sourceId,
          {
            notebookId,
            sourceId,
            revision: expected + 1,
            ...(name === undefined ? {} : { title: name }),
            digest: next?.digest ?? current.digest,
            chars: next ? chars(next.content) : current.chars,
          },
        ),
        async (tx) => {
          const [row] = await tx
            .update(knowledgeSources)
            .set({
              ...(name === undefined ? {} : { title: name }),
              ...(next === undefined
                ? {}
                : {
                    rawContent: next.content,
                    content: next.content,
                    digest: next.digest,
                  }),
              revision: sql`${knowledgeSources.revision} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(knowledgeSources.id, sourceId),
                eq(knowledgeSources.notebookId, notebookId),
                eq(knowledgeSources.tenantId, actorId),
                eq(knowledgeSources.ownerUserId, actorId),
                eq(knowledgeSources.revision, expected),
              ),
            )
            .returning({
              ...sourceSummaryColumns,
              content: knowledgeSources.content,
            });
          if (!row) throw new KnowledgeConflictError();
          await tx
            .update(knowledgeNotebooks)
            .set({ updatedAt: new Date() })
            .where(eq(knowledgeNotebooks.id, notebookId));
          return { value: row, changed: true };
        },
      );
    },

    async removeSource(
      actorId: string,
      notebookId: string,
      sourceId: string,
    ): Promise<void> {
      assertFrame(actorId);
      const current = await sourceOf(actorId, notebookId, sourceId);
      await commitOwnerAssembly(
        database,
        audit(
          actorId,
          "knowledge.source_removed",
          "knowledge_source",
          sourceId,
          {
            notebookId,
            sourceId,
            digest: current.digest,
          },
        ),
        async (tx) => {
          const removed = await tx
            .delete(knowledgeSources)
            .where(
              and(
                eq(knowledgeSources.id, sourceId),
                eq(knowledgeSources.notebookId, notebookId),
                eq(knowledgeSources.tenantId, actorId),
                eq(knowledgeSources.ownerUserId, actorId),
              ),
            )
            .returning({ id: knowledgeSources.id });
          if (removed.length === 0)
            throw new KnowledgeNotFoundError("找不到这份资料。");
          return { value: undefined, changed: true };
        },
      );
    },

    /**
     * Let one of the owner's own Wakers read this notebook. Only `read_only` exists: a Waker writing
     * into a notebook goes through the write-claim ledger, which is not wired yet.
     */
    async bind(
      actorId: string,
      notebookId: string,
      agentId: string,
      input: unknown = {},
    ): Promise<KnowledgeBinding> {
      assertFrame(actorId);
      const body: Record<string, unknown> =
        input === undefined || input === null ? {} : record(input);
      const mode = body.accessMode ?? "read_only";
      if (mode !== "read_only")
        throw new KnowledgeRefusedError("目前只能授予只读权限。");
      const accessMode: KnowledgeAccessMode = "read_only";
      await liveNotebook(actorId, notebookId);
      if (!(await ownsWaker(actorId, agentId)))
        throw new KnowledgeForbiddenError();
      return commitOwnerAssembly(
        database,
        audit(
          actorId,
          "knowledge.binding_granted",
          "knowledge_binding",
          notebookId,
          {
            notebookId,
            agentId,
            accessMode,
          },
        ),
        async (tx) => {
          const [row] = await tx
            .insert(knowledgeBindings)
            .values({
              tenantId: actorId,
              ownerUserId: actorId,
              agentId,
              notebookId,
              accessMode,
            })
            .onConflictDoUpdate({
              target: [
                knowledgeBindings.tenantId,
                knowledgeBindings.ownerUserId,
                knowledgeBindings.agentId,
                knowledgeBindings.notebookId,
              ],
              set: { accessMode, updatedAt: new Date() },
            })
            .returning({
              agentId: knowledgeBindings.agentId,
              notebookId: knowledgeBindings.notebookId,
              accessMode: knowledgeBindings.accessMode,
              updatedAt: knowledgeBindings.updatedAt,
            });
          if (!row) throw new Error("Binding insert returned no row.");
          return { value: row, changed: true };
        },
      );
    },

    async unbind(
      actorId: string,
      notebookId: string,
      agentId: string,
    ): Promise<{ removed: boolean }> {
      assertFrame(actorId);
      await liveNotebook(actorId, notebookId);
      return commitOwnerAssembly(
        database,
        audit(
          actorId,
          "knowledge.binding_revoked",
          "knowledge_binding",
          notebookId,
          {
            notebookId,
            agentId,
          },
        ),
        async (tx) => {
          const removed = await tx
            .delete(knowledgeBindings)
            .where(
              and(
                eq(knowledgeBindings.notebookId, notebookId),
                eq(knowledgeBindings.agentId, agentId),
                eq(knowledgeBindings.tenantId, actorId),
                eq(knowledgeBindings.ownerUserId, actorId),
              ),
            )
            .returning({ agentId: knowledgeBindings.agentId });
          // Nothing removed is not an event: there is no audit row for a revoke that revoked nothing.
          return {
            value: { removed: removed.length > 0 },
            changed: removed.length > 0,
          };
        },
      );
    },

    /** The notebooks one of the owner's Wakers may read. A Waker that is not theirs is a 403. */
    async notebooksForAgent(actorId: string, agentId: string) {
      assertFrame(actorId);
      if (!(await ownsWaker(actorId, agentId)))
        throw new KnowledgeForbiddenError("找不到你的这个 Waker。");
      // Awaited here, not returned: on Bun 1.3.14 a query builder returned from an async function
      // after an earlier await runs outside the caller's tenant frame, so RLS shows it nothing.
      return await bindingsFor(actorId, agentId);
    },

    /**
     * What a run may read: the live notebooks bound to `agentId`, with their sources' titles. Empty
     * (never an error) when the Waker is not the actor's own or nothing is bound, so a run is simply
     * not offered the tools.
     */
    async boundForRun(actorId: string, agentId: string) {
      assertFrame(actorId);
      if (!(await ownsWaker(actorId, agentId))) return [];
      const notebooks = await bindingsFor(actorId, agentId);
      if (notebooks.length === 0) return [];
      const sources = await database
        .select({
          id: knowledgeSources.id,
          notebookId: knowledgeSources.notebookId,
          title: knowledgeSources.title,
          kind: knowledgeSources.kind,
        })
        .from(knowledgeSources)
        .innerJoin(
          knowledgeBindings,
          and(
            eq(knowledgeBindings.notebookId, knowledgeSources.notebookId),
            eq(knowledgeBindings.tenantId, knowledgeSources.tenantId),
            eq(knowledgeBindings.ownerUserId, knowledgeSources.ownerUserId),
            eq(knowledgeBindings.agentId, agentId),
          ),
        )
        .where(
          and(
            eq(knowledgeSources.tenantId, actorId),
            eq(knowledgeSources.ownerUserId, actorId),
            eq(knowledgeSources.status, "ready"),
          ),
        )
        .orderBy(asc(knowledgeSources.title))
        .limit(500);
      return notebooks.map((notebook) => ({
        id: notebook.notebookId,
        title: notebook.title,
        accessMode: notebook.accessMode,
        sources: sources
          .filter((source) => source.notebookId === notebook.notebookId)
          .map(({ id, title, kind }) => ({ id, title, kind })),
      }));
    },

    /** Case-insensitive search over the ready sources of notebooks bound to `agentId`. */
    async searchForRun(
      actorId: string,
      agentId: string,
      query: string,
      notebookId?: string,
    ): Promise<KnowledgeExcerpt[]> {
      assertFrame(actorId);
      const needle = query.trim();
      if (!needle) return [];
      if (notebookId !== undefined && !UUID.test(notebookId)) return [];
      if (!(await ownsWaker(actorId, agentId))) return [];
      const rows = await database
        .select({
          notebookId: knowledgeNotebooks.id,
          notebookTitle: knowledgeNotebooks.title,
          sourceId: knowledgeSources.id,
          sourceTitle: knowledgeSources.title,
          content: knowledgeSources.content,
        })
        .from(knowledgeSources)
        .innerJoin(
          knowledgeBindings,
          and(
            eq(knowledgeBindings.notebookId, knowledgeSources.notebookId),
            eq(knowledgeBindings.tenantId, knowledgeSources.tenantId),
            eq(knowledgeBindings.ownerUserId, knowledgeSources.ownerUserId),
            eq(knowledgeBindings.agentId, agentId),
          ),
        )
        .innerJoin(
          knowledgeNotebooks,
          and(
            eq(knowledgeNotebooks.id, knowledgeSources.notebookId),
            isNull(knowledgeNotebooks.deletedAt),
          ),
        )
        .where(
          and(
            eq(knowledgeSources.tenantId, actorId),
            eq(knowledgeSources.ownerUserId, actorId),
            eq(knowledgeSources.status, "ready"),
            sql`strpos(lower(${knowledgeSources.content}), lower(${needle}::text)) > 0`,
            ...(notebookId === undefined
              ? []
              : [eq(knowledgeSources.notebookId, notebookId)]),
          ),
        )
        .orderBy(asc(knowledgeSources.title))
        .limit(20);
      const results: KnowledgeExcerpt[] = [];
      for (const row of rows) {
        for (const excerpt of excerptsOf(row.content, needle, 3)) {
          if (results.length >= 10) return results;
          results.push({
            notebookId: row.notebookId,
            notebookTitle: row.notebookTitle,
            sourceId: row.sourceId,
            sourceTitle: row.sourceTitle,
            excerpt,
          });
        }
      }
      return results;
    },
  };
}

export type KnowledgeStore = ReturnType<typeof createKnowledgeStore>;
