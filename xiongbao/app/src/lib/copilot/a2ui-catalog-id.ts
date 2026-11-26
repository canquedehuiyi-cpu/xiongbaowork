/**
 * The generative-interface catalog's id, and the read-side translation of the id it had before
 * v0.2.16. Kept apart from a2ui.ts, which loads the agent SDK's generative-UI module: the stored
 * transcript reader (thread-messages.ts) needs only the ids, and must not pull that module (and its
 * optional peers) into everything that reads a transcript.
 */

/** The catalog's id, stamped by the runtime on every interface it draws (see `XIONGBAO_UI`). */
export const XIONGBAO_UI_ID = "xiongbao/ui@1";

/**
 * The catalog's id before v0.2.16. The runtime stamps the catalog's id on every interface it draws
 * (the activity's `catalogId` and its `createSurface`), and the browser refuses an operation that
 * names a catalog it does not have, so an interface drawn before the upgrade would no longer show.
 * The v0.2.16 migration rewrites stored interfaces (recovery 0241); this covers one a tab still on
 * the old page drew meanwhile. Read, never sent.
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
 */
const LEGACY_XIONGBAO_UI_ID = "openbot/ui@1";

/** The activity type the runtime draws a generative interface under (`GENERATIVE_UI_ACTIVITY_TYPE`). */
const SURFACE_ACTIVITY = "generative-ui-surface";

function namesOldCatalog(operation: unknown): boolean {
  if (typeof operation !== "object" || operation === null) return false;
  const create = (operation as { createSurface?: unknown }).createSurface;
  return (
    typeof create === "object" &&
    create !== null &&
    (create as { catalogId?: unknown }).catalogId === LEGACY_XIONGBAO_UI_ID
  );
}

/**
 * A stored turn with the catalog named by its current id: a surface activity's `catalogId` and its
 * `createSurface` operations, and nothing else. Any other turn, and a surface that names no old id,
 * is returned as it came (the same object). Read with the stored transcript, before the agent SDK
 * sees it (thread-messages.ts), because the SDK refuses the surface as soon as it is handed one.
 */
export function withCurrentCatalogId(turn: unknown): unknown {
  if (typeof turn !== "object" || turn === null) return turn;
  const record = turn as Record<string, unknown>;
  if (
    record.role !== "activity" ||
    record.activityType !== SURFACE_ACTIVITY ||
    typeof record.content !== "object" ||
    record.content === null
  )
    return turn;
  const content = record.content as Record<string, unknown>;
  const operations = Array.isArray(content.operations)
    ? content.operations
    : undefined;
  if (
    content.catalogId !== LEGACY_XIONGBAO_UI_ID &&
    !operations?.some(namesOldCatalog)
  )
    return turn;
  return {
    ...record,
    content: {
      ...content,
      ...(content.catalogId === LEGACY_XIONGBAO_UI_ID
        ? { catalogId: XIONGBAO_UI_ID }
        : {}),
      ...(operations
        ? {
            operations: operations.map((operation) =>
              namesOldCatalog(operation)
                ? {
                    ...(operation as Record<string, unknown>),
                    createSurface: {
                      ...((operation as { createSurface: object })
                        .createSurface as Record<string, unknown>),
                      catalogId: XIONGBAO_UI_ID,
                    },
                  }
                : operation,
            ),
          }
        : {}),
    },
  };
}
