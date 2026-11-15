import {
  ACTIVE_ACP_TURN_STATUSES,
  type AcpTurnRow,
  type AcpTurnStore,
  isFinalAcpTurnStatus,
} from "../../src/agents/acp/turns";
import type { AcpTurnStatus } from "../../src/db/schema";

/**
 * `AcpTurnStore` in memory, for tests of what consumes it (the relay, the transport). It keeps the
 * same rules as the database store (`src/agents/acp/turns.ts`), which
 * `tests/acp-turns.integration.test.ts` checks against Postgres: tenant-scoped reads, a final status
 * that never changes, `claim` only from `queued`, lanes of one employee in one thread.
 */
export function createMemoryAcpTurnStore(): AcpTurnStore & {
  rows: AcpTurnRow[];
} {
  const rows: AcpTurnRow[] = [];
  let clock = Date.parse("2026-11-15T00:00:00Z");
  const active = (status: AcpTurnStatus) =>
    (ACTIVE_ACP_TURN_STATUSES as readonly string[]).includes(status);
  const byTurn = (tenantId: string, turnId: string) =>
    rows.find((row) => row.tenantId === tenantId && row.turnId === turnId);
  const ordered = (list: AcpTurnRow[]) =>
    [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const copy = (row: AcpTurnRow): AcpTurnRow => ({ ...row });

  return {
    rows,
    async enqueue(turn) {
      if (rows.some((row) => row.turnId === turn.turnId)) return;
      clock += 1;
      rows.push({
        id: `row-${rows.length + 1}`,
        tenantId: turn.tenantId,
        agentId: turn.agentId,
        threadId: turn.threadId,
        deviceId: turn.deviceId,
        turnId: turn.turnId,
        status: "queued",
        prompt: turn.prompt,
        lastSeq: 0,
        createdAt: new Date(clock),
        updatedAt: new Date(clock),
      });
    },
    async nextForThread(tenantId, threadId, agentId) {
      const lane = rows.filter(
        (row) =>
          row.tenantId === tenantId &&
          row.threadId === threadId &&
          row.agentId === agentId,
      );
      if (lane.some((row) => active(row.status))) return null;
      const next = ordered(lane.filter((row) => row.status === "queued"))[0];
      return next ? copy(next) : null;
    },
    async queuedForDevice(tenantId, deviceId) {
      return ordered(
        rows.filter(
          (row) =>
            row.tenantId === tenantId &&
            row.deviceId === deviceId &&
            row.status === "queued",
        ),
      ).map(copy);
    },
    async setStatus(tenantId, turnId, status, lastSeq) {
      const row = byTurn(tenantId, turnId);
      if (!row || isFinalAcpTurnStatus(row.status)) return false;
      row.status = status;
      if (lastSeq !== undefined) row.lastSeq = Math.max(row.lastSeq, lastSeq);
      return true;
    },
    async countQueued(tenantId, agentId) {
      return rows.filter(
        (row) =>
          row.tenantId === tenantId &&
          row.agentId === agentId &&
          (row.status === "queued" || row.status === "sent"),
      ).length;
    },
    async get(tenantId, turnId) {
      const row = byTurn(tenantId, turnId);
      return row ? copy(row) : null;
    },
    async activeForDevice(tenantId, deviceId) {
      return ordered(
        rows.filter(
          (row) =>
            row.tenantId === tenantId &&
            row.deviceId === deviceId &&
            active(row.status),
        ),
      ).map(copy);
    },
    async openInLane(tenantId, deviceId, agentId, threadId) {
      const lane = rows.filter(
        (row) =>
          row.tenantId === tenantId &&
          row.deviceId === deviceId &&
          row.agentId === agentId &&
          row.threadId === threadId,
      );
      if (lane.length === 0) return null;
      return ordered(
        lane.filter((row) => !isFinalAcpTurnStatus(row.status)),
      ).map(copy);
    },
    async claim(tenantId, turnId) {
      const row = byTurn(tenantId, turnId);
      if (row?.status !== "queued") return null;
      row.status = "sent";
      return copy(row);
    },
    async unclaim(tenantId, turnId) {
      const row = byTurn(tenantId, turnId);
      if (row?.status === "sent") row.status = "queued";
    },
    async recordSeq(tenantId, turnId, lastSeq) {
      const row = byTurn(tenantId, turnId);
      if (row) row.lastSeq = Math.max(row.lastSeq, lastSeq);
    },
  };
}
