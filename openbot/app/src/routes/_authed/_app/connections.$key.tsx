import {
  IconAppsOff,
  IconArrowUpRight,
  IconChevronDown,
  IconPlugOff,
  IconUsers,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { IdentityConnectionPage } from "@/components/connections/identity-connection-page";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { PluginPage } from "@/components/manage/plugin-page";
import {
  BrokeredAccountRow,
  NotConnected,
  useBrokeredAccount,
} from "@/components/plugins/brokered-account-row";
import { GrantList } from "@/components/plugins/grant-list";
import { RoutinesConnectionPage } from "@/components/routines/routines-connection-page";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { ALWAYS_ON_APP } from "@/lib/connections/rows";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useManagePaths } from "@/lib/manage-paths";
import {
  connectAccountMutationOptions,
  invalidatePlugins,
} from "@/lib/plugins/mutations";
import {
  brokeredProvenance,
  disconnectSiblingsNotice,
} from "@/lib/plugins/provider-vocabulary";
import {
  appKeyOf,
  connectionSiblingsQueryOptions,
  connectionsQueryOptions,
  type PluginServer,
  personalConnections,
  pluginsPageQueryOptions,
  pluginsProvider,
} from "@/lib/plugins/queries";
import { searchTextEntry } from "@/lib/search-text";

/**
 * Whether this server is reached through Composio AS THIS PERSON.
 *
 * A Shared app is also `provenance === "composio"` — it is still Composio that holds the account —
 * but there is no "your account" here to confirm: the one account is the deployment's, and every
 * Bot holding a grant acts as it regardless of who is asking. Exported so the test for this file can
 * pin the distinction without rendering the page.
 */
export function brokeredFor(server: PluginServer | undefined): boolean {
  /*
   * A FILTER, so it asks whether the row came through a broker at all and needs no vendor name: one
   * provider holds rows at a time (spec D3). Naming the vendor on this page is a different question
   * and reads the active provider, below.
   */
  return (
    server !== undefined &&
    brokeredProvenance(server.provenance) &&
    server.accountMode !== "shared"
  );
}

/** The longest action name this page will repeat back. Real ones are far shorter. */
const MAX_LANDED_ACTION = 200;

/**
 * The action the verifier's redirect says was just authorized, or null.
 *
 * A TRIMMED, BOUNDED NAME AND NOTHING ELSE: it is read off a query string, which anybody can write
 * on this origin, so it is only ever drawn as a quoted name inside this page's own sentence and
 * never as a sentence of its own.
 */
export function landedActionFrom(action: string | undefined): string | null {
  const trimmed = (action ?? "").trim();
  return trimmed.length > 0 && trimmed.length <= MAX_LANDED_ACTION
    ? trimmed
    : null;
}

/** What the landing says about the action somebody has just come back from authorizing. */
export function landedActionNotice(action: string): string {
  return `你刚刚授权了「${action}」。`;
}

/**
 * One service, and whether a Bot may read it as you.
 *
 * Its own page rather than a switch on the list, because what a connector needs from a person is not
 * fixed. Drive needs one consent and nothing else; a vendor that scopes access per workspace, or per
 * folder, or asks which of several accounts to use, needs somewhere to ask. This is that somewhere,
 * before there is anything to put in it.
 */
export const Route = createFileRoute("/_authed/_app/connections/$key")({
  component: RouteComponent,
  /*
   * `?linked=` is how the GitHub account-link callback reports back to GitHub's page: `github` on
   * success, `github-taken` when that account belongs to another OpenBot user, `failed` otherwise.
   *
   * `?action=` is the verifier's redirect saying WHICH action the consent just completed was for,
   * so an app's page can land on it rather than on the app.
   *
   * Each key is omitted when absent rather than set to undefined, which would make `search` a
   * required prop on every Link to this route. Read as text whatever the router parsed it into
   * (`searchText`): an action name made of digits or shaped like JSON arrives as a number or an
   * object, and a `typeof` guard would land the page on the app as though the verifier had never
   * said which action it was.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    linked?: string;
    action?: string;
    connect?: true;
    identity?: true;
  } => ({
    ...searchTextEntry("linked", search.linked),
    ...searchTextEntry("action", search.action),
    /*
     * `?identity=true` opens GitHub's or Slack's account-link page even where this deployment has
     * also enabled the app of the same name（熊宝的目录里有 `github`、`slack` 两个按提问者身份读取的应用，
     * 与上游只把这两个键当身份关联不同）。The tiles on Connections that link an account carry it.
     */
    ...(search.identity === true || search.identity === "true"
      ? { identity: true as const }
      : {}),
    /*
     * `?connect=true` is Browse apps sending somebody here to finish adding an app that takes a
     * key: the page opens with the key form. Read once and dropped, so a reload does not reopen it.
     */
    ...(search.connect === true || search.connect === "true"
      ? { connect: true as const }
      : {}),
  }),
});

