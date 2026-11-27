import type { BaseEvent } from "@ag-ui/client";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { TURN_ARTIFACTS_EVENT } from "../../../shared/turn-artifacts";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import {
  agentProfiles,
  channelAgents,
  channelMemberships,
  channels,
  groupBotThreads,
  intelligenceChannelMappings,
  taskEvents,
  tasks,
  threadRunEvents,
  threadRuns,
} from "../db/schema";
import { runAsTenant } from "../tenant/context";
import { type ArtifactAccessDeps, deliveredAppsOf } from "./artifact-access";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parsed = (stored: unknown): BaseEvent =>
  (typeof stored === "string" ? JSON.parse(stored) : stored) as BaseEvent;

/**
 * The rules' view of the database (see artifact-access.ts).
 *
 * The asker's own frame decides what they may see: the conversation, its members and its threads
 * are read as the asker, so a person who is not in it finds nothing. The run's rows belong to
 * whoever started it, so they are read in that person's frame, and only for a thread that the
 * asker's own view of the conversation listed.
 */
export function createArtifactAccessDeps(
  database: Database,
  /** The gateway's seat for a Bot and a person (`gateway.seatFor`). */
  seatFor: ArtifactAccessDeps["seatFor"],
): ArtifactAccessDeps {
  /** The conversation's threads and who owns each, as the asker sees them. Null: not theirs to see. */
  async function threadsOf(actor: AgentActor, channelId: string) {
    const [member] = await database
      .select({ id: channels.id })
      .from(channelMemberships)
      .innerJoin(channels, eq(channels.id, channelMemberships.channelId))
      .where(
        and(
          eq(channelMemberships.channelId, channelId),
          eq(channelMemberships.userId, actor.id),
          isNull(channels.deletedAt),
        ),
      )
      .limit(1);
    if (!member) return null;
    const owners = new Map<string, string>();
    const grouped = await database
      .select({
        threadId: groupBotThreads.threadId,
        owner: groupBotThreads.ownerUserId,
      })
      .from(groupBotThreads)
      .where(eq(groupBotThreads.channelId, channelId));
    const mapped = await database
      .select({
        threadId: intelligenceChannelMappings.threadId,
        owner: intelligenceChannelMappings.userId,
      })
      .from(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    for (const row of [...grouped, ...mapped])
      owners.set(row.threadId, row.owner);
    return owners;
  }

  /** The stored events of these runs, oldest first, in one frame. */
  async function eventsOf(runIds: string[]): Promise<Map<string, BaseEvent[]>> {
    const byRun = new Map<string, BaseEvent[]>();
    if (runIds.length === 0) return byRun;
    const rows = await database
      .select({ runId: threadRunEvents.runId, event: threadRunEvents.event })
      .from(threadRunEvents)
      .where(inArray(threadRunEvents.runId, runIds))
      .orderBy(threadRunEvents.runId, asc(threadRunEvents.seq));
    for (const row of rows) {
      const list = byRun.get(row.runId) ?? [];
      list.push(parsed(row.event));
      byRun.set(row.runId, list);
    }
    return byRun;
  }

  return {
    /*
     * Worked out in the frame of the person the run or card belongs to, the one every turn of theirs
     * used, and not in the asker's: what the resolver reads about the Bot (its owner, whether it is
     * private or isolated) is that person's to see, not a group member's.
     */
    seatFor: (botId, personId) =>
      runAsTenant(personId, () => seatFor(botId, personId)),

    // In that person's own frame: an employee they cannot see, or one they deleted, is gone to them.
    botIsLive: (personId, botId) =>
      runAsTenant(personId, async () => {
        const [row] = await database
          .select({ id: agentProfiles.agentId })
          .from(agentProfiles)
          .where(
            and(
              eq(agentProfiles.agentId, botId),
              isNull(agentProfiles.deletedAt),
            ),
          )
          .limit(1);
        return Boolean(row);
      }),

    channelFor: (actor, channelId) =>
      runAsTenant(actor.id, async () => {
        const owners = await threadsOf(actor, channelId);
        if (!owners) return null;
        const agents = await database
          .select({ agentId: channelAgents.agentId })
          .from(channelAgents)
          .where(eq(channelAgents.channelId, channelId));
        return {
          agentIds: agents.map((row) => row.agentId),
          threadIds: [...owners.keys()],
        };
      }),

    runOf: async (actor, channelId, runId) => {
      const owners = await runAsTenant(actor.id, () =>
        threadsOf(actor, channelId),
      );
      if (!owners) return null;
      const byOwner = new Map<string, string[]>();
      for (const [threadId, owner] of owners)
        byOwner.set(owner, [...(byOwner.get(owner) ?? []), threadId]);
      for (const [owner, threadIds] of byOwner) {
        const found = await runAsTenant(owner, async () => {
          const [run] = await database
            .select({
              threadId: threadRuns.threadId,
              agentId: threadRuns.agentId,
            })
            .from(threadRuns)
            .where(
              and(
                eq(threadRuns.id, runId),
                inArray(threadRuns.threadId, threadIds),
              ),
            )
            .limit(1);
          if (!run) return null;
          return {
            threadId: run.threadId,
            ownerId: owner,
            agentId: run.agentId,
            events: (await eventsOf([runId])).get(runId) ?? [],
          };
        });
        if (found) return found;
      }
      return null;
    },

    cardFor: (actor, taskId) =>
      runAsTenant(actor.id, async () => {
        // Asked first: `tasks.id` is a uuid, and anything else is an error from the database.
        if (!UUID.test(taskId)) return null;
        // The card's own tenant, the same reading as the board's `GET /api/tasks/:id`.
        const [card] = await database
          .select({
            botId: tasks.executorAgentId,
            runRef: tasks.runRef,
            activeRunRef: tasks.activeRunRef,
            deliverable: tasks.deliverableRef,
          })
          .from(tasks)
          .where(and(eq(tasks.tenantId, actor.id), eq(tasks.id, taskId)))
          .limit(1);
        if (!card?.botId) return null;
        const files =
          isRecord(card.deliverable) &&
          Array.isArray(card.deliverable.workspaceFiles)
            ? card.deliverable.workspaceFiles.filter(
                (path): path is string => typeof path === "string",
              )
            : [];
        const apps = isRecord(card.deliverable)
          ? deliveredAppsOf(card.deliverable.apps)
          : [];
        if (files.length === 0 && apps.length === 0) return null;
        const found = {
          botId: card.botId,
          ownerId: actor.id,
          workspaceFiles: files,
          ...(apps.length > 0 ? { apps } : {}),
        };

        /*
         * The computer the hand-in was taken on, kept with it (`deliverable_ref.seat`, written only by
         * the server: `tasks/delivery-tools.ts`). The rules still check it against the seat the server
         * works out now (`confirmed`).
         */
        const kept = isRecord(card.deliverable)
          ? card.deliverable.seat
          : undefined;
        if (typeof kept === "string") return { ...found, seat: kept };

        // A card from before that: the computer its own rounds announced for its employee.
        const logged = await database
          .selectDistinct({
            runId: sql<string>`${taskEvents.detail}->>'runId'`,
          })
          .from(taskEvents)
          .where(
            and(
              eq(taskEvents.tenantId, actor.id),
              eq(taskEvents.taskId, taskId),
              sql`${taskEvents.detail}->>'runId' is not null`,
            ),
          );
        const runIds = [
          ...new Set(
            [
              card.runRef,
              card.activeRunRef,
              ...logged.map((r) => r.runId),
            ].filter((id): id is string => typeof id === "string" && id !== ""),
          ),
        ];
        const seats = new Set<string>();
        for (const events of (await eventsOf(runIds)).values())
          for (const event of events) {
            const item: unknown = event;
            if (
              !isRecord(item) ||
              item.type !== "CUSTOM" ||
              item.name !== TURN_ARTIFACTS_EVENT ||
              !isRecord(item.value)
            )
              continue;
            if (
              item.value.botId === card.botId &&
              typeof item.value.seat === "string"
            )
              seats.add(item.value.seat);
          }
        // Two different computers are not guessed between.
        if (seats.size > 1) return null;
        /*
         * None: its files were written where no round announced them (an approved action runs outside
         * every round). The seat is left absent, and the rules decide what that may open.
         */
        if (seats.size === 0) return found;
        return { ...found, seat: [...seats][0] as string };
      }),
  };
}
