import { IconPencil } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  appKeyOf,
  connectionsQueryOptions,
  installListingsQueryOptions,
  listedRefs,
  type PluginServer,
  type PluginSkill,
  type PluginsPage,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import {
  CardGrid,
  grantedSentence,
  NoMatch,
  QueryState,
  TabEmpty,
  TabHeader,
  TabSearch,
  Tag,
} from "./resource-kit";

/*
 * ── Stories E1/E4 (D08-7): skills and connectors, each now its own tab of 能力与资源. ──
 *
 * Both are drawn from the one `/api/plugins` read, so that request failing is each tab's alert; the
 * reads beside it (who you are, what is listed, what you connected) only take away the detail they
 * add.
 */

/** A row of a tab, drawn as a card in the tab's grid. `Item` keeps the slots the tests read. */
export function ResourceCard({
  title,
  description,
  meta,
  media,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  media?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <li className="flex">
      <Item
        className="h-full flex-nowrap items-start bg-card"
        variant="outline"
      >
        {media ? <ItemMedia>{media}</ItemMedia> : null}
        <ItemContent className="min-w-0">
          <ItemTitle>{title}</ItemTitle>
          {description ? (
            <ItemDescription>{description}</ItemDescription>
          ) : null}
          {meta ? (
            <span className="text-[12px] text-muted-foreground">{meta}</span>
          ) : null}
        </ItemContent>
        {actions ? (
          <ItemActions className="shrink-0">{actions}</ItemActions>
        ) : null}
      </Item>
    </li>
  );
}

const textMatch = (query: string, ...fields: (string | null | undefined)[]) => {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return true;
  return fields.join(" ").toLocaleLowerCase().includes(term);
};

export { textMatch };

/**
 * Story E1's skills: the person's own and the deployment's, as two groups.
 *
 * Only the signed-in person's own count as 我的. An administrator's `/api/plugins` also carries other
 * people's personal skills; those are governed on the administrator's skill screen and are neither
 * this person's nor the deployment's, so this view leaves them out. A deployment skill an
 * administrator listed (上架, spec E3) carries 可自助安装: an owner ticks it onto a Waker on the
 * assembly page without asking anyone. The listings are a separate read, so failing to read them
 * drops the tag and nothing else.
 */
export function SkillsTab({
  query,
  onQuery,
}: {
  query: string;
  onQuery: (value: string) => void;
}) {
  const plugins = useQuery(pluginsPageQueryOptions());
  const me = useQuery(currentUserQueryOptions());
  const listings = useQuery(installListingsQueryOptions());
  const skills = plugins.data?.skills ?? [];
  const meId = me.data?.id;
  const visible = skills.filter((skill) =>
    textMatch(query, skill.title, skill.summary),
  );
  const mine = visible.filter(
    (skill) => skill.ownerUserId !== null && skill.ownerUserId === meId,
  );
  const deployment = visible.filter((skill) => skill.ownerUserId === null);
  const listed = listedRefs(listings.data, "skill");
  const anyOwnOrDeployment = skills.some(
    (skill) =>
      skill.ownerUserId === null ||
      (skill.ownerUserId !== null && skill.ownerUserId === meId),
  );

  const card = (skill: PluginSkill, selfInstall: boolean) => (
    <ResourceCard
      actions={
        <span className="text-[12px] text-muted-foreground">
          {grantedSentence(skill.grantedTo.length)}
        </span>
      }
      description={skill.summary}
      key={skill.slug}
      title={
        <>
          {skill.title}
          {selfInstall ? <Tag>可自助安装</Tag> : null}
        </>
      }
    />
  );

  return (
    <>
      <TabHeader
        actions={
          <>
            <Button
              render={(props) => (
                <Link search={{ new: true }} to="/skills" {...props} />
              )}
              size="sm"
              variant="outline"
            >
              <IconPencil />
              撰写
            </Button>
            <Button
              render={(props) => <Link search={{}} to="/skills" {...props} />}
              size="sm"
              variant="ghost"
            >
              打开技能页
            </Button>
          </>
        }
        description="员工在活儿需要时会照做的说明。你自己写的在“我的”里；管理员写的在“部署”里，按员工授予给他们，标着可自助安装的由你在员工装配页里自己装上。"
        search={<TabSearch label="搜索技能" onChange={onQuery} value={query} />}
      />
      <QueryState
        label="读不到技能"
        query={{ ...plugins, isPending: plugins.isPending || me.isPending }}
      >
        {query.trim() &&
        anyOwnOrDeployment &&
        mine.length + deployment.length === 0 ? (
          <NoMatch onClear={() => onQuery("")} title="没有匹配的技能" />
        ) : (
          <>
            <SkillGroup
              empty={
                query.trim()
                  ? "没有匹配的技能。"
                  : me.error
                    ? "读不到你自己的技能。"
                    : "你还没有写过技能。"
              }
              rows={mine.map((skill) => card(skill, false))}
              title="我的"
            />
            <SkillGroup
              empty={
                query.trim()
                  ? "没有匹配的技能。"
                  : "这个部署还没有管理员写的技能。"
              }
              rows={deployment.map((skill) =>
                card(skill, listed.has(skill.slug)),
              )}
              title="部署"
            />
          </>
        )}
      </QueryState>
    </>
  );
}