/**
 * GitHub and Slack are accounts this deployment links to a person, not apps an administrator
 * enabled, so they have a page of their own; every other key is an app.
 */
function RouteComponent() {
  const { key } = Route.useParams();
  const { linked, action, connect, identity } = Route.useSearch();
  const plugins = useQuery(pluginsPageQueryOptions());
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  // Held for this visit, keyed on the app, and dropped from the address below.
  const [arrival] = useState(() => ({
    key,
    connect: connect === true,
    // Asked for the account link on arrival: the link page drops `?linked=` from the address once it
    // has read it, and the page must not flip to the app's page (losing the notice) when it does.
    identity: identity === true || linked !== undefined,
  }));
  const startConnect = arrival.key === key && arrival.connect;
  const navigate = Route.useNavigate();
  useEffect(() => {
    if (connect === undefined) return;
    navigate({ search: ({ connect: _c, ...rest }) => rest, replace: true });
  }, [connect, navigate]);
  if (key === "github" || key === "slack") {
    /*
     * TWO THINGS ANSWER TO THESE TWO NAMES HERE. Upstream has only the account link; this fork's
     * catalogue also has a `github` and a `slack` app reached as the person asking, and its consent
     * comes back to `/connections/<key>`. So the account link is drawn when asked for by name
     * (`?identity=true`, or the link callback's `?linked=`), or when no app by that name is enabled;
     * otherwise this is the app's page.
     */
    const appHere = (plugins.data?.servers ?? []).some(
      (server) => server.id === key || appKeyOf(server) === key,
    );
    if (
      identity === true ||
      linked !== undefined ||
      (arrival.key === key && arrival.identity) ||
      (plugins.data !== undefined && !appHere)
    ) {
      return <IdentityConnectionPage linked={linked} provider={key} />;
    }
    /* Otherwise the app's page, which waits for the same read and says so if it failed. */
  }
  // Routines has nothing to connect or switch: its page says what it is and leads to the routines.
  if (key === ALWAYS_ON_APP) return <RoutinesConnectionPage />;
  /*
   * The personal edition's app page is the whole app: turning it on, your account, its tools and
   * which Bots use them, because one person makes all of those decisions. A per-action
   * authorization (`?action=`) keeps its own page, which is what that flow comes back to.
   */
  if (personal && action === undefined)
    return <PluginPage pluginKey={key} startConnect={startConnect} />;
  return <AppConnectionPage startConnect={startConnect} />;
}

