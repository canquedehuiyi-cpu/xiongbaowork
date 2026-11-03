/**
 * Whose a Bot is (G01-E, plan §2.4).
 *
 * A private Bot carries its owner's tenant on its own `agents` row, so that stamp has always been the
 * answer. A team Bot is stamped `team`, which is nobody: no machine, no queue item, no trail and no
 * bill may be filed under it. For those the person is the profile's `owner_user_id`. Code that used
 * to read `agents.tenant_id` as "the owner" asks here instead, so that a Bot moving into `team`
 * (P8b) keeps dispatching to, being suspended for, and being audited against the person it is.
 *
 * Read as `platform`: the question is about the Bot, not about the asker's rows, and background
 * callers (the culler, controls) have no person frame to ask from. Only the answer leaves.
 *
 * `null` means nobody: no row, a `system`/`platform` catalogue Bot, or a team Bot whose profile names
 * no person. Callers decide what nobody means for them; none of them may turn it into `team`.
 */
import { eq, inArray } from "drizzle-orm";
import { ComputerUnavailableError } from "../computer/client";
import type { Database } from "../db/client";
import { agentProfiles, agents } from "../db/schema";
import { TEAM_TENANT } from "../db/schema/tenant";
import { type DispatchTarget, DeviceOfflineError } from "../devices/channel";
import { asPlatform, isPersonTenant } from "../tenant/context";

function ownerOf(row: {
  tenantId: string;
  ownerUserId: string | null;
}): string | null {
  if (isPersonTenant(row.tenantId)) return row.tenantId;
  if (row.tenantId === TEAM_TENANT && isPersonTenant(row.ownerUserId))
    return row.ownerUserId;
  return null;
}

/** The person a Bot belongs to, or `null` when it belongs to nobody. */
export async function ownerTenantOfBot(
  database: Database,
  agentId: string,
): Promise<string | null> {
  const [row] = await asPlatform(() =>
    database
      .select({
        tenantId: agents.tenantId,
        ownerUserId: agentProfiles.ownerUserId,
      })
      .from(agents)
      .leftJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
      .where(eq(agents.id, agentId))
      .limit(1),
  );
  return row ? ownerOf(row) : null;
}

/** {@link ownerTenantOfBot} for many Bots in one read. A Bot with no row is absent from the map. */
export async function ownerTenantsOfBots(
  database: Database,
  agentIds: string[],
): Promise<Map<string, string | null>> {
  if (agentIds.length === 0) return new Map();
  const rows = await asPlatform(() =>
    database
      .select({
        id: agents.id,
        tenantId: agents.tenantId,
        ownerUserId: agentProfiles.ownerUserId,
      })
      .from(agents)
      .leftJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
      .where(inArray(agents.id, agentIds)),
  );
  return new Map(rows.map((row) => [row.id, ownerOf(row)] as const));
}

/**
 * In device mode, the machine a Bot's action runs on: one of its OWNER's registered devices that is
 * connected right now (ticket 017). A team Bot dispatches to its owner's machine, never to a machine
 * of `team`, which has none.
 *
 * With no owner it refuses, and with no machine reachable it refuses rather than falling back to the
 * deployment's container: "run on my machine" answered by somebody else's server is a wrong answer.
 */
export async function deviceTargetForBot(
  deps: {
    database: Database;
    reachableDevice: (tenantId: string) => string | null;
    isRegistered: (target: DispatchTarget) => Promise<boolean>;
  },
  botId: string,
): Promise<DispatchTarget> {
  const tenantId = await ownerTenantOfBot(deps.database, botId);
  if (!tenantId) {
    throw new ComputerUnavailableError(
      `${botId} does not belong to a tenant with machines of its own.`,
    );
  }
  const deviceId = deps.reachableDevice(tenantId);
  if (!deviceId || !(await deps.isRegistered({ tenantId, deviceId }))) {
    throw new DeviceOfflineError(tenantId);
  }
  return { tenantId, deviceId };
}