function SkillGroup({
  empty,
  rows,
  title,
}: {
  empty: string;
  rows: ReactNode[];
  title: string;
}) {
  return (
    <div className="mt-5 flex flex-col gap-2">
      <h3 className="font-medium text-[13px]">
        {title}
        <span className="ml-1.5 text-muted-foreground tabular-nums">
          {rows.length}
        </span>
      </h3>
      {rows.length > 0 ? (
        <CardGrid label={`${title}的技能`}>{rows}</CardGrid>
      ) : (
        <p className="text-[13px] text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

/**
 * Whether an app answers as whoever is asking, so a Waker reaches it only once this person connected
 * their own account: a catalogue `user-oauth` vendor, or a brokered app that needs an account. The
 * same rule the assembly page and the connected-accounts page decide by.
 */
function connectsPerPerson(server: PluginServer, page: PluginsPage): boolean {
  if (server.provenance === "composio") return server.authScheme !== "NO_AUTH";
  // The catalogue key, not the row id: a curated connector is the team's row `team:<key>`.
  const key = appKeyOf(server);
  return page.catalogue.some(
    (entry) => entry.key === key && entry.auth === "user-oauth",
  );
}

/**
 * Story E1's connectors, with where each one stands.
 *
 * 已授予 N 位员工 counts Wakers, not grants: the union of every tool's `grantedTo`, so a Waker that
 * holds three of a connector's tools is one employee. For an app reached as the person asking, the
 * card also says whether THIS person connected their account — a granted tool on an unconnected
 * account reaches nothing. That comes from `/api/plugins/connections`; when it cannot be read the
 * card says so rather than guessing 未连接.
 */
export function ConnectorsTab({
  query,
  onQuery,
}: {
  query: string;
  onQuery: (value: string) => void;
}) {
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const servers = plugins.data?.servers ?? [];
  const visible = servers.filter((server) =>
    textMatch(query, server.title, server.summary, server.vendor),
  );
  const connected = new Set(
    (connections.data?.connections ?? []).map((row) => row.serverId),
  );

  const accountState = (server: PluginServer): string => {
    if (!plugins.data || !connectsPerPerson(server, plugins.data))
      return server.hasCredential ? "已接入" : "没有凭据";
    if (connections.isPending) return "正在读取你的连接…";
    if (connections.error) return "读不到你的连接";
    return connected.has(server.id) ? "你已连接" : "未连接";
  };

  return (
    <>
      <TabHeader
        actions={
          <Button
            render={(props) => (
              <Link search={{}} to="/settings/connected-accounts" {...props} />
            )}
            size="sm"
            variant="outline"
          >
            已连接的账号
          </Button>
        }
        description="员工干活时可以碰到的系统。授予是管理员的动作，所以这里列出有什么、授予了几位员工、你自己的账号连上没有，以及在哪里决定。"
        search={
          <TabSearch label="搜索连接器" onChange={onQuery} value={query} />
        }
      />
      <QueryState label="读不到连接器" query={plugins}>
        {servers.length === 0 ? (
          <TabEmpty
            description="管理员在插件页里添加连接器之后，它们会出现在这里。"
            title="还没有连接器"
          />
        ) : visible.length === 0 ? (
          <NoMatch onClear={() => onQuery("")} title="没有匹配的连接器" />
        ) : (
          <CardGrid className="mt-4" label="连接器列表">
            {visible.map((server) => (
              <ResourceCard
                actions={
                  <span className="text-[12px] text-muted-foreground">
                    {accountState(server)}
                  </span>
                }
                description={server.summary}
                key={server.id}
                media={
                  <span className="flex size-[32px] items-center justify-center rounded-md bg-muted">
                    <PluginLogo logo={server.logo} />
                  </span>
                }
                meta={grantedSentence(
                  new Set(server.tools.flatMap((tool) => tool.grantedTo)).size,
                )}
                title={server.title}
              />
            ))}
          </CardGrid>
        )}
      </QueryState>
      <p className="mt-4 text-[13px] text-muted-foreground">
        授予在
        <Link className="underline" to="/admin/plugins">
          管理员的插件页
        </Link>
        里管理；你自己的账号在
        <Link
          className="underline"
          search={{}}
          to="/settings/connected-accounts"
        >
          已连接的账号
        </Link>
        里连接。
      </p>
    </>
  );
}
