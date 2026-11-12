import {
  IconArrowUpRight,
  IconChevronRight,
  IconExternalLink,
  IconPuzzle,
  IconTool,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useState } from "react";
import { ASK_FIRST_TITLE } from "@/components/approvals/ask-first-copy";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { AccessRequestsSection } from "@/components/plugins/access-requests";
import { AccountModeDialog } from "@/components/plugins/account-mode-dialog";
import {
  BrokeredAccountRow,
  NotConnected,
  useBrokeredAccount,
} from "@/components/plugins/brokered-account-row";
import { SharedApprovalFields } from "@/components/plugins/shared-approval-fields";
import { SkippedToolsNotice } from "@/components/plugins/skipped-tools-notice";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { grantRoster } from "@/lib/agents/grant-roster";
import { grantSummary } from "@/lib/agents/grant-summary";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { shortName } from "@/lib/brand";
import { ALWAYS_ON_APP } from "@/lib/connections/rows";
import { storeMcpToken } from "@/lib/credentials/mutations";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { atStart, useManagePaths } from "@/lib/manage-paths";
import {
  type CrewGrantOutcome,
  crewMembers,
  crewSummary,
  grantToMembers,
} from "@/lib/plugins/crew-grant";
import {
  addCuratedServerMutationOptions,
  connectAccountMutationOptions,
  invalidatePlugins,
  refreshPluginServerMutationOptions,
  registerOAuthClientMutationOptions,
  removePluginServerMutationOptions,
  replaceServerTokenMutationOptions,
  setOwnerGrantsMutationOptions,
} from "@/lib/plugins/mutations";
import {
  brokeredConnectionDescription,
  brokeredDisconnectNote,
  brokeredProvenance,
  brokeredReach,
} from "@/lib/plugins/provider-vocabulary";
import {
  appKeyOf,
  type CatalogueItem,
  connectionsQueryOptions,
  ownerGrantsQueryOptions,
  type PluginConnection,
  type PluginServer,
  personalConnections,
  pluginsPageQueryOptions,
  pluginsProvider,
} from "@/lib/plugins/queries";
import {
  botSharedAppsQueryOptions,
  describeApproval,
  type SharedUseApproval,
} from "@/lib/plugins/shared-use";
import { toolInWords, toolName } from "@/lib/plugins/tool-words";
import { toolsListError } from "@/lib/plugins/tools-error";
import { useZh } from "@/lib/translations/queries";
import { wakerGroupsQueryOptions } from "@/lib/waker-groups/queries";

/**
 * One vendor: what it needs from this deployment, and which Bots hold its tools.
 *
 * Its own page because what a connector needs configured differs by vendor and does not fit on a
 * row. A token for one, an OAuth client and a redirect URI for another, an instance hostname for a
 * third, and then a grant per tool per Bot. The screen this replaced tried to hold all of that in a
 * list and grew a column per Bot, which is how a grant goes unread.
 *
 * Drawn under Admin in the team edition and under Settings in the personal one: see `manage-paths`.
 */

/** Which of the four dialogs is open, or none. */
type OpenDialog = "token" | "client" | "instance" | "grant" | null;

/** The set with one member toggled, as a new set so React sees the change. */
function toggled(
  set: ReadonlySet<string>,
  member: string,
): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(member)) next.add(member);
  return next;
}

/**
 * How much of this vendor one Bot holds, in the same voice as `grantSummary`.
 *
 * The same decision counted the other way round, for the rows that open a Bot's own page against
 * this app. Named ends rather than a fraction, for the reason recorded above: "0/167" reads as a
 * score, and the two answers worth recognising without reading are none of it and all of it.
 */
function heldSummary(held: number, total: number): string {
  if (held === 0) return "没有工具";
  if (held === total) return total === 1 ? "1 个工具" : "全部工具";
  return `${held} / ${total} 个工具`;
}

/**
 * One Bot's standing with the shared account behind THIS app, read off its own exposure.
 *
 * Nothing when the Bot does not hold this app at all — `sharedAppsHeldBy` only lists apps a Bot has
 * at least one grant on, so there is no shared account for it to stand with yet — and nothing while
 * the fetch is still open, so no stale answer flashes ahead of the real one. "Not approved" matches
 * the word the shared-use inbox uses for the same absence (`shared-use-requests.tsx`), so an
 * administrator reads the same two words for the same fact wherever it comes up.
 */
function BotApprovalText({
  botId,
  serverId,
}: {
  botId: string;
  serverId: string;
}) {
  const exposure = useQuery(botSharedAppsQueryOptions(botId));
  const app = exposure.data?.apps.find((one) => one.serverId === serverId);
  if (!app) return null;
  return (
    <span className="text-muted-foreground text-xs">
      {app.approval ? describeApproval(app.approval) : "未批准"}
    </span>
  );
}

/**
 * One tool's row content in the personal edition: its words, as Activity names the same tool, and
 * the first sentence of what it does. Admin keeps the stored name. See `toolInWords`.
 */
function ToolInWords({
  serverId,
  tool,
}: {
  serverId: string;
  tool: { name: string; description: string };
}) {
  const { label, summary } = toolInWords(serverId, tool);
  return (
    <>
      <ItemTitle>{label}</ItemTitle>
      {summary ? <ItemDescription>{summary}</ItemDescription> : null}
    </>
  );
}

/**
 * An app's tools in the order its page lists them. In the personal edition, by the names the page
 * shows ("Get IMAP settings" under G), not by the stored names they arrive sorted by, which put it
 * under S as `GMAIL_SETTINGS_GET_IMAP`. Admin keeps the stored order beside the stored names.
 */
