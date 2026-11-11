import {
  IconApps,
  IconBox,
  IconChevronRight,
  IconPlug,
  IconPlus,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { HandoffPanel } from "@/components/agents/handoff-panel";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import {
  AppAccessAction,
  appAccessSentence,
} from "@/components/plugins/app-access-action";
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
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  giveBotAppMutationOptions,
  takeBackBotAppMutationOptions,
} from "@/lib/app-access/mutations";
import {
  type AppAccess,
  botAppsQueryOptions,
  type GiveableApp,
  giveableAppsQueryOptions,
} from "@/lib/app-access/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useManagePaths } from "@/lib/manage-paths";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";
import {
  agentPluginsQueryOptions,
  type GrantedPlugins,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { toolName } from "@/lib/plugins/tool-words";
import { queryClient } from "@/query-client";

/**
 * "google-drive" as "Google Drive": the connector key, said the way a person would.
 *
 * ONLY FOR A CONNECTOR THE APP-ACCESS READ DID NOT NAME. Every app it names is drawn by its own
 * display name — "Gmail", where this would have said "Composio Gmail".
 */
function connectorName(key: string): string {
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Connector key → the labels of the tools this Bot holds on it.
 *
 * Named as the app's own page lists them (`toolName`), each as a command: "Create goal", where
 * Activity says what was done, "Created a goal". A list that said some of each read as a list of
 * two kinds of thing.
 *
 * Vendors prefix every tool with their own name — "Notion create pages" — which next to a row
 * already titled Notion reads as a stutter. Stripped only as a leading word, and re-cased, so
 * "Notion search" becomes "Search" while "Search notion pages" is left alone.
 */
function connectorTools(plugins: GrantedPlugins): Map<string, string[]> {
  const connectors = new Map<string, string[]>();
  for (const tool of plugins.tools) {
    const key = tool.ref.split("/")[0] ?? tool.ref;
    let label = toolName(key, tool.ref.slice(key.length + 1) || tool.ref);
    const prefix = `${key.toLowerCase()} `;
    if (label.toLowerCase().startsWith(prefix)) {
      const rest = label.slice(prefix.length);
      label = rest ? rest[0]?.toUpperCase() + rest.slice(1) : label;
    }
    connectors.set(key, [...(connectors.get(key) ?? []), label]);
  }
  return connectors;
}

/** How many apps this Bot holds tools on. For the summary on the Bot's page. */
export function connectorCount(plugins: GrantedPlugins): number {
  return connectorTools(plugins).size;
}

/** What this Bot may reach: your skills on it, everything granted to it, and who it may ask. */
export function AccessSections({ agent }: { agent: AgentProfile }) {
  // Every Bot has every connected app in the personal edition, so there is no switch per app here.
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  return (
    <>
      {agent.mine && !personal ? <YourApps agent={agent} /> : null}
      {agent.mine ? <YourSkills agentId={agent.id} /> : null}
      <Granted agentId={agent.id} mine={agent.mine} />
      {/* Every Bot can ask every other in the personal edition, so there is no switch per Bot. */}
      {personal ? null : <HandoffPanel agentId={agent.id} />}
    </>
  );
}

/**
 * Your own apps, one switch each: the ones you connected that an admin lets owners give, and any you
 * already gave this Bot. Only on your own Bot, for the reason the server gives — see
 * `server/src/plugins/owner-grants.ts`.
 *
 * WHAT A SWITCH GIVES is what an admin's one press gives: the app's read-only actions. Every call
 * runs on the asking person's own account, even after the Bot is published to the team, so the
 * description says "your" only about the person reading it.
 *
 * AN APP AN ADMIN GAVE THIS BOT is drawn switched on and locked. Taking it away is the admin's, and
 * the server would refuse it.
 */
function YourApps({ agent }: { agent: AgentProfile }) {
  const giveable = useQuery(giveableAppsQueryOptions());
  /*
   * AS THE OWNER (`?view=owner`): only then does the server answer `owner_grantable` for an app an
   * owner may give (X3). Read plainly, an owner's own Bot reads `not_granted`, and a switch drawn off
   * that would not know the app was theirs to give. The query key differs from the plain read's, so
   * "它能用什么" below keeps its own answer.
   */
  const held = useQuery(botAppsQueryOptions(agent.id, "owner"));
  const give = useMutation(giveBotAppMutationOptions(queryClient));
  const takeBack = useMutation(takeBackBotAppMutationOptions(queryClient));
  const error = give.error ?? takeBack.error;
  const busy = give.isPending || takeBack.isPending;
  if (giveable.isPending || held.isPending) return null;
  const states = new Map((held.data ?? []).map((app) => [app.key, app]));
  /*
   * What you could give, and then anything you already gave that no longer is — an account you
   * disconnected since, an app an admin closed to owners — so it can still be switched off here.
   */
  const rows: (GiveableApp & { access?: AppAccess })[] = [
    ...(giveable.data ?? []).map((app) => ({
      ...app,
      access: states.get(app.key),
    })),
    ...(held.data ?? [])
      .filter(
        (app) =>
          app.givenByOwner &&
          !(giveable.data ?? []).some((given) => given.key === app.key),
      )
      .map((app) => ({ ...app, access: app })),
  ];
  return (
    <PageSection
      description={`打开一个应用，${agent.name} 就能用它。它用的始终是正在找它的那个人自己的账号。`}
      title="你的应用"
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {giveable.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          读不到你的应用，请刷新页面。
        </p>
      ) : rows.length === 0 ? (
        <PageEmpty
          action={
            <Button
              render={(props) => <Link {...props} to="/connections" />}
              size="sm"
              variant="outline"
            >
              <IconPlug />
              连接
            </Button>
          }
          icon={IconApps}
          title="还没有可以给的应用"
        >
          连接一个应用，你的员工就能用它。
        </PageEmpty>
      ) : (
        <PageRows>
          {rows.map((app, index) => {
            const granted = app.access?.granted ?? false;
            const locked = granted && !app.access?.givenByOwner;
            const yours =
              app.account === "personal"
                ? `你的 ${app.displayName}`
                : app.displayName;
            return (
              <Fragment key={app.key}>
                {index > 0 ? <Separator /> : null}
                <Item data-app={app.key} size="sm">
                  <ItemMedia variant="icon">
                    <PluginLogo logo={app.logo} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{app.displayName}</ItemTitle>
                    <ItemDescription>
                      {locked
                        ? "管理员把它给了这位员工。"
                        : granted
                          ? `${agent.name} 能用${yours}。`
                          : `${agent.name} 不能用${yours}。`}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      aria-label={`让 ${agent.name} 使用 ${app.displayName}`}
                      checked={granted}
                      disabled={busy || locked}
                      onCheckedChange={(next) => {
                        give.reset();
                        takeBack.reset();
                        const variables = { agentId: agent.id, app: app.key };
                        if (next) give.mutate(variables);
                        else takeBack.mutate(variables);
                      }}
                    />
                  </ItemActions>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}
    </PageSection>
  );
}

/**
 * Your own skills, one switch each. Only on your own Bot: the server lets a person put their own
 * skill on a Bot they own, and neither half alone is enough.
 *
 * WHICH SKILLS ARE YOURS COMES FROM THE SKILLS PAGE; WHETHER THIS BOT CARRIES ONE, FROM THE BOT'S OWN
 * GRANTS (`GET /api/plugins/for/:agentId`, the read "What it can use" draws from too). That read is
 * where the personal edition gives a Bot every skill the first time it is listed, so it is what
 * gives a Bot made a moment ago its skills. The skills page, read alongside it or earlier, still said
 * the Bot had none, and every switch was drawn off until the page was opened again.
 */
function YourSkills({ agentId }: { agentId: string }) {
  const me = useQuery(currentUserQueryOptions()).data;
  const page = useQuery(pluginsPageQueryOptions());
  const held = useQuery(agentPluginsQueryOptions(agentId));
  const grant = useMutation(setPluginGrantMutationOptions(queryClient));
  const skills = (page.data?.skills ?? []).filter(
    (skill) => me && skill.ownerUserId === me.id,
  );
  const carried = new Set((held.data?.skills ?? []).map((skill) => skill.slug));
  return (
    <PageSection
      description="打开一个技能，就能让这位员工用它。在对话里输入 / 运行。"
      title="你的技能"
    >
      {grant.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {grant.error.message}
        </p>
      ) : null}
      {page.isPending || held.isPending ? null : page.error || held.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          读不到你的技能，请刷新页面。
        </p>
      ) : skills.length === 0 ? (
        <PageEmpty
          action={
            <Button
              render={(props) => <Link {...props} to="/capabilities/skills" />}
              size="sm"
              variant="outline"
            >
              <IconPlus />
              写一个技能
            </Button>
          }
          icon={IconBox}
          title="还没有技能"
        >
          你写的技能会出现在这里。
        </PageEmpty>
      ) : (
        <PageRows>
          {skills.map((skill, index) => (
            <Fragment key={skill.slug}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBox />
                </ItemMedia>
                {/* By its title, as What it can use names it below; the section says how to run it. */}
                <ItemContent>
                  <ItemTitle>{skill.title}</ItemTitle>
                  <ItemDescription>{skill.summary}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label={skill.title}
                    checked={carried.has(skill.slug)}
                    disabled={grant.isPending}
                    onCheckedChange={(granted) =>
                      grant.mutate({
                        agentId,
                        granted,
                        kind: "skill",
                        ref: skill.slug,
                      })
                    }
                  />
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/**
 * Everything this Bot holds, read from the same snapshot a run is offered, and what each app is for
 * the person looking.
 *
 * READ-ONLY FOR GRANTS, NOT FOR THE PERSON'S OWN PART. Apps are granted by an administrator, who gets
 * a link to where that is decided — or, on a Bot you own, by you, under Your apps above. But a Bot that holds Gmail is no use to somebody who has not
 * connected their Gmail, and this list used to say "Gmail · 4 tools" to everybody alike — so each
 * app now says what it is for the person reading (`GET /api/plugins/for/:agentId/apps`) with the one
 * thing they can do about it: Connect, Reconnect, Request access, or Requested. The state is the
 * server's and is drawn as it comes; see `AppAccessAction`.
 *
 * ADMINISTRATORS SEE THEIR OWN STATE HERE TOO, AND NOBODY ELSE'S. The app-access read answers for
 * whoever is asking, exactly as the connections read does, so this cannot become a list of who has
 * connected what.
 */
function Granted({ agentId, mine }: { agentId: string; mine: boolean }) {
  const me = useQuery(currentUserQueryOptions()).data;
  const edition =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition ?? "team";
  const plugins = useQuery(agentPluginsQueryOptions(agentId));
  const apps = useQuery(botAppsQueryOptions(agentId));
  // Both, so no row is drawn without its state and then redrawn with one a moment later.
  if (plugins.isPending || apps.isPending) return null;
  if (!plugins.data) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        读不到这位员工能用什么，请刷新页面。
      </p>
    );
  }
  const admin = me?.role === "admin";
  const tools = connectorTools(plugins.data);
  const states = apps.data ?? [];
  /*
   * Every app the Bot holds a grant for, by the app's own name, and then any connector the grant
   * snapshot names that the app-access read did not — which is none on a healthy deployment, and
   * keeps a row from vanishing on one where the second read failed.
   */
  const described = new Set(states.map((app) => app.key));
  const rest = [...tools.entries()].filter(([key]) => !described.has(key));
  const skills = plugins.data.skills;
  const count = states.length + rest.length + skills.length;
  return (
    <PageSection
      description="查看这位员工能用的应用和技能，以及哪些应用已经能用。不在这个列表里的应用和技能，它用不了。"
      title="它能用什么"
    >
      {apps.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          查不到每个应用对你来说能不能用，请刷新页面。
        </p>
      ) : null}
      {count === 0 ? (
        <PageEmpty icon={IconApps} title="还没有应用">
          {mine
            ? "在上面「你的应用」里打开一个，或者找管理员。在那之前，这位员工只能和你对话。"
            : "需要管理员添加。在那之前，这位员工只能和你对话。"}
        </PageEmpty>
      ) : (
        <PageRows>
          {states.map((app, index) => {
            const labels = tools.get(app.key) ?? [];
            return (
              <Fragment key={app.key}>
                {index > 0 ? <Separator /> : null}
                <Item data-app={app.key} data-state={app.state} size="sm">
                  <ItemMedia variant="icon">
                    <PluginLogo logo={app.logo} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{app.displayName}</ItemTitle>
                    {/*
                     * Unclamped: the sentence ends on who can fix it, and two lines at a phone's
                     * width cut exactly that off.
                     */}
                    <ItemDescription className="line-clamp-none">
                      {app.state === "ready"
                        ? [appAccessSentence(app, undefined, edition)]
                            .concat(labels.length > 0 ? [toolList(labels)] : [])
                            .join(" ")
                        : appAccessSentence(app, undefined, edition)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {app.state === "ready" ? (
                      <ToolCount count={labels.length} />
                    ) : (
                      <AppAccessAction access={app} agentId={agentId} />
                    )}
                    {admin ? (
                      <ManageLink
                        agentId={agentId}
                        appKey={app.key}
                        title={app.displayName}
                      />
                    ) : null}
                  </ItemActions>
                </Item>
              </Fragment>
            );
          })}
          {rest.map(([key, labels], index) => (
            <Fragment key={key}>
              {states.length + index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconApps />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{connectorName(key)}</ItemTitle>
                  <ItemDescription>{toolList(labels)}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <ToolCount count={labels.length} />
                  {admin ? (
                    <ManageLink
                      agentId={agentId}
                      appKey={key}
                      title={connectorName(key)}
                    />
                  ) : null}
                </ItemActions>
              </Item>
            </Fragment>
          ))}
          {skills.map((skill, index) => (
            <Fragment key={skill.slug}>
              {states.length + rest.length + index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBox />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{skill.title}</ItemTitle>
                  <ItemDescription>{skill.summary}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-sm">技能</span>
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/** The first few tool labels, and how many more. */
function toolList(labels: string[]): string {
  return `${labels.slice(0, 4).join("、")}${labels.length > 4 ? ` 等 ${labels.length} 个` : ""}`;
}

function ToolCount({ count }: { count: number }) {
  return (
    <span className="text-muted-foreground text-sm tabular-nums">
      {count} 个工具
    </span>
  );
}

/**
 * Where an administrator decides which of the app's tools this Bot holds.
 *
 * A CHEVRON OF ITS OWN RATHER THAN THE WHOLE ROW. The row used to be the link, which was right while
 * it held nothing else; now it can hold Connect or Request access, and a button inside a link is two
 * controls answering one click. The destination is unchanged.
 */
function ManageLink({
  agentId,
  appKey,
  title,
}: {
  agentId: string;
  appKey: string;
  title: string;
}) {
  const paths = useManagePaths();
  return (
    <Button
      aria-label={`管理这位员工的 ${title}`}
      render={<Link {...paths.pluginBot(appKey, agentId)} />}
      size="icon-sm"
      variant="ghost"
    >
      <IconChevronRight className="size-4 text-muted-foreground" />
    </Button>
  );
}
