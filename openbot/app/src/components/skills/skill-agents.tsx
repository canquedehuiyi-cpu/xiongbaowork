import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  crewMembers,
  crewSummary,
  grantToMembers,
} from "@/lib/plugins/crew-grant";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";
import {
  type WakerGroup,
  wakerGroupsQueryOptions,
} from "@/lib/waker-groups/queries";

/**
 * Which of your Agents carry this skill.
 *
 * WITHOUT THIS THE SKILL DOES NOTHING. A skill reaches a Bot's `/` menu only through a grant: the
 * menu is fed by `GET /api/plugins/for/:agentId`, which returns what that Bot HOLDS, and a row in
 * `plugin_grants` IS the grant — absence is the refusal. A skill nobody granted is written, listed,
 * and invisible everywhere it would actually be used.
 *
 * ONLY BOTS THIS PERSON OWNS. The server's rule is that somebody may put THEIR OWN skill on a Bot
 * THEY OWN, and neither half alone is enough — a skill one person wrote would otherwise change how a
 * shared Bot answers everybody. Offering the others here and having them refused on click would be
 * a worse answer than not offering them.
 *
 * A group is the same rule, expanded: spec E2 says a crew is a way to say WHICH coworkers, not a
 * holder of anything itself, so a group chip writes one grant per member this person owns and says
 * what it could not write. The server records a row per grant either way — the audit trail does not
 * get a "the group" entry, because a group cannot answer for what it was handed.
 */
export function SkillAgents({
  slug,
  grantedTo,
}: {
  slug: string;
  grantedTo: string[];
}) {
  const queryClient = useQueryClient();
  const { data: agents } = useQuery(agentListQueryOptions());
  const crews = useQuery(wakerGroupsQueryOptions());
  const mine = (agents ?? []).filter((agent) => agent.mine);
  const owned = new Set(mine.map((agent) => agent.id));
  const held = new Set(grantedTo);
  const [batch, setBatch] = useState<{ text: string; failed: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const grant = useMutation(setPluginGrantMutationOptions(queryClient));

  /* `on` is the current state, so a click asks for its opposite. */
  const toggle = (agentId: string, on: boolean) =>
    grant.mutate({ agentId, granted: !on, kind: "skill", ref: slug });

  async function grantToCrew(crew: WakerGroup, agentIds: string[]) {
    setBatch(null);
    setBusy(true);
    /*
     * The shared batch: one grant per member, every refusal kept, one refetch at the end. See
     * `crew-grant.ts` for why each of those is the rule rather than a preference.
     */
    try {
      const outcome = await grantToMembers({
        queryClient,
        kind: "skill",
        refs: [slug],
        agentIds,
      });
      setBatch(crewSummary(outcome, { label: crew.name, what: `/${slug}` }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">员工</h2>
      {mine.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          你还没有可以交给它的员工。
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {mine.map((agent) => {
              const on = held.has(agent.id);
              return (
                <Button
                  disabled={grant.isPending}
                  key={agent.id}
                  onClick={() => toggle(agent.id, on)}
                  size="sm"
                  type="button"
                  /*
                   * The state is the fill, not a tick alone: a row of outline buttons where one
                   * carries a small mark reads as a list of choices rather than as a set of
                   * switches, and which are on has to survive a glance.
                   */
                  variant={on ? "default" : "outline"}
                >
                  {agent.name}
                </Button>
              );
            })}
          </div>
          {(crews.data ?? []).length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-xs">
                或者交给一个小组：
              </span>
              {(crews.data ?? []).map((crew) => {
                const missing = crewMembers(
                  crew,
                  (agentId) => owned.has(agentId) && !held.has(agentId),
                );
                return (
                  <Button
                    aria-label={`把 /${slug} 交给${crew.name}`}
                    disabled={grant.isPending || busy || missing.length === 0}
                    key={crew.id}
                    onClick={() => void grantToCrew(crew, missing)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {crew.name} · {missing.length}
                  </Button>
                );
              })}
            </div>
          )}
          <p className="text-muted-foreground text-xs">
            拿到它的员工会在输入框里提供 <code>/{slug}</code> 。
          </p>
        </>
      )}
      {batch ? (
        <p
          className={
            batch.failed
              ? "text-destructive text-xs"
              : "text-muted-foreground text-xs"
          }
          role={batch.failed ? "alert" : "status"}
        >
          {batch.text}
        </p>
      ) : null}
      {grant.error ? (
        <p className="text-destructive text-xs" role="alert">
          {grant.error.message}
        </p>
      ) : null}
    </div>
  );
}
