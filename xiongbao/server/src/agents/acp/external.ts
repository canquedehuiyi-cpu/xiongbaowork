import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../../db/client";
import { agentProfiles, agents } from "../../db/schema";
import { asPlatform, isPersonTenant, runAsTenant } from "../../tenant/context";

/**
 * What an external employee (`device_acp`) is to the rest of the server: only the hirer's, and only
 * for work somebody asks for (spec §1, 「不做」).
 *
 * UNATTENDED WORK IS REFUSED. A routine, a responsibility (职责), proactive work (主动工作) or a
 * wake-up would run it with nobody there to answer its permission requests, so none can be made for
 * it in this step: the stores refuse them with {@link ExternalEmployeeWorkRefusedError}, which the
 * routes answer 409.
 */

/** Why an external employee takes no unattended work yet, in the words the screens show. */
export const EXTERNAL_UNATTENDED_REFUSAL =
  "外部员工现在只接有人发起的活（单聊、群里 @、别人转给它），例行任务、职责、主动工作和定时唤醒还不能交给它。";

export class ExternalEmployeeWorkRefusedError extends Error {
  override name = "ExternalEmployeeWorkRefusedError";
  constructor() {
    super(EXTERNAL_UNATTENDED_REFUSAL);
  }
}

/**
 * Whether this Bot is an external employee, read in `tenantId`'s own frame. Only its hirer can see
 * its row, and only its hirer can hand it work, so anyone else reads "no" and is refused by the
 * access check that follows anyway.
 */
export async function isExternalEmployee(
  database: Database,
  tenantId: string,
  agentId: string,
): Promise<boolean> {
  const [row] = await runAsTenant(tenantId, () =>
    database
      .select({ type: agents.type })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1),
  );
  return row?.type === "device_acp";
}

/** Refuses unattended work for an external employee (see the header). */
export async function refuseExternalEmployeeWork(
  database: Database,
  tenantId: string,
  agentId: string,
): Promise<void> {
  if (await isExternalEmployee(database, tenantId, agentId))
    throw new ExternalEmployeeWorkRefusedError();
}

/**
 * Which of these Bots are external employees, with their hirer and name. Read as `platform`, like
 * `ownerTenantsOfBots`: a group member's frame cannot see another member's private employee, and
 * only the answer (who hired it, what it is called) leaves. A deleted employee is not listed.
 */
export async function externalEmployeesAmong(
  database: Database,
  agentIds: readonly string[],
): Promise<Map<string, { hirer: string; name: string }>> {
  if (agentIds.length === 0) return new Map();
  const rows = await asPlatform(() =>
    database
      .select({
        id: agents.id,
        name: agents.name,
        tenantId: agents.tenantId,
        ownerUserId: agentProfiles.ownerUserId,
      })
      .from(agents)
      .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
      .where(
        and(
          inArray(agents.id, [...agentIds]),
          eq(agents.type, "device_acp"),
          isNull(agentProfiles.deletedAt),
        ),
      ),
  );
  const found = new Map<string, { hirer: string; name: string }>();
  // Always private: its row carries its hirer's tenant, and the profile names the same person.
  for (const row of rows)
    if (isPersonTenant(row.tenantId) && row.ownerUserId === row.tenantId)
      found.set(row.id, { hirer: row.tenantId, name: row.name });
  return found;
}

/** The hirer of an external employee, or null for any other Bot (or none). */
export async function externalHirerOf(
  database: Database,
  agentId: string,
): Promise<string | null> {
  return (
    (await externalEmployeesAmong(database, [agentId])).get(agentId)?.hirer ??
    null
  );
}