function listedTools<T extends { name: string }>(
  tools: readonly T[],
  personalApp: string | null,
): readonly T[] {
  if (personalApp === null) return tools;
  return tools
    .map((tool) => ({ tool, name: toolName(personalApp, tool.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ tool }) => tool);
}

/**
 * How this vendor is reached, from whichever record we have.
 *
 * The row's own provenance is asked first because it is a fact this deployment recorded when the
 * app was enabled, not an inference: a brokered app is reached through Composio whatever the
 * catalogue does or does not say about it.
 *
 * That order matters because the catalogue has nothing to say about a brokered app — it is not a
 * curated entry — and what stood here was `entry?.auth ?? "deployment-bearer"`: a guess, and the
 * one guess that is wrong for the one row shape that cannot hold a token. The page then offered
 * "one credential, used for everybody" to the connector whose whole point is that each person
 * connects their own account, and would have stored a token nothing ever reads.
 *
 * A server an administrator added by URL is still the fallback's case, and still correct there,
 * unless it was marked with an Entra scope. Then each call carries a token Microsoft Entra issues
 * for the person asking, so it is reached as that person and has no token to paste: the shared-token
 * shape would say the opposite of what it does.
 */
export function connectionKindFor(
  server: PluginServer | undefined,
  auth: CatalogueItem["auth"] | undefined,
): CatalogueItem["auth"] | "brokered" | "person-entra" {
  if (server && brokeredProvenance(server.provenance)) return "brokered";
  if (server?.entraScope) return "person-entra";
  return auth ?? "deployment-bearer";
}

/**
 * 团队账号连上之后的那句话。
 *
 * X7 安全评审后，团队账号行（`holder: "deployment"`）的 `displayName`（vendor 那边的账号名）和
 * `connectedBy`（谁连的）只给持有管理员能力的人，其余人拿到 null。拿到 null 时不写「账号是 …」，也不留
 * 空白，只说「团队账号」；拿到哪个就说哪个。
 */
export function teamAccountConnectedDescription(
  row: Pick<PluginConnection, "displayName" | "connectedBy"> | undefined,
): string {
  const name = row?.displayName?.trim();
  const by = row?.connectedBy?.trim();
  return `已连接${name ? `，团队账号是 ${name}` : "团队账号"}${by ? `，由 ${by} 连接` : ""}。拿到这些工具的每位员工都以这个账号行事。`;
}

/**
 * A row whose whole content is connection state, standing in for it when it could not be read.
 *
 * DRAWN BY BOTH ROWS THAT READ `/api/plugins/connections` — the brokered account and the
 * `user-oauth` one — because the defaulting they suffer from is the same and so is the honest
 * answer to it. Neither is drawn on a deployment-token server, which has no connection state to
 * fail on.
 *
 * IN THE ROW'S OWN PLACE, so the card keeps its shape and the sentence sits where the thing it is
 * about would have been. What it must not say is anything about whether an account exists: the
 * whole defect is that a failed read defaulted to "not connected", and a second sentence guessing
 * in the other direction would be the same mistake with better manners.
 *
 * `role="alert"` rather than plain text, because this appears in place of a row that carried
 * buttons — somebody reading with a screen reader has to be told the controls are gone and why,
 * not left to notice their absence.
 */
function ConnectionStateUnreadable() {
  const paths = useManagePaths();
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>你的账号</ItemTitle>
        <ItemDescription role="alert">
          读不到你是否在这里连接过账号，所以这里什么都不显示，免得显示错的。请刷新页面；如果一直这样，请查看
          {paths.deploymentName}的日志。
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

export function PluginPage({
  pluginKey: key,
  startConnect = false,
}: {
  pluginKey: string;
  /** Open the key form on arrival, for an app Browse apps just added that takes a key. */
  startConnect?: boolean;
}) {
  const paths = useManagePaths();
  /* 熊宝：目录里的标题、简介和工具说明按界面语言翻成中文（服务端存的仍是原文）。 */
  const zh = useZh();
  // One person: adding and connecting are one step, and nothing here is about other people.
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  // Routines is on for every Bot in every edition and has no off switch. See personal-defaults.ts.
  const alwaysOn = key === ALWAYS_ON_APP;
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const provider = pluginsProvider(plugins.data);
  /*
   * OPENED BY ROW ID OR BY CATALOGUE KEY（熊宝 G01-E）。A curated connector added for the team is the
   * row `team:<catalogue key>`, while links into this page and the catalogue name the key. Either
   * finds the row; the catalogue entry is then looked up by the row's own app key, never by whatever
   * string happened to be in the address.
   */
  const server = plugins.data?.servers.find(
    (item) => item.id === key || appKeyOf(item) === key,
  );
  const appKey = server ? appKeyOf(server) : key;
  const entry = plugins.data?.catalogue.find((item) => item.key === appKey);
  /* The row's own id, for every write against the row once there is one. */
  const rowId = server?.id ?? key;
  /*
   * The workspace's crews, for the grant dialog: a crew is a way to say which coworkers, not a holder
   * of anything itself — pressing one ticks its members, and each member gets its own grant.
   */
  const crews = useQuery(wakerGroupsQueryOptions());
  /*
   * The administrator's OWN connections, not the deployment's.
   *
   * On an admin screen that is a deliberate mixture, and it is the useful one: setting a per-person
   * connector up and finding out whether it works are two different questions, and the second has no
   * answer anywhere on this page without it. Nobody else's connection is readable here — the endpoint
   * only ever returns the caller's, so this cannot become a list of who has connected what.
   */
  const connections = useQuery(connectionsQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  /* The ones this person has hidden, so a grant one of them holds is still on this page. */
  const { data: hiddenAgents } = useQuery(agentListQueryOptions(true));
  /*
   * The row itself rather than whether there is one, because the brokered row below wants what the
   * last re-check found and that is written on this same row. Asking a second time for it would be
   * a second answer to a question this read already carried.
   *
   * ONLY THIS PERSON'S OWN ROWS. A Shared app's deployment row arrives on the same read, and taking
   * it for "you connected" would tell an administrator their own account is live when the one live
   * account is the team's.
   */
  const connection = personalConnections(
    connections.data?.connections ?? [],
  ).find((row) => row.serverId === (server?.id ?? key));
  const youConnected = connection !== undefined;
  /*
   * A CONNECTIONS READ THAT FAILED IS SAID RATHER THAN DEFAULTED, AND ONLY WHERE IT IS READ.
   *
   * Nothing read `connections.error` at all, so a 500 from `/api/plugins/connections` degraded an
   * account whose last check did not come back clean to "not connected" — dropping the sentence and
   * withdrawing both Re-check and Disconnect — with no error text anywhere on the page.
   *
   * WITHHELD PER ROW RATHER THAN PER PAGE, which is the difference between this screen and the
   * personal one. There, the page's entire content IS connection state, so drawing nothing is the
   * honest whole answer. Here the page also carries the tools, the grants, Refresh and Remove, none
   * of which touch this read — and a deployment-token server has no connection state on it at all.
   * Collapsing the page on this error took an administrator's Remove button away at the exact
   * moment something was failing, for every plugin in the deployment rather than only the two kinds
   * that read this.
   *
   * BOTH KINDS THAT READ IT, not just the brokered one: the `user-oauth` "Your account" row derives
   * its whole sentence and its Connect button from {@link youConnected}, which is the same defaulted
   * `false` the brokered row was getting.
   */
  const connectionsUnreadable = connections.error !== null;

  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  /** Which way the mode-switch confirmation is asking, or null while it is closed. */
  const [modeTarget, setModeTarget] = useState<"personal" | "shared" | null>(
    null,
  );
  const [token, setToken] = useState("");
  const [instanceHost, setInstanceHost] = useState("");
  const [client, setClient] = useState({ clientId: "", clientSecret: "" });
  /** Who gets the tools, and which, while the grant dialog is open. */
  const [selectedBots, setSelectedBots] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [selectedRefs, setSelectedRefs] = useState<ReadonlySet<string>>(
    new Set(),
  );
  /**
   * How far through a batch of grants we are, or null when none is running.
   *
   * A count rather than a boolean because a bulk grant is honestly N writes: a Bot times twelve
   * tools is twelve requests, and a button that says only "Granting…" for the length of them gives
   * an administrator no way to tell a slow batch from a stuck one.
   */
  const [granting, setGranting] = useState<{
    done: number;
    total: number;
  } | null>(null);
  /*
   * Who the last grant batch could not reach, each with the server's reason. A crew is several
   * people, and "2 refused" does not say which two, so the dialog names them.
   */
  /*
   * On a Shared app, who may use the team account through each Bot granted here. Sent with every
   * grant, because the server records no shared-use approval on its own（X7）and a Bot granted the
   * team account's actions without one is refused on every call.
   */
  const [sharedApproval, setSharedApproval] = useState<SharedUseApproval>({
    audience: "team",
    outsideInput: false,
    members: [],
  });
  const [refusals, setRefusals] = useState<{
    text: string;
    members: { agentId: string; line: string }[];
  } | null>(null);

  /* Every write reports into one banner rather than each growing its own handler. */
  const report = { onError: (thrown: Error) => setError(thrown.message) };
  const addCurated = useMutation({
    ...addCuratedServerMutationOptions(queryClient),
    ...report,
  });
  const registerClient = useMutation({
    ...registerOAuthClientMutationOptions(queryClient),
    ...report,
  });
  const replaceServerToken = useMutation({
    ...replaceServerTokenMutationOptions(queryClient),
    ...report,
  });
  const refresh = useMutation({
    ...refreshPluginServerMutationOptions(queryClient),
    ...report,
  });
  const ownerGrants = useMutation({
    ...setOwnerGrantsMutationOptions(queryClient),
    ...report,
  });
  /*
   * WHO MAY GIVE IT, OFF THE LISTING WHEN IT SAYS AND OFF ITS OWN ROUTE WHEN IT DOES NOT. The listing
   * carries `ownerGrants` once the plugin session's X7 lands; until then the X3 route answers the
   * same question, so the switch never draws "off" over an app whose owners can in fact give it.
   */
  const ownerGrantsRead = useQuery({
    ...ownerGrantsQueryOptions(rowId),
    enabled:
      server !== undefined && server.ownerGrants === undefined && !personal,
  });
  const whoGives: "any" | "admin" =
    server?.ownerGrants ?? ownerGrantsRead.data?.ownerGrants ?? "admin";
  const navigate = useNavigate();
  const remove = useMutation({
    ...removePluginServerMutationOptions(queryClient),
    ...report,
    /*
     * BACK TO THE LIST FOR AN APP THIS PAGE CAN'T TURN BACK ON, the way Connections itself treats
     * one. A catalogue app is listed there on or off, and its page, off, offers Connect. An app
     * added from a broker's directory, or by its address, is listed only while it is on, and is
     * added from the directory, which says what adding it means first. With its row gone this page
     * had nothing left to draw and said "Not an app" about the app just turned off.
     *
     * Asked of the catalogue as it stood when the switch was pressed. Awaited, because the
     * mutation runs its own `onSettled` refetch only after this returns: started any sooner, the
     * refetch landed before the navigation and the page drew "Not an app" on its way out.
     */
    onSuccess: async (_data, serverId) => {
      const listed = queryClient
        .getQueryData(pluginsPageQueryOptions().queryKey)
        ?.catalogue.some(
          (item) => item.key === serverId || item.key === appKey,
        );
      if (!listed) await navigate(paths.plugins());
    },
  });
  const connectSelf = useMutation({
    // Back to this page afterwards, not to the personal settings screen.
    ...connectAccountMutationOptions("admin"),
    ...report,
    /*
     * A full page navigation, not a fetch. The consent screen is the vendor's own and has to be
     * shown to this person in their own browser; there is deliberately nothing here that could
     * complete it for them, and nothing about being an administrator changes that.
     */
    onSuccess: (start) => {
      /*
       * `{ connected: true }`（X8）：厂商已经持有这个应用要的全部权限，路由在这次按下时就记下了连接，
       * 没有页面要去。不报错、不跳转，重读插件查询，这一页从记下的那一行画出「已连接」。上游把它当成
       * 这一半看不懂的回答报错；熊宝照实画已连接（服务端这一半本不回它，回了也是真的连上了）。
       */
      if (start !== null && "connected" in start) {
        void invalidatePlugins(queryClient);
        return;
      }
      /*
       * A 200 with no url on it is not a url to follow. This press is on a `user-oauth` catalogue
       * entry, whose half of that route always mints one or refuses, so this is the server having
       * answered something this page does not understand. Assigning it navigated to a page called
       * `undefined` on this deployment's own origin. See `connectAccountMutationOptions`.
       */
      const authorizationUrl = start?.authorizationUrl ?? null;
      if (authorizationUrl === null) {
        setError(
          "部署的回应里没有授权链接，所以没法带你过去，也没有连接任何东西。请重试；如果一直这样，请检查这个连接器的配置。",
        );
        return;
      }
      window.location.href = authorizationUrl;
    },
  });
  /*
   * Everybody on the roster, and anybody hidden from it who holds one of this app's grants,
   * withdrawn ones included: see `grantRoster`. Named from the roster rows themselves, because the
   * id-to-name lookup other admin screens use is built from the visible roster alone.
   */
  const bots = grantRoster({
    roster: agents ?? [],
    hidden: hiddenAgents ?? [],
    holders: [
      ...(server?.tools ?? []).flatMap((tool) => tool.grantedTo),
      ...(server?.withdrawn ?? []).flatMap((held) => held.grantedTo),
    ],
  }).map((agent) => ({
    id: agent.id,
    name: agent.name,
    hidden: agent.hidden,
  }));
  /*
   * Every Bot this admin can see, hidden ones included. The mode-switch dialog's dry run can name
   * a Bot that holds no grant on this app today — the default team rule a Shared switch writes
   * reaches `*` — or a Bot hidden from the roster that still holds one of this app's grants, so the
   * lookup has to cover both.
   */
  const botNames = Object.fromEntries(
    [...(agents ?? []), ...(hiddenAgents ?? [])].map((agent) => [
      agent.id,
      agent.name,
    ]),
  );

  const auth = connectionKindFor(server, entry?.auth);
  /* What the catalogue calls this vendor's credential, for one placed somewhere other than a header. */
  const credentialLabel = entry?.credentialLabel ?? "访问令牌";
  const title = zh(entry?.title ?? server?.title ?? key);

  /* Bound once because the brokered row below is told it twice — once inside the whole
     disconnected sentence and once on its own — and two copies of it would drift. */
  /* It names this app's own account. It said "your documents" on every app, Gmail included,
     because it was written for Google Drive. */
  const reassurance = `不连也算配置完成；连上后只会碰到你自己的 ${title} 账号。`;

  /*
   * A SHARED APP'S ROW IS THE TEAM ACCOUNT, NOT THIS ADMINISTRATOR'S.
   *
   * The deployment row is listed whether or not anything is connected to it, so its presence is not
   * the answer — its `connected` field is. The hook below is still called once and unconditionally,
   * per the rules of hooks; what changes is which row feeds it.
   */
  const shared = server?.accountMode === "shared";
  const sharedConnection = (connections.data?.connections ?? []).find(
    (row) =>
      row.serverId === (server?.id ?? key) && row.holder === "deployment",
  );
  const accountRow = shared ? sharedConnection : connection;

  /*
   * Everything the brokered row below reads and does, shared with the personal connected-accounts
   * screen that draws the same row. See `brokered-account-row.tsx`.
   *
   * `connectSelf` above stays: it is the `user-oauth` row's Connect, which is a different row with
   * no Disconnect beside it and nothing brokered to confirm.
   */
  const brokeredAccount = useBrokeredAccount({
    authScheme: server?.authScheme ?? null,
    // Off the declared capability, never off the vendor's name. See the row's own field.
    reconnectsInPlace: plugins.data?.authorizesPerAction ?? false,
    brokered: auth === "brokered",
    configured: plugins.data?.composioConfigured ?? false,
    recorded: shared ? (sharedConnection?.connected ?? false) : youConnected,
    report: setError,
    // Back to this page afterwards, not to the personal settings screen.
    returnTo: "admin",
    serverId: rowId,
    /*
     * Absent where this person has never connected the app, and false rather than asserted: with no
     * row there is nothing that could have been checked, which is exactly what the server's own
     * columns default to. The three are optional on the type because that endpoint concatenates two
     * reads and only a brokered row carries them.
     */
    verified: accountRow?.verified ?? false,
    verifiedAt: accountRow?.verifiedAt ?? null,
    /*
     * AND THIS ONE IS NOT FLATTENED, for the reason the personal screen gives: the two above fall
     * back on the server's own column defaults, while a null here is the server's record that the
     * last check spent nothing — not the absence of a record. The row draws a different sentence
     * for each, so the difference has to reach it.
     */
    probe: accountRow?.probe,
    /*
     * WHILE THIS ONE IS, for the reason that screen gives too: it is the Re-check button's gate and
     * not a sentence. The record above says what was spent and this says whether the app has
     * anything to spend today — asking the record the second question is what left a key nothing
     * was tried on with no way to ever have anything tried on it. Absent and false are the same
     * closed gate, so the fallback costs nothing here.
     */
    checkable: accountRow?.checkable ?? false,
  });
  /*
   * The app the brokered sentences name in the personal edition, where the one person reading is
   * spoken to as "you". Undefined in the team edition, whose sentences are about each person.
   */
  const brokeredApp = personal
    ? { title, kind: brokeredAccount.kind }
    : undefined;

  /*
   * Whether this vendor's credential is placed somewhere other than a bearer header (a key in a
   * query parameter, a per-customer address). The catalogue names such a credential; a plain bearer
   * token has no label of its own.
   */
  const placedCredential = entry?.credentialLabel !== undefined;

  /** Adding is two writes when a token was typed: the credential, then the record pointing at it. */
  const add = async () => {
    setError(null);
    try {
      /*
       * A PLACED CREDENTIAL never goes through `POST /api/admin/credentials`: it reaches the vault
       * only through `POST /servers/:id/token`, which checks its shape before sealing it. So the add
       * sends no credential id, and the typed value follows through that one checked door.
       */
      const credentialId =
        auth === "deployment-bearer" && !placedCredential
          ? await storeMcpToken(appKey, token || undefined)
          : undefined;
      await addCurated.mutateAsync({
        key: appKey,
        instanceHost: instanceHost || undefined,
        credentialId,
      });
      if (placedCredential && token.trim()) {
        await replaceServerToken.mutateAsync({ serverId: key, token });
      }
      if (auth === "user-oauth" && client.clientId && client.clientSecret) {
        await registerClient.mutateAsync({ serverId: key, ...client });
      }
      setToken("");
      setClient({ clientId: "", clientSecret: "" });
      setDialog(null);
      return true;
    } catch (thrown) {
      setError((thrown as Error).message);
      return false;
    }
  };

  /*
   * THE PERSONAL EDITION'S ONE STEP. Adding an app and connecting your account are two decisions
   * only when two people make them. Here Connect adds the app and, for an app reached as you, goes
   * straight on to the account it needs, once the list says there is a client to consent against.
   */
  const connectNew = async () => {
    if (!(await add()) || auth !== "user-oauth") return;
    const fresh = await queryClient.fetchQuery({
      ...pluginsPageQueryOptions(),
      staleTime: 0,
    });
    const added = fresh.servers.find((item) => item.id === key);
    if (added && (added.hasCredential || added.dynamicClient)) {
      connectSelf.mutate(key);
    }
  };

  /*
   * A SERVER THAT IS ALREADY ADDED HAS ITS TOKEN REPLACED IN ONE REQUEST, `POST /servers/:id/token`,
   * which stores the new token and points the server at it in one transaction. Not a store and then
   * a re-add: storing a token for a key that holds one revokes the old one at once, so a re-add that
   * failed after it left the server on a revoked credential. Refused, the dialog stays open over what
   * was typed so it can be corrected rather than retyped.
   */
  const replaceToken = async () => {
    setError(null);
    if (!token.trim()) {
      setDialog(null);
      return;
    }
    try {
      await replaceServerToken.mutateAsync({ serverId: rowId, token });
      setToken("");
      setDialog(null);
    } catch (thrown) {
      setError((thrown as Error).message);
    }
  };

  /* An instance host is moved by re-adding the catalogue server with the new host and no credential
     id, which keeps the token it holds. */
  const moveInstance = async () => {
    setError(null);
    if (!instanceHost.trim()) {
      setDialog(null);
      return;
    }
    try {
      await addCurated.mutateAsync({
        key: appKey,
        instanceHost: instanceHost.trim(),
      });
      setInstanceHost("");
      setDialog(null);
    } catch (thrown) {
      setError((thrown as Error).message);
    }
  };

  /*
   * One write per grant per member, through the shared group helper: one member being refused no
   * longer stops the others, and one refetch at the end. A selection made by pressing a crew is the
   * same selection as one made by ticking its members — the crew itself is never sent.
   */
  const grantSelected = async () => {
    setError(null);
    setRefusals(null);
    const agentIds = [...selectedBots];
    const refs = [...selectedRefs];
    setGranting({ done: 0, total: agentIds.length * refs.length });
    const outcome: CrewGrantOutcome | null = await grantToMembers({
      queryClient,
      kind: "mcp",
      refs,
      agentIds,
      onProgress: (done, total) => setGranting({ done, total }),
      ...(server?.accountMode === "shared" ? { approval: sharedApproval } : {}),
    }).catch((thrown: unknown) => {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
      return null;
    });
    setGranting(null);
    if (!outcome) return;
    const summary = crewSummary(outcome, { what: `${refs.length} 个工具` });
    if (!summary.failed) {
      setDialog(null);
      return;
    }
    const nameOf = (agentId: string) =>
      bots.find((bot) => bot.id === agentId)?.name ?? agentId;
    setRefusals({
      text: summary.text,
      members: outcome.members
        .filter((member) => member.refused.length > 0)
        .map((member) => ({
          agentId: member.agentId,
          line: `${nameOf(member.agentId)}：${member.refused.length} 个工具被拒绝（${member.refused[0]?.reason ?? "没有给出原因"}）`,
        })),
    });
  };

  /*
   * Nothing rather than a placeholder, so no sentence asserts anything while the fetch is open —
   * AND BOTH READS ARE WAITED FOR. `recorded`, `verified`, `verifiedAt`, `probe` and `checkable`
   * all come off the connections read and this gated on `plugins` alone, so a connections read
   * still in flight drew the brokered row with the whole of its state defaulted to "you have never
   * connected this". The personal screen had the identical gap; see its own note.
   */
  if (plugins.isPending || connections.isPending) {
    return <PageShell title="插件">{null}</PageShell>;
  }
  /*
   * Gated on the plugin list having ARRIVED, the guard the per-Bot grant screen already keeps
   * (`plugins.data && !server`). `isPending` goes false on a failed fetch exactly as it does on a
   * successful one, so `!(entry || server)` alone cannot tell "this deployment has no plugin by
   * that name" apart from "the plugin list could not be read", and a request that never came back
   * is no evidence for the first. Nothing on this page survives the failure: the title, the tools
   * and the grants are all that one response.
   */
  if (!plugins.data) {
    return (
      <PageShell
        backButton={{ label: paths.pluginsLabel, linkProps: paths.plugins() }}
        title={paths.pluginsLabel}
      >
        <p className="mt-12 text-destructive text-sm" role="alert">
          {personal ? "读不到你的应用。请刷新页面。" : "读不到插件。"}
        </p>
      </PageShell>
    );
  }
  if (!(entry || server)) {
    return (
      <PageShell
        backButton={{ label: paths.pluginsLabel, linkProps: paths.plugins() }}
        description={
          personal
            ? "没有叫这个名字的应用。"
            : "这个部署没有叫这个名字的插件，目录里也没有。"
        }
        title={personal ? "不是应用" : "不是插件"}
      >
        <PageEmpty
          icon={IconPuzzle}
          title={personal ? "找不到这个应用" : "找不到这个插件"}
        >
          没有可配置的。
        </PageEmpty>
      </PageShell>
    );
  }

  const listed = server ? listedTools(server.tools, personal ? key : null) : [];
  /* The grant dialog's two halves of the tool list, split by what a boundary would see. */
  const reads = server?.tools.filter((tool) => tool.effect !== "write") ?? [];
  const writes = server?.tools.filter((tool) => tool.effect === "write") ?? [];
  const chosenWrites = writes.filter((tool) =>
    selectedRefs.has(tool.ref),
  ).length;
  const chosenNames = bots
    .filter((bot) => selectedBots.has(bot.id))
    .map((bot) => bot.name);

  return (
    <PageShell
      backButton={{ label: paths.pluginsLabel, linkProps: paths.plugins() }}
      description={zh(entry?.summary ?? server?.summary ?? "") || undefined}
      title={title}
    >
      {error ? (
        <p className="break-words text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {/*
       * No section heading. This is one decision, and a heading over a single row that repeats the
       * row's own title tells a reader nothing they cannot already see.
       */}
      <PageSection>
        <PageRows className="mt-0">
          {/*
           * Binary and immediate, which is what the layout skill reserves a Switch for: it takes
           * effect when switched and there is no save. It replaces an "Add to deployment" button and
           * a destructive "Remove" row that were the same decision drawn twice, in two places, one of
           * them looking far more dangerous than the other.
           *
           * The description states the consequence in the present tense, in both directions, because
           * switching this off deletes every grant on the vendor's tools and that is not recoverable
           * by switching it back on.
           */}
          {alwaysOn ? (
            <Item size="sm">
              <ItemContent>
                <ItemTitle>一直开着</ItemTitle>
                <ItemDescription>
                  每位员工都能用它来安排自己的工作。
                </ItemDescription>
              </ItemContent>
            </Item>
          ) : personal && !server ? (
            <Item size="sm">
              <ItemContent>
                <ItemTitle>添加 {title}</ItemTitle>
                <ItemDescription>
                  连接它，你的员工就能用它的工具。员工可以马上用它读取，改动任何东西之前会先问你。
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  aria-label={`连接 ${title}`}
                  disabled={addCurated.isPending || connectSelf.isPending}
                  onClick={() => void connectNew()}
                  size="sm"
                  type="button"
                >
                  连接
                </Button>
              </ItemActions>
            </Item>
          ) : (
            <Item size="sm">
              <ItemContent>
                <ItemTitle>{personal ? "已打开" : "为这个部署启用"}</ItemTitle>
                <ItemDescription>
                  {personal
                    ? "你的员工能用它的工具。关掉会移除它，以及每位员工对它工具的访问。"
                    : server
                      ? "可以把它的工具授予员工。关掉会移除它，以及它所有工具上的授权。"
                      : "没有员工能连到这个服务商。打开后才能配置它并授予它的工具。"}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-label={
                    personal ? `打开或关掉 ${title}` : `为这个部署启用 ${title}`
                  }
                  checked={server !== undefined}
                  onCheckedChange={(next) => {
                    setError(null);
                    if (next) void add();
                    else remove.mutate(rowId);
                  }}
                />
              </ItemActions>
            </Item>
          )}

          {/*
           * ONLY A BROKERED APP THAT HAS AN ACCOUNT TO MAKE. `NO_AUTH` is the Composio scheme with
           * nothing to connect at all — see `brokeredAccountsListedOn` — so there is no personal/
           * shared choice to offer for it, and a row here could only open a dialog that refuses.
           */}
          {/* The personal edition has one person, so whose account it is has one answer: yours. */}
          {!personal &&
          server &&
          brokeredProvenance(server.provenance) &&
          server.authScheme !== "NO_AUTH" ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>用谁的账号</ItemTitle>
                  <ItemDescription>
                    {server.accountMode === "shared"
                      ? server.sharedOnly
                        ? "所有人共用一个团队账号。它用这个部署自己的应用凭据登录，所以不能改成个人账号。"
                        : "所有人共用一个团队账号。"
                      : server.sharedOnly
                        ? "它用这个部署自己的应用凭据登录，所以只能作为团队账号连接。"
                        : "每个人连接自己的账号。"}
                  </ItemDescription>
                </ItemContent>
                {/*
                 * NO WAY BACK TO PERSONAL FOR AN APP THAT CAN ONLY HOLD A SHARED ACCOUNT, read off
                 * the listing's `sharedOnly` and never off the app's name. Personal would leave it
                 * with nobody able to connect it: the server refuses a person's account there.
                 */}
                {server.sharedOnly && server.accountMode === "shared" ? null : (
                  <ItemActions>
                    <Button
                      onClick={() =>
                        setModeTarget(
                          server.accountMode === "shared"
                            ? "personal"
                            : "shared",
                        )
                      }
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {server.accountMode === "shared"
                        ? "改成个人账号"
                        : "改成团队账号"}
                    </Button>
                  </ItemActions>
                )}
              </Item>
            </>
          ) : null}

          {/*
           * Who may give the app to a Bot. Binary and immediate, so a Switch. Every person's own
           * account and the built-in Routines start on; a deployment token, a shared account and an
           * app with no account start off, because a Bot given one of those reaches an account that
           * is not the asker's. An owner's grant runs on the asker's own account, except on a shared
           * account, where the grant lets the people who can use the Bot use the team account.
           * Not in the personal edition, where the owner of every Bot is the one person.
           */}
          {server && !personal && !alwaysOn ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>员工的主人可以把它给自己的员工</ItemTitle>
                  <ItemDescription>
                    {whoGives !== "any"
                      ? "只有管理员能把它给员工。"
                      : shared
                        ? "主人把它给自己的员工后，这些员工就会用团队账号。"
                        : "每个人可以让自己的员工用它，用的是提问者本人的账号。"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label={`让员工的主人可以把 ${title} 给自己的员工`}
                    checked={whoGives === "any"}
                    disabled={
                      ownerGrants.isPending ||
                      (server.ownerGrants === undefined &&
                        !ownerGrantsRead.data)
                    }
                    onCheckedChange={(next) => {
                      setError(null);
                      ownerGrants.mutate({
                        serverId: rowId,
                        ownerGrants: next ? "any" : "admin",
                      });
                    }}
                  />
                </ItemActions>
              </Item>
            </>
          ) : null}
        </PageRows>
      </PageSection>

      {/*
       * People asking for this app: to switch it on, give it to a Bot, or connect its shared
       * account. Only when somebody is; the section draws nothing otherwise. Requests name who
       * asked — connections still name nobody.
       */}
      <AccessRequestsSection app={key} />

      <AccountModeDialog
        names={botNames}
        onOpenChange={(open) => !open && setModeTarget(null)}
        open={modeTarget !== null}
        serverId={rowId}
        target={modeTarget ?? "shared"}
        title={title}
      />

      {server ? (
        <PageSection
          description={
            /* The personal edition has one person, so each sentence speaks to them and names nobody else. */
            auth === "user-oauth"
              ? personal
                ? `通过${shortName()}连接你的 ${title} 账号。${shortName()}登记一个 OAuth 客户端，你的员工只看得到你能看到的东西。`
                : "这个服务商按提问者的身份回应。部署登记一个 OAuth 客户端，每个人连接自己的账号，所以员工只能看到那个人能看到的东西。"
              : auth === "builtin"
                ? `内置在${paths.deploymentName}里。没有要连的服务商，也没有要保管的凭据——${personal ? "调用以你的身份运行。" : "调用以提问者的身份运行。"}`
                : auth === "brokered"
                  ? /* The row below says how, at length. This says whose account it is, which is the part that decides what an admin has to do here — which is nothing. */
                    brokeredConnectionDescription(provider, brokeredApp)
                  : auth === "person-entra"
                    ? "这个服务器按提问者的身份回应。每次调用都带着 Microsoft Entra 为这个人签发的令牌，所以员工只能看到这个人能看到的东西。"
                    : personal
                      ? `${shortName()}向 ${title} 出示的凭据。你的员工都用它。`
                      : `${paths.deploymentName}向服务商出示的凭据。一份凭据，所有人共用。`
          }
          title="连接"
        >
          {/*
           * Rows that DO something, and nothing else — with two admitted exceptions. The layout
           * skill's third row kind — a value with no chevron and nothing to click — earns its
           * place on a screen full of them, but among four actionable rows a dead one reads as a
           * control that has stopped working. The redirect URI is prose under the card instead.
           *
           * The first exception is the OAuth client row for a vendor with a dynamic client: there
           * is a real fact to state — this deployment registers itself, nobody configures it —
           * right where the actionable client row would otherwise sit. Leaving that slot empty
           * would read as a missing setup step, not as nothing to do.
           *
           * The second is the whole Connection card for a builtin server: there is nothing to
           * configure, but a card of nothing under a "Connection" heading reads as a missing setup
           * step rather than as the answer. The row states that plainly instead of leaving the
           * card empty — and being first, it also gives the docsUrl row below something other than
           * the card's own top border to sit its leading separator against.
           *
           * The third is the brokered row, for the same reason as the second and one more: an
           * administrator looking at a Connection card with only somebody's personal account on it
           * will reasonably look for the deployment's half of the arrangement. There is one, it is
           * just not theirs to type, and saying so is the only way this card is not read as
           * half-configured.
           */}
          <PageRows>
            {auth === "builtin" ? (
              /*
               * Nothing to click. A builtin server runs inside this deployment, on tables it
               * already owns — there is no vendor to authenticate to and no credential to store.
               */
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>连接</ItemTitle>
                  <ItemDescription>
                    没有可配置的。这些工具在{paths.deploymentName}
                    内部运行，使用它已有的数据。
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">内置</span>
                </ItemActions>
              </Item>
            ) : null}

            {auth === "brokered" ? (
              /*
               * Nothing to click. The deployment's half of a brokered app is one key held once,
               * for Composio rather than for this vendor, and it is set where every brokered app
               * reads it from — not here, per app, by hand.
               */
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>如何连接</ItemTitle>
                  <ItemDescription>
                    {
                      brokeredReach(
                        provider,
                        brokeredApp,
                        brokeredAccount.kind === "fields",
                      ).description
                    }
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    {brokeredReach(provider, brokeredApp).badge}
                  </span>
                </ItemActions>
              </Item>
            ) : null}

            {auth === "person-entra" ? (
              /*
               * Nothing to click. The scope is set when the server is added by URL, and each call
               * exchanges the asking person's own Microsoft sign-in for a token to it. Shown so an
               * admin can see the mark at all: without this row the page drew the shared-token
               * shape over a server that never sends one.
               */
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>如何连接</ItemTitle>
                  <ItemDescription>
                    以提问者本人的身份，通过他的 Microsoft
                    登录访问。不需要粘贴令牌。
                  </ItemDescription>
                  <code className="mt-1 block break-all font-mono text-muted-foreground text-xs">
                    {server?.entraScope}
                  </code>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    Microsoft Entra
                  </span>
                </ItemActions>
              </Item>
            ) : null}

            {auth === "deployment-bearer" ? (
              <Item
                render={
                  <button onClick={() => setDialog("token")} type="button" />
                }
                size="sm"
              >
                <ItemContent>
                  <ItemTitle>{credentialLabel}</ItemTitle>
                  <ItemDescription>
                    {entry?.credentialHint
                      ? `${entry.credentialHint}管理员录入一次，所有人共用；部署按服务商要求放进请求，不会显示或记录。`
                      : "每次调用这个服务商时作为 Bearer 令牌发送。"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    {server?.hasCredential ? "已保存" : "未设置"}
                  </span>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </ItemActions>
              </Item>
            ) : null}

            {auth === "user-oauth" && server?.dynamicClient ? (
              /*
               * Nothing to click. This deployment registers its own OAuth client with the
               * vendor (RFC 7591) the first time anybody connects, so there is no client id
               * or secret for an administrator to hold, let alone paste.
               */
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>OAuth 客户端</ItemTitle>
                  <ItemDescription>
                    首次连接时{atStart(paths.deploymentName)}
                    会自动向服务商登记，不需要粘贴任何东西。
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    自动登记
                  </span>
                </ItemActions>
              </Item>
            ) : null}

            {auth === "user-oauth" && !server?.dynamicClient ? (
              <Item
                render={
                  <button onClick={() => setDialog("client")} type="button" />
                }
                size="sm"
              >
                <ItemContent>
                  <ItemTitle>OAuth 客户端</ItemTitle>
                  <ItemDescription>
                    向服务商标识{paths.deploymentName}
                    。它本身碰不到任何人的文档。
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    {server?.hasCredential ? "已登记" : "未登记"}
                  </span>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </ItemActions>
              </Item>
            ) : null}

            {/*
             * The administrator's own account, on the setup screen.
             *
             * Setting a connector up and knowing whether it works are different questions, and the
             * second used to have no answer here: an administrator finished configuring Drive and
             * had to go to their personal settings to find out whether any of it was right. This row
             * answers it in place, and stays honest about being personal — it is this person's
             * connection, not deployment state, and it reaches their documents and nobody else's.
             *
             * It is NOT part of setup. The connector is fully configured without it, which is why it
             * sits below the client and says so rather than reading as the next required step.
             *
             * Shown once a client exists, because there is nothing to consent against before
             * that: a Connect button with no OAuth client behind it can only fail. A vendor with a
             * dynamic client is the exception — there is no client to register in advance, so
             * Connect is shown right away and is itself what creates one.
             *
             * A brokered app is shown right away too, and for the same reason: there is nothing
             * for an administrator to configure first, so there is no state in which connecting
             * could only fail. It is the one row on this card that is not optional in practice —
             * a brokered app reaches nobody until somebody connects — but it is still personal,
             * and still this person's account and nobody else's.
             *
             * The two are drawn by different things, which is the honest arrangement rather than
             * one row branching on `auth` in five places. A brokered account is ended from here as
             * well as begun, and says so; an OAuth one is withdrawn at the vendor and this page
             * offers no button pretending otherwise.
             */}
            {auth === "brokered" ? (
              <>
                <Separator />
                {connectionsUnreadable ? (
                  <ConnectionStateUnreadable />
                ) : server?.sharedOnly && !shared ? (
                  /*
                   * NO PERSONAL CONNECT FOR AN APP THAT CAN ONLY HOLD A SHARED ACCOUNT. It signs in
                   * with this deployment's own client, so this administrator's "own" account would
                   * be the organization's access under their name; the server refuses it. What is
                   * left to do is the switch above, after which the team account row is drawn here.
                   */
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>团队账号</ItemTitle>
                      <ItemDescription>
                        {`${title} 只能作为一个团队账号连接。先在上面改成团队账号，再在这里连接团队账号并把它给员工。`}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                ) : shared ? (
                  <BrokeredAccountRow
                    account={brokeredAccount}
                    edition={paths.edition}
                    connectedDescription={teamAccountConnectedDescription(
                      sharedConnection,
                    )}
                    disconnectedDescription="还没有连接团队账号。拿到这些工具的员工调用时会被拒绝。"
                    heading="团队账号"
                    notice="请用团队账号登录，不要用你自己的账号。"
                    provider={provider}
                    title={title}
                  />
                ) : (
                  <BrokeredAccountRow
                    account={brokeredAccount}
                    edition={paths.edition}
                    /* Said beside the button rather than after it: disconnecting ends the account
                       at Composio, so what it undoes is not the row here but the grant on this
                       person's mailbox, and connecting again is a fresh consent. Every Bot has
                       every tool in the personal edition, as the OAuth row below says. */
                    connectedDescription={
                      personal
                        ? `已连接。你的员工以你的身份使用你的 ${title}。${brokeredDisconnectNote(provider)}`
                        : `已连接。被授予这些工具的员工会以你的身份使用你的 ${title}。${brokeredDisconnectNote(provider)}`
                    }
                    /* One person: connecting is what lets their Bots use it, as the OAuth row
                       below says, and there is no setup it could be beside. */
                    disconnectedDescription={
                      personal
                        ? `连接你的 ${title} 账号，你的员工就能用它。`
                        : `连接你自己的账号来试用这个连接器。${reassurance}`
                    }
                    /* The half of the line above that is true whichever way this app connects.
                       An app whose key somebody types gets a different first sentence from the
                       row — pressing Connect opens a form rather than leaving for a consent
                       screen — and an administrator still has to be told they are not the step
                       that finishes the connector. */
                    disconnectedReassurance={personal ? undefined : reassurance}
                    provider={provider}
                    startConnect={startConnect}
                    title={title}
                  />
                )}
              </>
            ) : null}

            {auth === "user-oauth" &&
            (server?.hasCredential || server?.dynamicClient) ? (
              <>
                <Separator />
                {connectionsUnreadable ? (
                  <ConnectionStateUnreadable />
                ) : (
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>你的账号</ItemTitle>
                      <ItemDescription>
                        {personal
                          ? youConnected
                            ? `已连接。你的员工以你的身份使用你的 ${title}。`
                            : `连接你的 ${title} 账号，你的员工就能用它。`
                          : youConnected
                            ? `已连接。被授予这些工具的员工会以你的身份使用你的 ${title}。其他人各自连接自己的账号。`
                            : `连接你自己的账号来试用这个连接器。${reassurance}`}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {youConnected ? (
                        <>
                          {/* Decorative: the word beside it already says which. */}
                          <span
                            aria-hidden="true"
                            className="size-1.5 rounded-full bg-emerald-500"
                          />
                          <span className="text-muted-foreground text-xs">
                            已连接
                          </span>
                        </>
                      ) : (
                        <>
                          <NotConnected />
                          {/* The arrow says this leaves OpenBot for the vendor's consent page. It does. */}
                          <Button
                            disabled={connectSelf.isPending}
                            onClick={() => {
                              setError(null);
                              // The catalogue key: the consent route looks the vendor up by it.
                              connectSelf.mutate(appKey);
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
                )}
              </>
            ) : null}

            {entry?.perInstance ? (
              <>
                <Separator />
                <Item
                  render={
                    <button
                      onClick={() => setDialog("instance")}
                      type="button"
                    />
                  }
                  size="sm"
                >
                  <ItemContent>
                    <ItemTitle>实例地址</ItemTitle>
                    <ItemDescription>
                      这个服务商给每个客户单独的主机名，保存前会按它的格式校验。
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <span className="text-muted-foreground text-xs">
                      {server?.url ?? "未设置"}
                    </span>
                    <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </>
            ) : null}

            {entry?.docsUrl ? (
              <>
                <Separator />
                <Item
                  render={
                    <a href={entry.docsUrl} rel="noreferrer" target="_blank" />
                  }
                  size="sm"
                >
                  <ItemContent>
                    <ItemTitle>
                      {auth === "builtin" ? "文档" : "服务商文档"}
                    </ItemTitle>
                    <ItemDescription>
                      {auth === "builtin"
                        ? "这些工具能做什么，来自维护者的说明。"
                        : "这个服务器能做什么，来自维护者的说明。"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <IconExternalLink className="size-4 shrink-0 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </>
            ) : null}
          </PageRows>

          {auth === "user-oauth" ? (
            <div className="mt-3 p-3">
              {server?.dynamicClient ? (
                <p className="text-muted-foreground text-sm">
                  {personal ? shortName() : "部署"}
                  会自己登记回调地址，所以不需要在服务商那边添加什么。
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">
                  把这个地址原样加到服务商那边客户端的授权回调地址里。错一个字符都会失败，而且那边的报错不会提到
                  {shortName()}。
                </p>
              )}
              {!plugins.data?.redirectUri ? (
                <p className="mt-3 text-destructive text-sm" role="alert">
                  {atStart(paths.deploymentName)}没有公网地址，所以
                  {personal ? "你" : "谁都"}完成不了连接。请设置
                  XIONGBAO_PUBLIC_URL（旧名 OPENBOT_PUBLIC_URL 仍可用）。
                </p>
              ) : server?.dynamicClient ? null : (
                /* Selectable and monospaced: it is copied by hand into somebody else's console. */
                <code className="mt-3 block select-all break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                  {plugins.data.redirectUri}
                </code>
              )}
            </div>
          ) : null}
        </PageSection>
      ) : null}

      {server ? (
        <PageSection
          /*
           * Beside the heading rather than on the page's own baseline. Refreshing is about this list
           * and nothing else on the screen — it asks the vendor what it offers now — so it belongs
           * where the list is named. Ghost, because it is a maintenance action rather than the thing
           * an administrator came here to do.
           */
          action={
            <div className="flex gap-1.5">
              <Button
                onClick={() => refresh.mutate(rowId)}
                size="sm"
                type="button"
                variant="ghost"
              >
                刷新工具
              </Button>
              {/*
               * Outline where refresh is ghost: granting is the thing an administrator came to
               * this section to do. Hidden rather than disabled with nothing to grant — a dialog
               * over an empty list could only explain its own emptiness.
               */}
              {/* Not in the personal edition, where every Bot has every tool already. */}
              {!personal && server.tools.length > 0 && bots.length > 0 ? (
                <Button
                  onClick={() => {
                    setSelectedBots(new Set());
                    setSelectedRefs(new Set());
                    setRefusals(null);
                    setDialog("grant");
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  授予工具…
                </Button>
              ) : null}
            </div>
          }
          description={
            personal
              ? // The setting by the name Settings > Approvals gives it, so a person can find it there.
                `每位员工都能用这些。「${ASK_FIRST_TITLE}」打开时，员工用会改动东西的工具之前会先问你。`
              : "员工只有拿到某个工具才会知道它的存在。每次调用发生时都会重新判定，所以撤销授权会从下一次调用开始生效。"
          }
          title="工具"
        >
          <SkippedToolsNotice
            names={server.skippedTools ?? []}
            serverId={personal ? key : undefined}
          />
          {server.tools.length === 0 ? (
            <PageEmpty icon={IconTool} title="没有列出工具">
              {toolsListError(server.lastError, { title, personal }) ??
                "刷新工具，再问一次服务商。"}
            </PageEmpty>
          ) : (
            <PageRows>
              {listed.map((tool, index) => (
                <React.Fragment key={tool.ref}>
                  {/* A real link with no children: children passed to `render` replace the row's own. */}
                  {/* A list in the personal edition: there is nobody to give a tool to one at a time. */}
                  <Item
                    render={
                      personal ? undefined : (
                        <Link {...paths.pluginTool(key, tool.name)} />
                      )
                    }
                    size="sm"
                  >
                    <ItemContent>
                      {personal ? (
                        <ToolInWords serverId={rowId} tool={tool} />
                      ) : (
                        <>
                          <ItemTitle className="font-mono text-xs">
                            {tool.name}
                          </ItemTitle>
                          <ItemDescription>
                            {zh(tool.description)}
                          </ItemDescription>
                        </>
                      )}
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * How many Bots hold it, not which. The names were here as a chip each and
                       * turned every row into a wrapping cluster of controls — twenty-four of them
                       * across this list — with the tool's own name losing the fight for attention.
                       * A count is what a reader scanning for "what is exposed, and how widely" is
                       * actually asking, and the names are one click away where they can be switched
                       * one at a time.
                       */}
                      {personal ? null : (
                        <span className="text-muted-foreground text-xs">
                          {grantSummary(tool.grantedTo.length, bots.length)}
                        </span>
                      )}
                      {/*
                       * The effect, not a description. It is what a boundary written about writes
                       * evaluates, and an operator writing that rule has no other way to know.
                       */}
                      <span
                        className={
                          tool.effect === "write"
                            ? "text-amber-600 text-xs dark:text-amber-500"
                            : "text-muted-foreground text-xs"
                        }
                      >
                        {tool.effect === "write" ? "会改动" : "只读"}
                      </span>
                      {personal ? null : (
                        <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      )}
                    </ItemActions>
                  </Item>
                  {index !== server.tools.length - 1 && <Separator />}
                </React.Fragment>
              ))}
            </PageRows>
          )}

          {/*
           * The same grants, from the Bot's end.
           *
           * In this section rather than one of its own, because it is not a second subject: the
           * list above is one action and every Bot, and these rows are one Bot and every action.
           * Which way round somebody wants it depends on what they came here to do — write a rule
           * about an action, or set a Bot up — and an app of a hundred and sixty-seven actions is
           * only approachable from this end.
           */}
          {!personal && server.tools.length > 0 && bots.length > 0 ? (
            <>
              <p className="mt-8 font-medium text-sm">按员工</p>
              <PageRows>
                {bots.map((bot, index) => (
                  <React.Fragment key={bot.id}>
                    {/* A real link with no children: children passed to `render` replace the row's own. */}
                    <Item
                      render={<Link {...paths.pluginBot(key, bot.id)} />}
                      size="sm"
                    >
                      <ItemContent>
                        <ItemTitle>{bot.name}</ItemTitle>
                        <ItemDescription>
                          {bot.hidden
                            ? "已从你的员工列表隐藏。这个应用提供的每个动作，逐个开关。"
                            : "这个应用提供的每个动作，逐个开关。"}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        {/*
                         * Only on a Shared app: a Personal one has no one account behind it for a
                         * Bot to stand with, so there is nothing here to approve.
                         */}
                        {shared ? (
                          <BotApprovalText botId={bot.id} serverId={rowId} />
                        ) : null}
                        <span className="text-muted-foreground text-xs">
                          {heldSummary(
                            server.tools.filter((tool) =>
                              tool.grantedTo.includes(bot.id),
                            ).length,
                            server.tools.length,
                          )}
                        </span>
                        <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </ItemActions>
                    </Item>
                    {index !== bots.length - 1 && <Separator />}
                  </React.Fragment>
                ))}
              </PageRows>
            </>
          ) : null}
        </PageSection>
      ) : null}

      {/*
       * Only when there is something to say. An empty section here would teach a reader to scroll past
       * a heading that is usually blank, which is the opposite of the point.
       *
       * Its own section rather than rows inside Tools, because these are not tools: they are not
       * listed by the vendor, there is no page to open for one, and putting them in the same list
       * would make the count above it wrong.
       */}
      {!personal && server && server.withdrawn.length > 0 ? (
        <PageSection
          description="服务商已不再列出这些，所以没有员工会知道它们，模型也调用不了。授权仍有记录，服务商重新列出后这些工具会再次提供。如果不想这样，请到员工自己的页面撤销。"
          title="已授权但未提供"
        >
          <PageRows>
            {server.withdrawn.map((held, index) => (
              <React.Fragment key={held.ref}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle className="font-mono text-xs">
                      {held.name}
                    </ItemTitle>
                    <ItemDescription>
                      {server.toolsRefreshedAt ? "上次刷新时" : ""}
                      {title} 没有列出它。
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <span className="text-muted-foreground text-xs">
                      {grantSummary(held.grantedTo.length, bots.length)}
                    </span>
                  </ItemActions>
                </Item>
                {index !== server.withdrawn.length - 1 && <Separator />}
              </React.Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}

      <Dialog
        onOpenChange={(open) => setDialog(open ? dialog : null)}
        open={dialog !== null && dialog !== "grant"}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog === "client"
                ? `${title} 的 OAuth 客户端`
                : dialog === "instance"
                  ? `${title} 的实例地址`
                  : `${title} 的${credentialLabel}`}
            </DialogTitle>
            <DialogDescription>
              {dialog === "client"
                ? `来自服务商的控制台。密钥保存在${paths.deploymentName}的保险库里，永远不会再显示。`
                : dialog === "instance"
                  ? "你在这个服务商那里的主机名。保存前会按他们的格式校验。"
                  : `${entry?.credentialHint ?? ""}保存在${paths.deploymentName}的保险库里，永远不会再显示。`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <FieldGroup>
              {dialog === "client" ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="client-id">客户端 ID</FieldLabel>
                    <Input
                      id="client-id"
                      onChange={(event) =>
                        setClient((c) => ({
                          ...c,
                          clientId: event.target.value,
                        }))
                      }
                      value={client.clientId}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="client-secret">客户端密钥</FieldLabel>
                    <Input
                      id="client-secret"
                      onChange={(event) =>
                        setClient((c) => ({
                          ...c,
                          clientSecret: event.target.value,
                        }))
                      }
                      type="password"
                      value={client.clientSecret}
                    />
                  </Field>
                </>
              ) : dialog === "instance" ? (
                <Field>
                  <FieldLabel htmlFor="instance-host">实例地址</FieldLabel>
                  <Input
                    id="instance-host"
                    onChange={(event) => setInstanceHost(event.target.value)}
                    placeholder="https://your-instance.service-now.com"
                    value={instanceHost}
                  />
                </Field>
              ) : (
                <Field>
                  <FieldLabel htmlFor="access-token">
                    {credentialLabel}
                  </FieldLabel>
                  <Input
                    id="access-token"
                    onChange={(event) => setToken(event.target.value)}
                    type="password"
                    value={token}
                  />
                </Field>
              )}
            </FieldGroup>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setDialog(null)} size="sm" variant="ghost">
              取消
            </Button>
            <Button
              onClick={() => {
                if (!server) {
                  void add();
                  return;
                }
                if (dialog === "token") {
                  void replaceToken();
                  return;
                }
                if (dialog === "instance") {
                  void moveInstance();
                  return;
                }
                if (dialog === "client") {
                  registerClient.mutate({ serverId: rowId, ...client });
                }
                setDialog(null);
              }}
              size="sm"
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
       * Who first, then what: the decision arrives as "set this Bot up", not as a list of tools
       * looking for an owner. Both groups get a select-all; the amber heading and the footer's
       * "N of which change things" are what keep a bulk write grant a read decision, not a blind one.
       */}
      {server ? (
        <Dialog
          onOpenChange={(open) => setDialog(open ? dialog : null)}
          open={dialog === "grant"}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>授予工具</DialogTitle>
              <DialogDescription>
                每次授权都会在{paths.auditLabel}
                里单独留一条；授予的写入类工具每次调用时仍要经过边界规则检查。
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="mt-4 space-y-5">
              {refusals ? (
                <div className="text-destructive text-sm" role="alert">
                  <p>{refusals.text}</p>
                  <ul className="mt-1 list-disc pl-5 text-xs">
                    {refusals.members.map((member) => (
                      <li key={member.agentId}>{member.line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {/*
               * Each set of tickboxes is a group named by its own heading, so a screen reader
               * reaching a bare tool name is told which list it is in. "Changes things" is the whole
               * warning on those, and it is a heading a sighted reader cannot miss and a listener
               * would otherwise never hear.
               *
               * A `fieldset` because that is what a group of tickboxes is, named by the heading
               * already on screen rather than by a `legend` duplicating it. `min-w-0` undoes the
               * one thing a fieldset brings that a div did not: a min-content floor that a long
               * tool name would push the dialog out to.
               */}
              {shared ? (
                <SharedApprovalFields
                  onChange={setSharedApproval}
                  value={sharedApproval}
                />
              ) : null}
              <fieldset aria-labelledby="grant-to-heading" className="min-w-0">
                <p className="mb-2 font-medium text-sm" id="grant-to-heading">
                  授予给
                </p>
                {(crews.data?.length ?? 0) > 0 ? (
                  <div className="mb-2 flex flex-wrap gap-1">
                    {(crews.data ?? []).map((crew) => {
                      /*
                       * Only members this dialog draws a row for: a member it cannot show would be
                       * granted without ever appearing in "授予 …" above the button.
                       */
                      const members = crewMembers(crew, (agentId) =>
                        bots.some((bot) => bot.id === agentId),
                      );
                      return (
                        <Button
                          aria-label={`选择${crew.name}的 ${members.length} 位员工`}
                          disabled={members.length === 0}
                          key={crew.id}
                          onClick={() =>
                            setSelectedBots((previous) => {
                              const next = new Set(previous);
                              for (const agentId of members) next.add(agentId);
                              return next;
                            })
                          }
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          {crew.name} · {members.length}
                        </Button>
                      );
                    })}
                  </div>
                ) : null}
                <div className="space-y-2">
                  {bots.map((bot) => (
                    <div className="flex items-center gap-2" key={bot.id}>
                      <Checkbox
                        checked={selectedBots.has(bot.id)}
                        id={`grant-bot-${bot.id}`}
                        onCheckedChange={() =>
                          setSelectedBots((previous) =>
                            toggled(previous, bot.id),
                          )
                        }
                      />
                      <label
                        className="text-sm"
                        htmlFor={`grant-bot-${bot.id}`}
                      >
                        {bot.name}
                      </label>
                    </div>
                  ))}
                </div>
              </fieldset>
              <div className="max-h-64 space-y-5 overflow-y-auto">
                {reads.length > 0 ? (
                  <fieldset
                    aria-labelledby="grant-reads-heading"
                    className="min-w-0"
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <p
                        className="font-medium text-sm"
                        id="grant-reads-heading"
                      >
                        只读
                      </p>
                      <Button
                        onClick={() =>
                          setSelectedRefs((previous) => {
                            const next = new Set(previous);
                            for (const tool of reads) next.add(tool.ref);
                            return next;
                          })
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        全选
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {reads.map((tool) => (
                        <div className="flex items-center gap-2" key={tool.ref}>
                          <Checkbox
                            checked={selectedRefs.has(tool.ref)}
                            id={`grant-tool-${tool.ref}`}
                            onCheckedChange={() =>
                              setSelectedRefs((previous) =>
                                toggled(previous, tool.ref),
                              )
                            }
                          />
                          <label
                            className="font-mono text-xs"
                            htmlFor={`grant-tool-${tool.ref}`}
                          >
                            {tool.name}
                          </label>
                        </div>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
                {writes.length > 0 ? (
                  <fieldset
                    aria-labelledby="grant-writes-heading"
                    className="min-w-0"
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <p
                        className="font-medium text-amber-600 text-sm dark:text-amber-500"
                        id="grant-writes-heading"
                      >
                        会改动
                      </p>
                      <Button
                        onClick={() =>
                          setSelectedRefs((previous) => {
                            const next = new Set(previous);
                            for (const tool of writes) next.add(tool.ref);
                            return next;
                          })
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        全选
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {writes.map((tool) => (
                        <div className="flex items-center gap-2" key={tool.ref}>
                          <Checkbox
                            checked={selectedRefs.has(tool.ref)}
                            id={`grant-tool-${tool.ref}`}
                            onCheckedChange={() =>
                              setSelectedRefs((previous) =>
                                toggled(previous, tool.ref),
                              )
                            }
                          />
                          <label
                            className="font-mono text-xs"
                            htmlFor={`grant-tool-${tool.ref}`}
                          >
                            {tool.name}
                          </label>
                        </div>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
              </div>
            </DialogBody>
            <DialogFooter className="mt-4 items-center">
              {/* What is about to happen, in one sentence, before it does. */}
              {selectedRefs.size > 0 && chosenNames.length > 0 ? (
                <p className="flex-1 text-muted-foreground text-xs">
                  {`把 ${selectedRefs.size} 个工具${
                    chosenWrites > 0
                      ? `（其中 ${chosenWrites} 个会改动东西）`
                      : ""
                  }授予 ${chosenNames.join("、")}。`}
                </p>
              ) : null}
              <Button onClick={() => setDialog(null)} size="sm" variant="ghost">
                取消
              </Button>
              <Button
                disabled={
                  granting !== null ||
                  selectedBots.size === 0 ||
                  selectedRefs.size === 0
                }
                onClick={() => void grantSelected()}
                size="sm"
              >
                {/* The one in flight, not the ones finished: a count that starts at zero of twelve reads as nothing happening. */}
                {granting
                  ? `正在授予第 ${Math.min(granting.done + 1, granting.total)} 个，共 ${granting.total} 个…`
                  : "授予"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </PageShell>
  );
}
