import {
  IconBolt,
  IconCheck,
  IconPlus,
  IconUserCircle,
} from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  waitingOnYou,
} from "@/components/bot-profile/attention";
import { Item, ItemContent, ItemTitle } from "@/components/ui/item";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { appConfig } from "@/lib/generated/application-config";
import { cn } from "@/lib/utils";
import { chooseBot } from "./chosen-bot";
import { useMuse } from "./context";
import { mainChannel, tabFor } from "./model";
import { Divider, ErrorNotice, LinkRow, MuseSheet, museText } from "./ui";

/**
 * Who sits at the centre of the frame. This look has one agent; OpenBot has a roster, so this is the
 * one place the difference shows, and it stays a sheet behind the name rather than a fixture.
 */
export function BotsSheet({ onClose }: { onClose: () => void }) {
  const { bot: centre, userId } = useMuse();
  const agents = useQuery(agentListQueryOptions());
  const attention = useQuery(botAttentionQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const navigate = useNavigate();

  const choose = (agentId: string) => {
    if (userId) chooseBot(userId, agentId);
    onClose();
    // On Chat, choosing a Bot means talking to it; elsewhere the tab stays and follows the Bot.
    if (tabFor(pathname) !== "chat") return;
    const main = mainChannel(agentId, channels.data);
    void (main
      ? navigate({ to: "/channel/$channelId", params: { channelId: main.id } })
      : navigate({ to: "/channel/new", search: { agent: agentId } }));
  };

  return (
    <MuseSheet
      onClose={onClose}
      subtitle={`选一位员工，放在${appConfig.brand.productName}的正中。`}
      title="你的员工"
    >
      <div className="flex flex-col gap-3.5">
        {agents.isPending ? null : agents.error ? (
          <ErrorNotice error="读不到你的员工。请刷新页面。" />
        ) : agents.data.length === 0 ? (
          <p className={museText.muted}>你还没有员工。</p>
        ) : (
          <div className="flex flex-col">
            {agents.data.map((agent) => {
              const waiting = attention.data?.find(
                (entry) => entry.agentId === agent.id,
              );
              const asks = waiting ? waitingOnYou(waiting) : 0;
              const summary = waiting ? attentionSummary(waiting) : "";
              const selected = agent.id === centre?.id;
              return (
                <Item
                  aria-pressed={selected}
                  className={cn(
                    "flex-nowrap gap-3.5 rounded-[18px] border-0 px-2 py-2 text-left hover:bg-[var(--openmuse-pressed)]",
                    selected &&
                      "bg-[var(--openmuse-sky)] hover:bg-[var(--openmuse-sky)]",
                  )}
                  key={agent.id}
                  render={
                    <button onClick={() => choose(agent.id)} type="button" />
                  }
                >
                  <AbstractAvatar
                    name={agent.name}
                    seed={agent.avatarSeed}
                    size={44}
                  />
                  <ItemContent className="min-w-0 gap-0.5">
                    <ItemTitle className={cn(museText.body, "font-medium")}>
                      {agent.name}
                    </ItemTitle>
                    <span className={cn(museText.small, "line-clamp-1")}>
                      {asks
                        ? `需要你 · ${summary}`
                        : summary || agent.title || agent.roleDescription}
                    </span>
                  </ItemContent>
                  {selected ? (
                    <IconCheck
                      aria-hidden="true"
                      className="size-[18px] shrink-0 text-[var(--openmuse-accent)]"
                    />
                  ) : summary ? (
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full bg-[var(--openmuse-accent)]"
                    />
                  ) : null}
                </Item>
              );
            })}
          </div>
        )}
        <Divider className="my-1" />
        <div>
          {centre ? (
            <LinkRow
              detail="设置、权限、共享和动态"
              icon={IconUserCircle}
              render={
                <Link
                  onClick={onClose}
                  params={{ agentId: centre.id }}
                  to="/bots/$agentId"
                />
              }
              title={`${centre.name}的主页`}
            />
          ) : null}
          <LinkRow
            detail="你的、共享给你的，以及团队的"
            icon={IconBolt}
            render={<Link onClick={onClose} to="/wakers" />}
            tint="plain"
            title="全部员工"
          />
          <LinkRow
            detail="描述它要做什么"
            icon={IconPlus}
            render={
              <Link onClick={onClose} search={{ new: true }} to="/wakers" />
            }
            tint="plain"
            title="新建员工"
          />
        </div>
      </div>
    </MuseSheet>
  );
}
