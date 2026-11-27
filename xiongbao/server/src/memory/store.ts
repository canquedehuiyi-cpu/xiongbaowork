import { createHash, randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import { memorySources, personalMemories } from "../db/schema/memory";
import { lockDefaults, recordOptOut, sourceServerId } from "./defaults";
import {
  type FormedMemoryInput,
  formedMemorySchema,
  type ImportedMemory,
  MemoryNotFoundError,
  type MemoryRecord,
  MemoryRefusedError,
  parseMemoryInput,
  parseMemoryPatch,
  parseMemorySourceInput,
} from "./types";

/**
 * A person's memory, in XiongBao's own tables: the rows are the whole store. Each row carries where a
 * memory came from, whether it is reviewed or paused, which Bot formed it and which source it was
 * imported from, and those decide which Bot may see it.
 */
/** 一个连接，或一个事务：删除路径两处都用。 */
type Executor = Pick<Database, "update" | "select">;

/**
 * 删除一条记忆：留墓碑（清空内容、停用），导入的不会在下次同步时复活；别的行里指向它的 `replacesId` 一并清空。
 * 本人「忘掉」和确认纠正后旧条退役走的都是这一条路。没有这条（或不是本人的）返回 false。
 */
async function retire(
  executor: Executor,
  ownerUserId: string,
  id: string,
): Promise<boolean> {
  const [row] = await executor
    .update(personalMemories)
    .set({
      deletedAt: new Date(),
      enabled: false,
      content: "",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(personalMemories.id, id),
        eq(personalMemories.ownerUserId, ownerUserId),
        isNull(personalMemories.deletedAt),
      ),
    )
    .returning({ id: personalMemories.id });
  if (!row) return false;
  await executor
    .update(personalMemories)
    .set({ replacesId: null })
    .where(
      and(
        eq(personalMemories.ownerUserId, ownerUserId),
        eq(personalMemories.replacesId, id),
      ),
    );
  return true;
}

/** 新条的来源一栏最多多少字（与表单校验一致）。 */
const PROVENANCE_MAX_CHARS = 500;

/**
 * 确认纠正后，被取代的旧条内容写进新条的来源一栏（这个表没有单独的变更记录）：原来源之后接一句「取代了：…」，
 * 合计不超过 {@link PROVENANCE_MAX_CHARS} 字，旧条太长的截短。
 */
export function provenanceWithReplaced(
  provenance: string,
  oldContent: string,
): string {
  const head = `${provenance}；取代了：「`;
  const room = Math.max(0, PROVENANCE_MAX_CHARS - head.length - 1);
  const old = [...oldContent.replace(/\s+/g, " ").trim()];
  const quoted =
    old.length > room
      ? `${old.slice(0, Math.max(0, room - 1)).join("")}…`
      : old.join("");
  return `${head}${quoted}」`.slice(0, PROVENANCE_MAX_CHARS);
}

export function createMemoryStore(database: Database) {
  const getSource = async (ownerUserId: string, id: string) => {
    const [row] = await database
      .select()
      .from(memorySources)
      .where(
        and(
          eq(memorySources.id, id),
          eq(memorySources.ownerUserId, ownerUserId),
        ),
      );
    if (!row) throw new MemoryNotFoundError();
    return row;
  };

  /**
   * The rows a Bot may recall, every filter in the query. Bot-formed memories go only to the Bot that
   * formed them, and only while it still holds their source app; imported ones only through a source
   * this Bot may use; the person's own to every Bot of theirs.
   */
  function eligibleRows(
    ownerUserId: string,
    eligibleSourceIds: string[],
    formed: { botId: string; heldServerIds: ReadonlySet<string> } | undefined,
    narrow: { term?: string },
    limit = 40,
  ) {
    const held = [...(formed?.heldServerIds ?? [])];
    const formedByThisBot = formed
      ? and(
          eq(personalMemories.formedBy, "bot"),
          eq(personalMemories.formedByAgentId, formed.botId),
          or(
            isNull(personalMemories.sourceRef),
            held.length > 0
              ? inArray(
                  sql<string>`split_part(${personalMemories.sourceRef}, '/', 1)`,
                  held,
                )
              : sql`false`,
          ),
        )
      : undefined;
    const personOrSource = and(
      sql`${personalMemories.formedBy} <> 'bot'`,
      or(
        isNull(personalMemories.sourceId),
        eligibleSourceIds.length > 0
          ? inArray(personalMemories.sourceId, eligibleSourceIds)
          : sql`false`,
      ),
    );
    return database
      .select()
      .from(personalMemories)
      .where(
        and(
          eq(personalMemories.ownerUserId, ownerUserId),
          eq(personalMemories.enabled, true),
          isNull(personalMemories.deletedAt),
          formedByThisBot
            ? or(formedByThisBot, personOrSource)
            : personOrSource,
          narrow.term
            ? sql`strpos(lower(${personalMemories.content}), lower(${narrow.term})) > 0`
            : undefined,
        ),
      )
      .orderBy(desc(personalMemories.updatedAt))
      .limit(limit);
  }

  return {
    async list(ownerUserId: string): Promise<MemoryRecord[]> {
      return database
        .select()
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, ownerUserId),
            isNull(personalMemories.deletedAt),
          ),
        )
        .orderBy(desc(personalMemories.updatedAt))
        .limit(500);
    },
    async create(ownerUserId: string, input: unknown) {
      const [row] = await database
        .insert(personalMemories)
        .values({
          id: randomUUID(),
          ownerUserId,
          ...parseMemoryInput(input),
          reviewState: "confirmed",
        })
        .returning();
      if (!row) throw new Error("Memory insert returned no row.");
      return row;
    },
    /**
     * A memory a Bot formed from something it observed, awaiting the person's review.
     *
     * Deduplicated on content per Bot, since each Bot is given only the memories it formed itself:
     * a second Bot forming the same fact keeps its own row. Forgetting is the person's, so a fact
     * they forgot from any Bot stays forgotten, even when a Bot reads the same record again
     * tomorrow.
     */
    async formMemory(ownerUserId: string, input: FormedMemoryInput) {
      const parsed = formedMemorySchema.safeParse({
        content: input.content,
        sourceApp: input.sourceApp,
        ...(input.sourceLink ? { sourceLink: input.sourceLink } : {}),
        ...(input.observedAt ? { observedAt: input.observedAt } : {}),
      });
      if (!parsed.success)
        throw new MemoryRefusedError(
          parsed.error.issues[0]?.message ?? "Invalid memory.",
        );
      const digest = createHash("sha256")
        .update(parsed.data.content.toLocaleLowerCase())
        .digest("hex");
      const [existing] = await database
        .select({
          id: personalMemories.id,
          deletedAt: personalMemories.deletedAt,
        })
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, ownerUserId),
            eq(personalMemories.formedBy, "bot"),
            eq(personalMemories.importDigest, digest),
            or(
              eq(personalMemories.formedByAgentId, input.agentId),
              isNotNull(personalMemories.deletedAt),
            ),
          ),
        )
        // A forgotten row first, so another Bot's tombstone wins over this Bot's live row.
        .orderBy(sql`${personalMemories.deletedAt} IS NULL`)
        .limit(1);
      if (existing)
        return {
          id: existing.id,
          duplicate: true,
          forgotten: !!existing.deletedAt,
        };
      const observedAt = parsed.data.observedAt ?? new Date();
      const [row] = await database
        .insert(personalMemories)
        .values({
          id: randomUUID(),
          ownerUserId,
          content: parsed.data.content,
          provenance:
            `${parsed.data.sourceApp}${parsed.data.sourceLink ? ` (${parsed.data.sourceLink})` : ""}, observed ${observedAt.toISOString()}`.slice(
              0,
              500,
            ),
          reviewState: "unreviewed",
          formedBy: "bot",
          formedByAgentId: input.agentId,
          sourceApp: parsed.data.sourceApp,
          sourceRef: input.sourceRef ?? null,
          sourceLink: parsed.data.sourceLink ?? null,
          observedAt,
          importDigest: digest,
          fromCorrection: input.fromCorrection ?? false,
          correctionCount: Math.max(0, Math.trunc(input.correctionCount ?? 0)),
          replacesId: input.replacesId ?? null,
        })
        .onConflictDoNothing({
          target: [
            personalMemories.ownerUserId,
            personalMemories.formedByAgentId,
            personalMemories.importDigest,
          ],
          where: sql`${personalMemories.formedBy} = 'bot'`,
        })
        .returning({ id: personalMemories.id });
      if (row) return { id: row.id, duplicate: false, forgotten: false };
      // Formed by a concurrent run between the check above and this insert.
      const [raced] = await database
        .select({
          id: personalMemories.id,
          deletedAt: personalMemories.deletedAt,
        })
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, ownerUserId),
            eq(personalMemories.formedBy, "bot"),
            eq(personalMemories.formedByAgentId, input.agentId),
            eq(personalMemories.importDigest, digest),
          ),
        )
        .limit(1);
      if (!raced) throw new Error("Memory insert returned no row.");
      return { id: raced.id, duplicate: true, forgotten: !!raced.deletedAt };
    },
    /** 本人又一次就这件事纠正了员工：次数加一，更新时间。只改本人的。 */
    async bumpCorrection(ownerUserId: string, id: string): Promise<void> {
      await database
        .update(personalMemories)
        .set({
          correctionCount: sql`${personalMemories.correctionCount} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(personalMemories.id, id),
            eq(personalMemories.ownerUserId, ownerUserId),
            isNull(personalMemories.deletedAt),
          ),
        );
    },
    async update(
      ownerUserId: string,
      id: string,
      input: unknown,
    ): Promise<MemoryRecord> {
      const patch = parseMemoryPatch(input);
      return database.transaction(async (transaction) => {
        const [row] = await transaction
          .update(personalMemories)
          .set({
            ...patch,
            ...(patch.content ? { reviewState: "edited" as const } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(personalMemories.id, id),
              eq(personalMemories.ownerUserId, ownerUserId),
              isNull(personalMemories.deletedAt),
            ),
          )
          .returning();
        if (!row) throw new MemoryNotFoundError();
        /*
         * 本人确认（或改过即确认）了一条要取代旧条的纠正：旧条这才退役，走和「忘掉」同一条删除路径；退役前把旧条
         * 内容记进新条的来源一栏。确认之前旧条一直不动。旧条已经不在了，只清掉指向它的引用。
         */
        if (!row.replacesId || row.reviewState === "unreviewed") return row;
        const [old] = await transaction
          .select({ content: personalMemories.content })
          .from(personalMemories)
          .where(
            and(
              eq(personalMemories.id, row.replacesId),
              eq(personalMemories.ownerUserId, ownerUserId),
              isNull(personalMemories.deletedAt),
            ),
          );
        if (old) await retire(transaction, ownerUserId, row.replacesId);
        const [settled] = await transaction
          .update(personalMemories)
          .set({
            replacesId: null,
            ...(old
              ? {
                  provenance: provenanceWithReplaced(
                    row.provenance,
                    old.content,
                  ),
                }
              : {}),
          })
          .where(eq(personalMemories.id, row.id))
          .returning();
        if (!settled) throw new MemoryNotFoundError();
        return settled;
      });
    },
    async remove(ownerUserId: string, id: string) {
      // Imported tombstones prevent the next sync from resurrecting a fact the person deleted.
      if (!(await retire(database, ownerUserId, id)))
        throw new MemoryNotFoundError();
    },
    async sources(ownerUserId: string) {
      return database
        .select()
        .from(memorySources)
        .where(eq(memorySources.ownerUserId, ownerUserId))
        .orderBy(desc(memorySources.createdAt));
    },
    getSource,
    async createSource(ownerUserId: string, input: unknown) {
      const [row] = await database
        .insert(memorySources)
        .values({
          id: randomUUID(),
          ownerUserId,
          ...parseMemorySourceInput(input),
        })
        .returning();
      if (!row) throw new Error("Memory source insert returned no row.");
      return row;
    },
    async setSourceEnabled(ownerUserId: string, id: string, enabled: boolean) {
      const [row] = await database
        .update(memorySources)
        .set({ enabled, nextSyncAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
          ),
        )
        .returning();
      if (!row) throw new MemoryNotFoundError();
      return row;
    },
    async removeSource(ownerUserId: string, id: string) {
      const [source] = await database
        .select({ agentId: memorySources.agentId })
        .from(memorySources)
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
          ),
        )
        .limit(1);
      if (!source) throw new MemoryNotFoundError();
      // Removing a source is turning that app down for this Bot: XiongBao never adds it back.
      await database.transaction(async (transaction) => {
        await lockDefaults(transaction, ownerUserId, source.agentId);
        const [row] = await transaction
          .delete(memorySources)
          .where(
            and(
              eq(memorySources.id, id),
              eq(memorySources.ownerUserId, ownerUserId),
            ),
          )
          .returning({ toolRef: memorySources.toolRef });
        if (!row) throw new MemoryNotFoundError();
        await recordOptOut(transaction, {
          ownerUserId,
          agentId: source.agentId,
          feature: "memory_source",
          scope: sourceServerId(row.toolRef),
        });
      });
    },
    async dueSources(limit = 5) {
      return database
        .select()
        .from(memorySources)
        .where(
          and(
            eq(memorySources.enabled, true),
            lte(memorySources.nextSyncAt, new Date()),
          ),
        )
        .limit(Math.min(limit, 10));
    },
    async claimSync(ownerUserId: string, id: string) {
      const now = new Date();
      const [row] = await database
        .update(memorySources)
        .set({
          syncStatus: "running",
          nextSyncAt: new Date(now.getTime() + 120_000),
          updatedAt: now,
        })
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
            eq(memorySources.enabled, true),
            or(
              sql`${memorySources.syncStatus} <> 'running'`,
              lte(memorySources.nextSyncAt, now),
            ),
          ),
        )
        .returning();
      return row ?? null;
    },
    async failSync(ownerUserId: string, id: string, error: string) {
      await database
        .update(memorySources)
        .set({
          syncStatus: "error",
          syncError: error.slice(0, 500),
          nextSyncAt: new Date(Date.now() + 900_000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
          ),
        );
    },
    async completeSync(
      ownerUserId: string,
      sourceId: string,
      records: ImportedMemory[],
    ) {
      await database.transaction(async (transaction) => {
        const [source] = await transaction
          .select()
          .from(memorySources)
          .where(
            and(
              eq(memorySources.id, sourceId),
              eq(memorySources.ownerUserId, ownerUserId),
              eq(memorySources.enabled, true),
            ),
          )
          .for("update");
        if (!source) throw new MemoryNotFoundError();
        for (const record of records) {
          await transaction
            .insert(personalMemories)
            .values({
              id: randomUUID(),
              ownerUserId,
              sourceId,
              externalId: record.externalId,
              importDigest: record.digest,
              content: record.content,
              provenance: `${source.title}: ${record.provenance}`,
              formedBy: "import",
              sourceApp: source.title,
              sourceRef: source.toolRef,
              observedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [personalMemories.sourceId, personalMemories.externalId],
              set: {
                content: sql`CASE WHEN ${personalMemories.reviewState} = 'edited' OR ${personalMemories.deletedAt} IS NOT NULL THEN ${personalMemories.content} ELSE ${record.content} END`,
                provenance: `${source.title}: ${record.provenance}`,
                importDigest: record.digest,
                updatedAt: new Date(),
              },
              setWhere: sql`${personalMemories.importDigest} IS DISTINCT FROM ${record.digest}`,
            });
        }
        await transaction
          .update(memorySources)
          .set({
            syncStatus: "succeeded",
            syncError: null,
            lastSyncAt: new Date(),
            nextSyncAt: new Date(Date.now() + 900_000),
            updatedAt: new Date(),
          })
          .where(eq(memorySources.id, sourceId));
      });
    },
    async retrieve(
      ownerUserId: string,
      eligibleSourceIds: string[],
      search = "",
      /**
       * The Bot asking and the app servers it currently holds. Bot-formed memories are returned
       * only to the Bot that formed them, and only while it still holds their source app; without
       * this argument none are returned.
       */
      formed?: { botId: string; heldServerIds: ReadonlySet<string> },
      /** `limit`：最多取多少条，默认 40；放进上下文前要按相关程度挑的，候选取得多一些。 */
      options: { limit?: number } = {},
    ): Promise<MemoryRecord[]> {
      const term = search.trim();
      const limit = options.limit ?? 40;
      return eligibleRows(
        ownerUserId,
        eligibleSourceIds,
        formed,
        { term },
        limit,
      );
    },
  };
}
export type MemoryStore = ReturnType<typeof createMemoryStore>;
