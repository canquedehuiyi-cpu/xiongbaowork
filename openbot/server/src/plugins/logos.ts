import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { mcpServers } from "../db/schema";
import { runAsTenant } from "../tenant/context";
import type { ComposioBroker } from "./broker";
import { toolkitOf } from "./composio";

/**
 * Fill older app records without changing their connections, schemes, or grants.
 *
 * Boot-time maintenance across every tenant's app rows, so it runs as `platform` (G01). Unframed it
 * read as the legacy `system` scope, where row-level security shows only the catalogue's own rows:
 * an app a person had enabled in their own workspace was never found and kept its blank icon on
 * every restart. Only the logo column is written, and a `platform` update leaves each row's tenant
 * where it was.
 */
export async function backfillComposioLogos(
  database: Database,
  broker: Pick<ComposioBroker, "listApps">,
) {
  const missing = await runAsTenant("platform", () =>
    database
      .select({ id: mcpServers.id, url: mcpServers.url })
      .from(mcpServers)
      .where(
        and(eq(mcpServers.provenance, "composio"), isNull(mcpServers.logo)),
      ),
  );
  if (missing.length === 0) return;

  const logos = new Map(
    (await broker.listApps()).map((app) => [app.slug, app.logo]),
  );
  for (const row of missing) {
    const slug = toolkitOf(row.url);
    const logo = slug ? logos.get(slug) : null;
    if (!logo) continue;
    await runAsTenant("platform", () =>
      database
        .update(mcpServers)
        .set({ logo })
        .where(
          and(
            eq(mcpServers.id, row.id),
            eq(mcpServers.url, row.url),
            eq(mcpServers.provenance, "composio"),
            isNull(mcpServers.logo),
          ),
        ),
    );
  }
}