function AppConnectionPage({ startConnect }: { startConnect: boolean }) {
  const { key } = useParams({
    from: "/_authed/_app/connections/$key",
  });
  const { action } = Route.useSearch();
  const paths = useManagePaths();
  /*
   * `?action=` IS READ ONCE HERE AND DROPPED FROM THE URL BELOW, BUT IT FEEDS TWO THINGS.
   *
   * Its only sender is the per-action verifier's redirect (`server/src/plugins/routes.ts`), so it is
   * a report of a consent that has just completed — news exactly once. Left in the address bar it is
   * read again on every reload and back-navigation, and "You just authorized X" is redrawn about a
   * consent that may be hours old. That is the omission the Connections list closed for its own
   * three report parameters.
   *
   * It is NOT only the notice, though: the same value marks the matching row of the grant list with
   * `data-landed`, and that list draws only once its own read answers — which can be well after the
   * strip has landed. So the strip is safe only because BOTH readers draw from this snapshot, never
   * from the live search: read live, the notice would vanish with the parameter and the grant list
   * would come up with nothing marked. The mark is the same news as the notice, so it is right for
   * both to outlive the URL for this visit and for both to be gone on a reload.
   *
   * KEYED ON THE APP, so a snapshot taken on one app's page is never repeated on another's should the
   * router keep this component mounted across a change of `$key`.
   */
  const [arrival] = useState(() => ({
    key,
    landedAction: landedActionFrom(action),
  }));
  const navigate = Route.useNavigate();
  /*
   * ONE NAVIGATE, the same shape as the Connections list's: `search` replaces the whole object, so
   * a strip is written as dropping its keys from what is there and keeping the rest, never as a
   * rebuilt object. `linked` belongs to GitHub's page, which is not this one, so `action` is the
   * only one dropped.
   */
  useEffect(() => {
    if (action === undefined) return;
    navigate({ search: ({ action: _a, ...rest }) => rest, replace: true });
  }, [action, navigate]);
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const connect = useMutation({
    ...connectAccountMutationOptions(),
    onError: (thrown: Error) => setNotice(thrown.message),
    /*
     * A full page navigation, not a fetch. The consent screen is the vendor's own and has to be shown
     * to you in your own browser; there is deliberately nothing here that could complete it for you.
     */
    onSuccess: (start) => {
      /*
       * `{ connected: true }`（X8）：厂商已经持有这个应用要的全部权限，路由在这次按下时就记下了连接，
       * 没有页面要去。不报错、不跳转，重读插件查询，这一页从记下的那一行画出「已连接」。上游把它当成
       * 这一半看不懂的回答报错；熊宝照实画已连接。
       */
      if (start !== null && "connected" in start) {
        void invalidatePlugins(queryClient);
        return;
      }
      /*
       * A 200 with no url on it is not a url to follow. Every press that reaches here is on a
       * `user-oauth` catalogue entry, whose half of that route always mints one or refuses — so
       * this is the server having answered something this page does not understand, and saying so
       * is the only honest thing left. Assigning it navigated to a page called `undefined` on this
       * deployment's own origin. See `connectAccountMutationOptions`.
       */
      const authorizationUrl = start?.authorizationUrl ?? null;
      if (authorizationUrl === null) {
        setNotice(
          "部署的回应里没有授权链接，所以没法带你过去，也没有连接任何东西。请重试；如果一直这样，请告诉管理员。",
        );
        return;
      }
      window.location.href = authorizationUrl;
    },
  });

  /*
   * OPENED BY ROW ID OR BY CATALOGUE KEY（熊宝 G01-E）。A curated connector added for the team is the
   * row `team:<catalogue key>`, while the catalogue and old links name the key, and a connection names
   * the row. Either finds the row; the catalogue entry is then looked up by the row's own app key.
   */
  const server = (plugins.data?.servers ?? []).find(
    (s) => s.id === key || appKeyOf(s) === key,
  );
  const appKey = server ? appKeyOf(server) : key;
  const entry = plugins.data?.catalogue.find((item) => item.key === appKey);
  const enabled = server !== undefined;
  /*
   * READ THROUGH `personalConnections`, never the raw list: a Shared app's row is the deployment's
   * one standing account, not this person's, and `find` over the unfiltered rows would have handed
   * it to this page as if it were.
   */
  const connection = personalConnections(
    connections.data?.connections ?? [],
  ).find((row) => row.serverId === (server?.id ?? key));
  /*
   * Asked of the row rather than the catalogue, because a brokered app has no catalogue entry at
   * all: the deployment recorded how it is reached when the app was enabled, and that record is the
   * only thing here that knows.
   */
  const brokered = brokeredFor(server);
  /*
   * THE VENDOR'S NAME, from the active provider and never from a row: a deployment with the key set
   * and nothing enabled has no row, and a row cannot say which broker holds the account.
   */
  const provider = pluginsProvider(plugins.data);
  /*
   * WHAT A DISCONNECT WOULD ALSO END, asked only while there is an account for it to end. The query
   * is gated on the connection and its answer is read only through the same gate, so a cached answer
   * from before a disconnect is never drawn beside "Connect".
   */
  const siblings = useQuery({
    ...connectionSiblingsQueryOptions(key),
    enabled: brokered && connection !== undefined,
  });
  const siblingsNotice =
    brokered && connection !== undefined && siblings.data
      ? disconnectSiblingsNotice(siblings.data)
      : null;
  /* From the snapshot above and never from the live search, which is stripped. */
  const landedAction = arrival.key === key ? arrival.landedAction : null;
  /*
   * THE GRANT LIST IS DRAWN WHERE THE BROKER AUTHORIZES PER ACTION, read off the declared
   * capability and never off the vendor's name. The server computes `authorizesPerAction` from the
   * same expression `/servers/:id/authorize` behind the Authorize button gates on, so the list this
   * screen draws and the route its buttons call cannot key on different facts. `provider ===
   * "arcade"` keyed on a different one: the day a broker named arcade is reached with that flow
   * absent, this drew the list and every press 503'd. False on Composio — whose auth config fixes
   * one state for the whole toolkit — so every Composio render is unchanged.
   */
  const perActionGrants = plugins.data?.authorizesPerAction ?? false;
  /* Who is asking only matters to a Shared app's Authorize, so it is not read for anything else. */
  const sharedHere = server?.accountMode === "shared";
  /*
   * Also read for an app only an administrator connects（fork 的 `adminConnectOnly`）: a member is
   * told an administrator has to connect it rather than offered a Connect the server refuses.
   */
  const me = useQuery({
    ...currentUserQueryOptions(),
    enabled:
      (perActionGrants && sharedHere) || server?.adminConnectOnly === true,
  }).data;
  const isAdmin = me?.role === "admin";
  const appNames = [key, server?.title ?? key];

  /* Everything the brokered row below reads and does. See `brokered-account-row.tsx`. */
  const brokeredAccount = useBrokeredAccount({
    authScheme: server?.authScheme ?? null,
    /* The same capability the grant list below is drawn on: a broker that approves per action takes
       a consent over the connection that stands. */
    reconnectsInPlace: perActionGrants,
    brokered,
    configured: plugins.data?.composioConfigured ?? false,
    recorded: connection !== undefined,
    report: setNotice,
    returnTo: "settings",
    serverId: key,
    /*
     * Off the same row `recorded` is read from, and absent where you have never connected this app:
     * with no row there is nothing that could have been checked, which is what the server's own
     * columns default to. The three are optional on the type because that endpoint concatenates two
     * reads and only a brokered row carries them.
     */
    verified: connection?.verified ?? false,
    verifiedAt: connection?.verifiedAt ?? null,
    /*
     * PASSED THROUGH UNFLATTENED, unlike the two above. Their fallbacks are the server's own column
     * defaults, so an absent field and a recorded one mean the same thing; this one's null is the
     * server saying the last check of this key spent nothing, which is a different fact from having
     * been told nothing. Collapsing the two would hand the row a verdict on every page load that
     * has no record behind it.
     */
    probe: connection?.probe,
    /*
     * AND THIS ONE IS FLATTENED AGAIN, because it is a gate and not a verdict. `probe` is the
     * record of what the last check spent and this is whether the app has anything to check with
     * today — two questions, which is why they are two fields: gating the Re-check button on the
     * record left a key nothing was ever spent on unable to ever have anything spent on it. A
     * missing gate and a closed gate are the same gate, so absent collapses to false here where a
     * missing verdict above may not collapse to a null one.
     */
    checkable: connection?.checkable ?? false,
  });

  /*
   * BOTH READS ARE WAITED FOR, BECAUSE EVERY FACT THE BROKERED ROW BELOW DRAWS COMES FROM THE SECOND
   * ONE. `recorded`, `verified`, `verifiedAt`, `probe` and `checkable` are all off `connection`,
   * and this gated on `plugins` alone — so a connections read still in flight drew the row with the
   * whole of its state defaulted to "you have never connected this".
   */
  if (plugins.isPending || connections.isPending) {
    return <PageShell title="账号">{null}</PageShell>;
  }

  const back = {
    label: "全部连接",
    linkProps: { to: "/connections" as const },
  };

  /*
   * AND A CONNECTIONS READ THAT FAILED IS SAID RATHER THAN DEFAULTED, WHICH IS WHAT THIS PAGE DID
   * WITH IT.
   *
   * Nothing read `connections.error`, so a 500 from `/api/plugins/connections` left `connection`
   * undefined and the row was handed `recorded: false, verified: false, probe: undefined,
   * checkable: false` — a connection nobody has made. For a brokered key app whose last check did
   * not come back clean, that is the exact state this whole feature exists to keep visible: the page
   * dropped the sentence, hid Disconnect AND Re-check, and drew Connect instead. Pressing it opens
   * the form and the route refuses the submission — "you already have an account, disconnect it
   * first" — so the only two controls that could end the state are the two the page just withdrew,
   * and no error text appears anywhere, because `connect.onError` is this route's only error branch.
   *
   * SAID BEFORE THE ROW RATHER THAN INSTEAD OF IT, and the row is not drawn at all: a row whose
   * entire content is connection state has nothing honest to say when that state could not be read.
   */
  if (connections.error) {
    return (
      <PageShell backButton={back} title={server?.title ?? key}>
        <p className="mt-12 text-destructive text-sm" role="alert">
          读不到这个连接，所以这里什么都不显示，免得显示错的。请刷新页面；如果一直这样，请告诉管理员。
        </p>
      </PageShell>
    );
  }

  /*
   * The same for the plugin list. Every branch below decides what this connector is from it, and
   * without it they concluded there is none: "This is not a service you connect for yourself",
   * about a connector this person may hold right now.
   */
  if (!plugins.data) {
    return (
      <PageShell backButton={back} title={key}>
        <p className="mt-12 text-destructive text-sm" role="alert">
          读不到这个应用。请刷新页面；如果一直这样，请告诉管理员。
        </p>
      </PageShell>
    );
  }

  /*
   * A COMPOSIO APP ON A DEPLOYMENT WITH NO COMPOSIO KEY, BEFORE EITHER BRANCH BELOW DRAWS A ROW.
   *
   * The list on the way in no longer offers one, but a link from elsewhere still lands here, and the
   * brokered row's own sentence for this case names an environment variable — an instruction for
   * whoever runs the deployment, read by somebody who cannot act on it.
   */
  if (server?.provenance === "composio" && !plugins.data.composioConfigured) {
    return (
      <PageShell backButton={back} title={server.title}>
        <PageEmpty icon={IconPlugOff} title="还没有设置">
          管理员要先打开 {server.title}，大家才能连接它。
        </PageEmpty>
      </PageShell>
    );
  }

  /*
   * A SHARED APP, BEFORE THE BROKERED BRANCH BELOW GETS A LOOK AT IT.
   *
   * `brokered` above already reads false for one of these — `brokeredFor` is what pulls a Shared
   * app out of that branch — so without one of its own here it would fall all the way to the
   * `user-oauth` branch and draw "Your account" with a Connect button over an account that is not
   * this person's to connect, confirm or disconnect. There is nothing to decide: the account is the
   * deployment's, every Bot holding a grant already acts as it, and this page says so and stops.
   */
  if (server?.accountMode === "shared") {
    return (
      <PageShell backButton={back} title={server.title}>
        {/*
         * THE LANDING NOTICE BELONGS HERE TOO, because a Shared app's account is the deployment's
         * and the verifier lands BOTH holders on this page. Without it the one flow whose Authorize
         * is admin-only completed a consent at the vendor and came back to a screen that named
         * nothing — the grant list's mark alone, several rows down a search box, is not the page
         * saying what just happened.
         */}
        {landedAction ? (
          <p
            className="text-sm"
            data-landed-action={landedAction}
            role="status"
          >
            {landedActionNotice(landedAction)}
          </p>
        ) : null}

        {/* One fact, so no heading and no actions: there is nothing here for this person to do. */}
        <PageSection>
          <PageRows className="mt-0">
            <Item size="sm">
              <ItemContent>
                <ItemTitle>团队账号</ItemTitle>
                <ItemDescription>
                  由组织共用。员工以团队账号的身份行事。
                </ItemDescription>
              </ItemContent>
            </Item>
          </PageRows>
        </PageSection>

        {/* State is shown to everyone; minting a consent is the administrator's act. */}
        {perActionGrants ? (
          <GrantList
            appNames={appNames}
            canAuthorize={isAdmin}
            landedAction={landedAction}
            returnTo="settings"
            serverId={key}
          />
        ) : null}
      </PageShell>
    );
  }

  /*
   * A brokered app, before the catalogue is consulted at all.
   *
   * It has no catalogue entry, so the branch below would find no `entry`, decide the deployment has
   * no connector by that name, and say so under the raw id — about the one connector the list on the
   * way in demonstrably drew a row for. Falling through to the `user-oauth` branch instead is no
   * better: its title and summary are the catalogue's, and there is none.
   */
  /*
   * AN APP THAT CAN ONLY HOLD A SHARED ACCOUNT, NOT YET MADE SHARED. It signs in with this
   * deployment's own client, so there is no account here that is this person's: the server refuses
   * a personal Connect, and this page draws none. Read off the listing's `sharedOnly`, never off the
   * app's name. The list on the way in leaves it out; a link from elsewhere still lands here.
   */
  if (brokered && server?.sharedOnly) {
    return (
      <PageShell
        backButton={back}
        description="这个应用不需要你自己连接。"
        title={server.title}
      >
        <PageEmpty icon={IconUsers} title="只能作为团队账号">
          管理员把 {server.title} 作为团队账号连接一次，再把它给员工。
        </PageEmpty>
      </PageShell>
    );
  }

  if (brokered && server) {
    /* Bound once because the row below is told it twice — once inside the whole disconnected
       sentence and once on its own — and two copies of it would drift. */
    const reassurance = "没有员工能以你的身份使用它。";
    /* Where the next step is. Connect asks for the whole app on every broker. Where the broker also
       approves one action at a time, the action list underneath is the other way in, and the
       sentence names both. */
    const trip = perActionGrants
      ? `连接时会带你到 ${server.title} 那边授权。你也可以在下面只授权你想要的动作。`
      : `连接时会带你到 ${server.title} 那边授权。`;

    return (
      <PageShell
        backButton={back}
        description="员工以你的身份使用它，只能看到你能看到的东西。"
        title={server.title}
      >
        {notice ? (
          <p className="break-words text-destructive text-sm" role="alert">
            {notice}
          </p>
        ) : null}

        {landedAction ? (
          <p
            className="text-sm"
            data-landed-action={landedAction}
            role="status"
          >
            {landedActionNotice(landedAction)}
          </p>
        ) : null}

        {/* One decision, so no heading: it would only repeat the row's own title. */}
        <PageSection>
          <PageRows className="mt-0">
            <BrokeredAccountRow
              account={brokeredAccount}
              edition={paths.edition}
              reader="person"
              startConnect={startConnect}
              /* Said beside the button rather than after it: disconnecting ends the account at
                 Composio, so what it undoes is not the row here but the grant on your own mailbox,
                 and connecting again is a fresh consent. */
              connectedDescription={`你允许的员工会以你的身份使用你的 ${server.title}。断开会在所有地方收回它们的访问。`}
              disconnectedDescription={`${reassurance} ${trip}`}
              /* What is true either way. The trip to Composio is not — an app whose key somebody
                 types never leaves this page — but which Bots can read this person's mail is the
                 whole point of the screen and holds for both kinds. */
              disconnectedReassurance={reassurance}
              needsAdmin={server.adminConnectOnly === true && !isAdmin}
              notice={siblingsNotice ?? undefined}
              provider={provider}
              title={server.title}
            />
          </PageRows>
        </PageSection>

        {perActionGrants ? (
          <GrantList
            appNames={appNames}
            canAuthorize
            landedAction={landedAction}
            returnTo="settings"
            serverId={key}
          />
        ) : null}
      </PageShell>
    );
  }

  /*
   * A vendor that is not reached as a person has nothing here for anybody to decide, and one an
   * administrator has not enabled cannot be consented to — there is no OAuth client behind it. Both
   * say which it is rather than drawing a switch that cannot work.
   */
  if (entry?.auth !== "user-oauth") {
    return (
      <PageShell
        backButton={back}
        description="这个应用不需要你自己连接。"
        title={entry?.title ?? key}
      >
        <PageEmpty
          icon={entry ? IconUsers : IconAppsOff}
          title={entry ? "团队账号" : "找不到这个应用"}
        >
          {entry
            ? "员工用这个应用的一个团队账号，所有人都一样。"
            : "熊宝没有叫这个名字的应用。"}
        </PageEmpty>
      </PageShell>
    );
  }

  return (
    <PageShell
      backButton={back}
      description={entry.summary}
      title={entry.title}
    >
      {notice ? (
        <p className="break-words text-destructive text-sm" role="alert">
          {notice}
        </p>
      ) : null}

      {/* One decision, so no heading: it would only repeat the row's own title. */}
      <PageSection>
        <PageRows className="mt-0">
          <Item size="sm">
            <ItemContent>
              {/* Not "Connect your account": the row is also the connected state, and a title has to
                  read for both. */}
              <ItemTitle>你的账号</ItemTitle>
              <ItemDescription>
                {!enabled
                  ? "暂时还不能用。管理员要先打开它。"
                  : connection
                    ? "你允许的员工会以你的身份使用它，只能看到你能看到的东西。"
                    : `没有员工能以你的身份使用它。连接时会带你到 ${entry.vendor} 那边授权。`}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {connection ? (
                /*
                 * A state and a menu, not a switch. Connected is a fact about a grant that lives at
                 * the vendor, and withdrawing it is a deliberate act rather than the other half of a
                 * position — so it is named in a menu instead of being whatever happens when
                 * something slides back.
                 */
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button size="sm" type="button" variant="outline">
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-emerald-500"
                        />
                        已连接
                        <IconChevronDown />
                      </Button>
                    }
                  />
                  {/*
                   * `w-auto`, because the default is `w-(--anchor-width)` — the width of the trigger,
                   * which here is a small "Connected" button. Left alone, the one item inside wraps
                   * onto three lines and a destructive action becomes hard to read at the moment it
                   * most needs to be legible.
                   */}
                  <DropdownMenuContent align="end" className="w-auto">
                    <DropdownMenuItem
                      onClick={() =>
                        /*
                         * NOT BUILT YET, and it says so rather than appearing to work.
                         *
                         * Withdrawing is three acts — revoke at the vendor, revoke the vault
                         * credential, delete the row — and none exist. An item that closed the menu
                         * and changed nothing would report that access had been withdrawn when it
                         * had not, which is the one outcome worse than not offering it.
                         */
                        setNotice(
                          `断开功能还没有做好。在那之前，请到你的 ${entry.vendor} 账号的第三方访问设置里撤销熊宝的授权——这样会立刻停止访问。`,
                        )
                      }
                      className="whitespace-nowrap"
                      variant="destructive"
                    >
                      断开你的 {entry.title} 账号
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <>
                  {enabled ? <NotConnected /> : null}
                  {/*
                   * The arrow says this leaves OpenBot. It does: the next thing on screen is the
                   * vendor's own consent page, and a control that navigates away should look like one.
                   */}
                  <Button
                    disabled={!enabled || connect.isPending}
                    onClick={() => {
                      setNotice(null);
                      // The catalogue key: the consent route looks the vendor up by it.
                      connect.mutate(appKey);
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    连接
                    <IconArrowUpRight />
                  </Button>
                </>
              )}
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      {connection ? (
        <PageSection
          description={`以 ${entry.vendor} 记录的权限为准。它们可能比熊宝申请的少。`}
          title="访问权限"
        >
          <PageRows>
            <Item size="sm">
              <ItemContent>
                <ItemTitle>已授予</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {connection.scope || `${entry.vendor} 没有列出任何权限范围。`}
                </ItemDescription>
              </ItemContent>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemContent>
                <ItemTitle>已连接</ItemTitle>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground text-xs">
                  {new Date(connection.connectedAt).toLocaleString("zh-CN")}
                </span>
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}
    </PageShell>
  );
}
