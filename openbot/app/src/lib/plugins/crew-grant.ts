import type { QueryClient } from "@tanstack/react-query";
import type { WakerGroup } from "@/lib/waker-groups/queries";
import { grantPlugin, invalidatePlugins, type PluginKind } from "./mutations";

/**
 * Granting to a group, written once for every screen that offers it (spec E2).
 *
 * A GROUP IS NEVER A GRANTEE. It is a way to say WHICH coworkers, so a press on one becomes one
 * grant per member per thing granted, and the server records each of those as its own row and its
 * own audit entry — exactly as if somebody had pressed every member's switch by hand. Nothing here
 * writes a "the group holds it" fact, because there is no such fact on the server to write.
 *
 * Before this the skill screen and the connector screen each carried their own copy of the batch:
 * one sent the writes in parallel and counted refusals, the other sent them one at a time and
 * stopped at the first refusal, so the same crew granted the same way told two different stories.
 */

/** A crew's members in the order the person arranged them, narrowed to those `eligible` admits. */
export function crewMembers(
  crew: WakerGroup,
  eligible: (agentId: string) => boolean,
): string[] {
  const seen = new Set<string>();
  return [...crew.members]
    .sort((left, right) => left.position - right.position)
    .map((member) => member.agentId)
    .filter((agentId) => {
      if (seen.has(agentId) || !eligible(agentId)) return false;
      seen.add(agentId);
      return true;
    });
}

/** One refused write: which thing, and the server's own sentence for why. */
export type GrantRefusal = { ref: string; reason: string };

/** What one member ended up with after a batch. */
export type MemberGrantOutcome = {
  agentId: string;
  granted: string[];
  refused: GrantRefusal[];
};

export type CrewGrantOutcome = {
  /** One entry per member, in the order the members were given. */
  members: MemberGrantOutcome[];
  /** Every write this batch made, taken or refused. */
  writes: number;
};

function reasonOf(thrown: unknown): string {
  if (thrown instanceof Error && thrown.message) return thrown.message;
  if (typeof thrown === "string" && thrown) return thrown;
  return "没有给出原因";
}

/**
 * Write `refs` to every one of `agentIds`, and refetch once at the end.
 *
 * Members in parallel, and each member's writes one after another. Parallel across members because
 * they are independent rows and a crew of eight should not take eight round trips' worth of
 * waiting; sequential within one member so a member's grants land in the order they were asked for
 * and never race each other on the same Bot.
 *
 * A REFUSAL STOPS NOTHING. Every write is attempted and every outcome kept, because the server is
 * deciding each grant on its own and one member it refuses says nothing about the next — and a batch
 * that stopped at the first "no" left the person not knowing which of the rest had landed.
 *
 * ONE INVALIDATION, AFTER EVERYTHING HAS SETTLED, AND ON EVERY OUTCOME. Refetching between writes
 * would draw a half-applied crew, a state that never existed on the server; skipping it on a refusal
 * would leave the writes that did land undrawn. See {@link invalidatePlugins}.
 */
export async function grantToMembers(input: {
  queryClient: QueryClient;
  kind: PluginKind;
  refs: readonly string[];
  agentIds: readonly string[];
  /** Called after each write settles, with how many have so far. */
  onProgress?: (settled: number, total: number) => void;
}): Promise<CrewGrantOutcome> {
  const agentIds = [...new Set(input.agentIds)];
  const refs = [...new Set(input.refs)];
  const total = agentIds.length * refs.length;
  let settled = 0;

  const settledMembers = await Promise.allSettled(
    agentIds.map(async (agentId): Promise<MemberGrantOutcome> => {
      const outcome: MemberGrantOutcome = { agentId, granted: [], refused: [] };
      for (const ref of refs) {
        try {
          await grantPlugin({ kind: input.kind, ref, agentId });
          outcome.granted.push(ref);
        } catch (thrown) {
          outcome.refused.push({ ref, reason: reasonOf(thrown) });
        } finally {
          settled += 1;
          input.onProgress?.(settled, total);
        }
      }
      return outcome;
    }),
  );
  await invalidatePlugins(input.queryClient);

  return {
    /*
     * The member chains above catch every write, so a rejected entry here can only be a fault in
     * `onProgress`. It is still reported as that member's refusals rather than dropped, so no member
     * ever leaves the summary without a sentence.
     */
    members: settledMembers.map((entry, index) =>
      entry.status === "fulfilled"
        ? entry.value
        : {
            agentId: agentIds[index] ?? "",
            granted: [],
            refused: refs.map((ref) => ({
              ref,
              reason: reasonOf(entry.reason),
            })),
          },
    ),
    writes: total,
  };
}

/**
 * The one sentence a batch ends with.
 *
 * Counted in members, not in writes, because members are what the person chose: "2 of 3 coworkers"
 * is something they can act on, "5 of 6 grants" is arithmetic they have to undo. A member counts as
 * having it only when every one of its writes landed. The first refusal's own reason is quoted,
 * because a count without a reason is the shape of a bug report nobody can act on.
 *
 * `label` is the group's name where the press was on a group; `what` is how the granted thing is
 * named in the sentence (`/weekly-report`, `3 个工具`).
 */
export function crewSummary(
  outcome: CrewGrantOutcome,
  options: { label?: string; what: string },
): { text: string; failed: boolean } {
  const prefix = options.label ? `${options.label}：` : "";
  const total = outcome.members.length;
  const refused = outcome.members.filter((member) => member.refused.length > 0);
  if (refused.length === 0) {
    return {
      text: `${prefix}全部 ${total} 位员工都已拿到 ${options.what}。`,
      failed: false,
    };
  }
  const reason = refused[0]?.refused[0]?.reason ?? "没有给出原因";
  return {
    text: `${prefix}${total} 位里有 ${total - refused.length} 位拿到 ${options.what}，${refused.length} 位被拒绝（${reason}）。`,
    failed: true,
  };
}
