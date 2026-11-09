<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
=======
import { IconArrowsExchange, IconBolt, IconLock } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { handoffRoster } from "@/lib/agents/handoff-roster";
import { setHandoffGrantMutationOptions } from "@/lib/agents/mutations";
import {
  agentHandoffQueryOptions,
  agentListQueryOptions,
} from "@/lib/agents/queries";

/**
 * Which Bots this one may hand work to.
 *
 * On the Bot's own screen rather than in the connector catalogue: a catalogue entry has a fixed list
 * of tools somebody else maintains, and the Bots a deployment has are whatever was made here. It is
 * also the question a person asks while looking at a Bot, not while looking at a vendor.
 *
 * DIRECTIONAL, and said so on the screen, because the pair is the one thing about this that is easy
 * to get backwards: this is who this Bot may ask, not who may ask it.
 *
 * One Item per candidate, with a Switch: the grant is one boolean that takes effect when switched,
 * which is exactly the row kind a Switch means everywhere else in this app.
 */
export function HandoffPanel({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const handoff = useQuery(agentHandoffQueryOptions(agentId));
  const agents = useQuery(agentListQueryOptions());
  /*
   * The roster this person has hidden, read so a grant pointing into it can still be taken away.
   *
   * Hiding is a per-person display preference and the grants are not filtered by it at all, so
   * joining the grants against the visible roster alone dropped live grants off the only screen that
   * manages them. See `handoffRoster`, which is where that join now happens.
   */
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const setGrant = useMutation(setHandoffGrantMutationOptions(queryClient));

  if (handoff.isPending || !handoff.data) return null;
  const { enabled, canGrant, reachable, grantable } = handoff.data;

  // A Bot may not be granted itself, and the server refuses it, so it is not offered here either.
  const { candidates, granted, total } = handoffRoster({
    agentId,
    roster: agents.data ?? [],
    hidden: hiddenAgents.data ?? [],
    reachable,
    grantable,
  });

  // Nothing to say to somebody who cannot change it and has nothing to read.
  if (!canGrant && reachable.length === 0) return null;

  return (
    <section className="grid gap-2">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          它可以求助的员工
        </h2>
        {/* The current answer at a glance, so the list below is detail rather than homework. */}
        {grantable && total > 0 ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            已允许 {granted} / {total}
          </span>
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
        ) : null}
      </header>

      <p className="text-muted-foreground text-sm">
        这里是它可以去问谁，不是谁可以来问它。被问的员工说的话会转回发起提问的对话，并注明出处。
      </p>

      {enabled ? null : (
        <Item variant="muted">
          <ItemContent>
            <ItemTitle>这个部署已关闭此功能</ItemTitle>
            {/*
             * Unclamped: `ItemDescription` clips to two lines, which is right for a roster row
             * whose description is a subtitle and wrong for an item that exists to explain. The
             * sentence that gets cut is the one saying what to do about it.
             */}
            <ItemDescription className="line-clamp-none">
              这些授权会保留，但在重新打开员工之间交接工作之前，都不会生效。
            </ItemDescription>
          </ItemContent>
        </Item>
      )}

      {grantable ? null : (
        <Item variant="muted">
          <ItemContent>
            <ItemTitle>这位员工不能把工作交出去</ItemTitle>
            {/* Unclamped for the same reason as above: three lines, and the third is the useful one. */}
            <ItemDescription className="line-clamp-none">
              这个部署没有地方记录它可以把工作交给哪些员工，所以这里没什么可授予的。能交接的员工仍然可以来问它。
            </ItemDescription>
          </ItemContent>
        </Item>
=======
        ) : null
      }
      description="Choose which Bots this Bot can ask for help. Their answers appear in the same conversation under their own names. This does not change who can ask this Bot for help."
      title="Bots it can ask"
    >
      {/* Facts about the deployment rather than rows to act on, so said as sentences. */}
      {enabled ? null : (
        <PageEmpty icon={IconArrowsExchange} title="Handoffs are off">
          An admin turned off handing work between Bots. These settings are
          kept, and they apply again once it's back on.
        </PageEmpty>
      )}

      {grantable ? null : (
        <PageEmpty icon={IconLock} title="Can't hand off work">
          This Bot can't hand work to other Bots. Other Bots can still hand work
          to it.
        </PageEmpty>
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
      )}

      {setGrant.error ? (
        <p className="text-destructive text-sm" role="alert">
          {setGrant.error.message}
        </p>
      ) : null}

      {grantable && total === 0 ? (
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
        <Empty className="h-[180px] border border-dashed">
          <EmptyHeader>
            <EmptyTitle className="text-muted-foreground">
              这里还没有别的员工
            </EmptyTitle>
            <EmptyDescription>
              等这个部署有了更多员工，就在这里允许它去问它们。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {candidates.length > 0 ? (
        <div className="flex flex-col gap-2">
          {candidates.map((candidate) => (
            <Item key={candidate.id} size="sm" variant="muted">
              <ItemMedia>
                <AbstractAvatar
                  name={candidate.name}
                  seed={candidate.avatarSeed}
                  portrait={{ kind: "coworker", id: candidate.id }}
                  size={28}
                />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{candidate.name}</ItemTitle>
                {/*
                 * Said on the row, because otherwise it is a coworker that is not on your roster
                 * appearing in a list with no explanation. It is here only because this Bot may
                 * already ask it, and that is the sentence a person needs to decide what to do.
                 */}
                <ItemDescription>
                  {candidate.hidden
                    ? `${candidate.title} · 已从你的员工列表隐藏`
                    : candidate.title}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-label={`允许它去问 ${candidate.name}`}
                  checked={reachable.includes(candidate.id)}
                  disabled={!canGrant || setGrant.isPending}
                  onCheckedChange={(next: boolean) =>
                    setGrant.mutate({
                      agentId,
                      ref: candidate.id,
                      granted: next,
                    })
                  }
                />
              </ItemActions>
            </Item>
=======
        <PageEmpty icon={IconBolt} title="No other Bots yet">
          When there are more, you can let this Bot ask them here.
        </PageEmpty>
      ) : null}
      {candidates.length > 0 ? (
        <PageRows>
          {candidates.map((candidate, index) => (
            <Fragment key={candidate.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia>
                  <AbstractAvatar
                    name={candidate.name}
                    seed={candidate.avatarSeed}
                    size={28}
                  />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{candidate.name}</ItemTitle>
                  {/*
                   * Said on the row, because otherwise it is a coworker that is not on your roster
                   * appearing in a list with no explanation. It is here only because this Bot may
                   * already ask it, and that is the sentence a person needs to decide what to do.
                   */}
                  <ItemDescription>
                    {candidate.hidden
                      ? `${candidate.title} · hidden from your Bots list`
                      : candidate.title}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label={`Let this Bot ask ${candidate.name}`}
                    checked={reachable.includes(candidate.id)}
                    disabled={!canGrant || setGrant.isPending}
                    onCheckedChange={(next: boolean) =>
                      setGrant.mutate({
                        agentId,
                        ref: candidate.id,
                        granted: next,
                      })
                    }
                  />
                </ItemActions>
              </Item>
            </Fragment>
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
          ))}
        </div>
      ) : null}

      {canGrant ? null : (
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
        <p className="text-muted-foreground text-xs">
          可以问哪些员工，由管理员决定。
        </p>
=======
        <PageEmpty icon={IconLock} title="Set by an admin">
          An admin decides which Bots this one can ask.
        </PageEmpty>
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
      )}
    </section>
  );
}
