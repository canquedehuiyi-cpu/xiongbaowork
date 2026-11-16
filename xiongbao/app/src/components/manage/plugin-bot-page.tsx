import {
  IconBolt,
  IconListDetails,
  IconPlugOff,
  IconSearch,
  IconTool,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { DescribeGrants } from "@/components/manage/describe-grants";
import {
  SharedApprovalFields,
  sharedSectionSentence,
} from "@/components/plugins/shared-approval-fields";
import { SkippedToolsNotice } from "@/components/plugins/skipped-tools-notice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useBotNames } from "@/lib/agents/bot-names";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { ALWAYS_ON_APP } from "@/lib/connections/rows";
import { useManagePaths } from "@/lib/manage-paths";
import {
  grantPlugin,
  invalidatePlugins,
  setPluginGrantMutationOptions,
} from "@/lib/plugins/mutations";
import {
  appKeyOf,
  type PluginTool,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import {
  botSharedAppsQueryOptions,
  type SharedUseApproval,
  sharedUseKeys,
} from "@/lib/plugins/shared-use";
import { toolsListError } from "@/lib/plugins/tools-error";

/**
 * One Bot and one app: every action the app offers, and which of them this Bot holds.
 *
 * The sibling screen — `PluginToolPage` — answers the same question from the other end, one
 * action and every Bot, and that is the right shape when somebody is thinking about an action. It
 * is the wrong shape for setting a Bot up against an app that offers a hundred and sixty-seven of
 * them: that is one visit per action, and the decision being made ("what can this Bot do in Slack")
 * is never on screen at once.
 *
 * So the list is searchable and split by what a boundary sees. A read and a write are not the same
 * decision, and an app's actions arrive interleaved by name, which puts `delete_channel` two rows
 * under `list_channels` with nothing between them but a word.
 *
 * Its routes use `$key_`, which opts them out of nesting under the connector page, so that page stays
 * a page rather than becoming a layout with an outlet.
 */

/**
 * The refs the bulk action would grant: every action that only reads.
 *
 * Exported as a function so the promise the button makes is assertable without a DOM, a router or
 * a query client — see `tests/bot-app-grants.test.tsx`. The button says "read-only" and states a
 * resulting count before it acts, and both of those are only true if this is exactly the reads.
 *
 * A destructive action can never appear here. `destructive` sits beside `effect` rather than inside
 * it, and the effect a destructive action carries is `write` — anything not positively known to be
 * a read is one — so filtering on the effect alone already excludes it.
 *
 * Every action, not the ones a search happens to be showing. The button names every read-only
 * action and that is what it grants; narrowing it to the filtered rows would make the sentence
 * beside it quietly wrong.
 */
export function readOnlyRefs(tools: PluginTool[]): string[] {
  return tools.filter((tool) => tool.effect === "read").map((tool) => tool.ref);
}

export function PluginBotPage({
  pluginKey: key,
  agentId,
}: {
  pluginKey: string;
  agentId: string;
}) {
  // Routines is every Bot's, in every edition: there is no switch to take it from one.
  const alwaysOn = key === ALWAYS_ON_APP;
  const paths = useManagePaths();
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  /*
   * The ones this person has hidden. A hidden Bot is still a Bot, and still holds whatever it was
   * granted; the connector page links here for it (see `grantRoster`), and this page must not then
   * say there is no such Bot.
   */
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const nameFor = useBotNames();
  const [error, setError] = useState<string | null>(null);
  /** What the list is narrowed to, over action names. Never over what is switched on. */
  const [search, setSearch] = useState("");
  /**
   * How far through the bulk grant we are, or null when none is running.
   *
   * A count rather than a boolean, for the reason the connector page's own batch records: this is
   * honestly N writes, each its own audit row, and a button that says only "Granting…" for the
   * length of forty of them gives an administrator no way to tell a slow batch from a stuck one.
   */
  const [granting, setGranting] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const setGrant = useMutation({
    ...setPluginGrantMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
  });

  /*
   * Either name: the route may carry the catalogue key or, from an old link, the row id, which for a
   * curated connector is the team's `team:<catalogue key>` since G01-E（熊宝）.
   */
  const server = plugins.data?.servers.find(
    (row) => row.id === key || appKeyOf(row) === key,
  );
  const appKey = server ? appKeyOf(server) : key;
  /*
   * Shared only once the server itself says so. `exposure` is fetched for exactly that case — it is
   * this Bot's whole shared-apps picture, and here it is read for one app's current approval, so a
   * switched-on action never asks twice for the same consent.
   */
  const shared = server?.accountMode === "shared";
  const exposure = useQuery({
    ...botSharedAppsQueryOptions(agentId),
    enabled: shared,
  });
  /*
   * The row whose switch a shared grant is waiting on, and the approval the dialog for it is
   * showing. Not scoped per-row because only one dialog is ever open at a time.
   */
  const [pendingGrant, setPendingGrant] = useState<{ ref: string } | null>(
    null,
  );
  const [approval, setApproval] = useState<SharedUseApproval>({
    audience: "team",
    outsideInput: false,
    members: [],
  });
  const [grantingShared, setGrantingShared] = useState(false);
  const appTitle =
    plugins.data?.catalogue.find((item) => item.key === appKey)?.title ??
    server?.title ??
    key;
  const bot =
    agents.data?.find((one) => one.id === agentId) ??
    hiddenAgents.data?.find((one) => one.id === agentId);

  const back = {
    label: appTitle,
    linkProps: paths.plugin(key),
  };

  /*
   * One write per grant, in list order, with one refetch at the end.
   *
   * Going through the single-grant mutation would invalidate every plugin query after each write
   * and await it, so forty reads would be forty round trips interleaved with forty refetches of a
   * list nobody can read while the button is still counting. A refusal stops the rest and says why;
   * the ones before it landed, so the screen is refreshed either way.
   */
  const grantEveryRead = async (refs: string[]) => {
    setError(null);
    setGranting({ done: 0, total: refs.length });
    let done = 0;
    try {
      for (const ref of refs) {
        await grantPlugin({ agentId, kind: "mcp", ref });
        done += 1;
        setGranting({ done, total: refs.length });
      }
    } catch (thrown) {
      setError((thrown as Error).message);
    } finally {
      await invalidatePlugins(queryClient);
      setGranting(null);
    }
  };

  /* Nothing rather than a placeholder, so no sentence asserts anything while a fetch is open. */
  if (plugins.isPending || agents.isPending || hiddenAgents.isPending) {
    return <PageShell title="员工">{null}</PageShell>;
  }

  /*
   * Gated on the plugin list having ARRIVED, not on `server` being missing — the same guard, for
   * the same reason, as the roster check below, and the two are meant to be read together.
   * `isPending` goes false on a failed fetch exactly as it does on a successful one, so `!server`
   * alone cannot tell "this deployment has not enabled that app" apart from "the plugin list could
   * not be read". Only the first is a fact about this deployment, and a request that never came
   * back is no evidence for it.
   */
  if (plugins.data && !server) {
    return (
      <PageShell
        backButton={{ label: paths.pluginsLabel, linkProps: paths.plugins() }}
        description="这个部署没有启用叫这个名字的应用。"
        title={appTitle}
      >
        <PageEmpty icon={IconPlugOff} title="这个应用没有打开">
          这里没有可以给员工的东西。
        </PageEmpty>
      </PageShell>
    );
  }

  /*
   * Which leaves the other one: no server because the read itself failed. Nothing on this screen
   * survives that — the app's title, its actions and this Bot's grants are all that one response —
   * so it says the read failed and draws nothing else. Not the sentence above, which would be a
   * claim; and not the list either, because a page of switches built from no actions reads as a
   * Bot that holds none. Follows `admin/components/$name`, which states a failed read the same way.
   */
  if (!server) {
    return (
      <PageShell
        backButton={{ label: paths.pluginsLabel, linkProps: paths.plugins() }}
        title="插件"
      >
        <p className="mt-12 text-destructive text-sm" role="alert">
          读不到插件。
        </p>
      </PageShell>
    );
  }

  /*
   * Gated on the roster having ARRIVED, not on `bot` being missing — the same guard as the app
   * check above, over the other query.
   *
   * `isPending` goes false on a failed fetch exactly as it does on a successful one, so `!bot`
   * alone cannot tell "this deployment has no such Bot" apart from "the roster could not be read"
   * — and the first of those is a claim, made about a Bot that may be perfectly real, on the
   * evidence of a request that never came back. See `tests/agent-roster-error.test.tsx`, which
   * exists for the same mistake on the two screens that shipped it. With no roster the grants
   * below are still the plugins query's own answer and still true; the name falls back to the id.
   */
  // Both rosters, because a Bot absent from the visible one may simply be hidden.
  if (agents.data && hiddenAgents.data && !bot) {
    return (
      <PageShell
        backButton={back}
        description="没有叫这个名字的员工。"
        title="不是员工"
      >
        <PageEmpty icon={IconBolt} title="找不到这位员工">
          它可能在你打开这个页面之后被删除了。
        </PageEmpty>
      </PageShell>
    );
  }

  /*
   * From the row itself, found in either roster. Without one a roster is loading or failed (a Bot
   * missing from both is answered above), and on this Admin page the id is then the only name there
   * is, so it stands in. Screens a person reads go through `useBotNames`, which never shows an id.
   */
  // `nameFor` answers "" while the roster loads, so the id stands in only until a name is known.
  const botName = bot?.name ?? (nameFor(agentId) || agentId);
  const held = (tool: PluginTool) => tool.grantedTo.includes(agentId);

  /*
   * What the search is over: the action's own name, which is what somebody arriving here already
   * knows. An app of this size is not read top to bottom, and a field that searched descriptions
   * too would answer a typed name with a screenful of rows that do not carry it.
   */
  const needle = search.trim().toLowerCase();
  const matching = needle
    ? server.tools.filter((tool) => tool.name.toLowerCase().includes(needle))
    : server.tools;
  const reads = matching.filter((tool) => tool.effect === "read");
  const writes = matching.filter((tool) => tool.effect === "write");

  /*
   * What the Bot would hold afterwards, counted over every tool rather than the filtered ones: the
   * button grants every read whatever the search is showing, and a count that moved while somebody
   * typed would be describing a different action than the one the button takes.
   */
  const everyRead = readOnlyRefs(server.tools);
  const ungranted = everyRead.filter(
    (ref) => !server.tools.some((tool) => tool.ref === ref && held(tool)),
  );
  const wouldHold = server.tools.filter(
    (tool) => held(tool) || tool.effect === "read",
  ).length;

  /*
   * The approval already standing for THIS app, read off the Bot's own exposure rather than off any
   * one tool — a grant is per-action but the account behind a Shared app is one account, approved or
   * not for the whole of it. `undefined` while `exposure` has not answered yet, which is exactly what
   * routes a switch flipped mid-load to the dialog: see the comment on `onCheckedChange` below.
   */
  const sharedApp = exposure.data?.apps.find(
    (app) => app.serverId === (server?.id ?? key),
  );

  /*
   * The confirm button on the shared-grant dialog: the one write a switched-on Switch is still
   * waiting for once somebody has set the audience they want. `grantPlugin` takes the approval
   * directly — this is the one request in the app allowed to set one, being an administrator's own
   * narrowing of it — and the dialog closes only once the grant is in and the page has refetched, so
   * it never reports done while the switch underneath it is still off.
   */
  const confirmSharedGrant = async () => {
    if (!pendingGrant) return;
    setError(null);
    setGrantingShared(true);
    try {
      await grantPlugin({
        agentId,
        kind: "mcp",
        ref: pendingGrant.ref,
        approval,
      });
      await invalidatePlugins(queryClient);
      await queryClient.invalidateQueries({
        queryKey: sharedUseKeys.bot(agentId),
      });
      setPendingGrant(null);
    } catch (thrown) {
      setError((thrown as Error).message);
    } finally {
      setGrantingShared(false);
    }
  };

  /** One card of switchable rows. Both sections are the same row, so they are the same code. */
  const rows = (tools: PluginTool[]) => (
    <PageRows>
      {tools.map((tool, index) => (
        <React.Fragment key={tool.ref}>
          <Item size="sm">
            <ItemContent>
              <ItemTitle className="font-mono text-xs">{tool.name}</ItemTitle>
              <ItemDescription>
                {tool.description || "这个动作没有附带说明。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {/*
               * Drawn only for an action the vendor warns about, and nothing at all beside one it
               * does not. `destructive` is false when the vendor made no claim, which is not a
               * claim of safety — so an absence stays an absence here rather than becoming a green
               * word that says more than anybody knows.
               *
               * The destructive colour rather than the amber this app's tool list gives writes: the
               * heading over these rows already says they change things, and the one thing left to
               * say about this row is that what it changes does not come back.
               */}
              {tool.destructive ? (
                <span className="text-destructive text-xs">会造成破坏</span>
              ) : null}
              {/*
               * Binary and immediate, which is what a Switch is for: it takes effect when switched
               * and there is no save. It is on for a grant that exists and off otherwise — nothing
               * here is switched on by default, and nothing is proposed pre-switched. Disabled only
               * while its own write is in flight, so switching one action does not freeze the list.
               */}
              {alwaysOn ? (
                // Refused one Bot at a time by the server: Routines is every Bot's.
                <span className="text-muted-foreground text-xs">一直开着</span>
              ) : (
                <Switch
                  aria-label={`允许 ${botName} 调用 ${tool.name}`}
                  checked={held(tool)}
                  disabled={
                    granting !== null ||
                    pendingGrant?.ref === tool.ref ||
                    (setGrant.isPending && setGrant.variables?.ref === tool.ref)
                  }
                  onCheckedChange={(next) => {
                    setError(null);
                    /*
                     * A Shared app has one account behind every action on it, so switching one on is
                     * consent for what that account can do, not just for this row — and that consent
                     * is asked for once per app, not once per action. Already held for this app (an
                     * approval `exposure` already carries) takes the switch straight through below; not
                     * yet held — including while `exposure` is still loading, which is exactly when a
                     * stale "no approval yet" must not be trusted as the final answer — stops here and
                     * asks first.
                     */
                    if (next && shared && !sharedApp?.approval) {
                      setPendingGrant({ ref: tool.ref });
                      setApproval(
                        sharedApp?.needed ?? {
                          audience: "team",
                          outsideInput: false,
                          members: [],
                        },
                      );
                      return;
                    }
                    setGrant.mutate({
                      agentId,
                      granted: next,
                      kind: "mcp",
                      ref: tool.ref,
                    });
                  }}
                />
              )}
            </ItemActions>
          </Item>
          {index !== tools.length - 1 && <Separator />}
        </React.Fragment>
      ))}
    </PageRows>
  );

  return (
    <PageShell
      backButton={back}
      description={`${botName} 可以调用 ${appTitle} 的哪些动作。关掉一个会从下一次调用开始生效。`}
      title={`${botName} 与 ${appTitle}`}
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <SkippedToolsNotice names={server.skippedTools ?? []} />

      {server.tools.length === 0 ? (
        <PageEmpty icon={IconTool} title="没有列出任何动作">
          {toolsListError(server.lastError, {
            title: server.title,
            personal: false,
          }) ?? "刷新它的工具再看一次。"}
        </PageEmpty>
      ) : (
        <>
          {/*
           * The whole set in a sentence, above the switches that set it one action at a time. Not for
           * an app every Bot always has: there is nothing to choose.
           */}
          {alwaysOn ? null : (
            <DescribeGrants
              agentId={agentId}
              appKey={appKey}
              appTitle={appTitle}
              botName={botName}
              sharedNeeded={
                shared && !sharedApp?.approval
                  ? (sharedApp?.needed ?? {
                      audience: "team",
                      outsideInput: false,
                      members: [],
                    })
                  : null
              }
            />
          )}

          <Input
            aria-label={`搜索 ${appTitle} 的动作`}
            className="mt-6"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="按动作名搜索"
            value={search}
          />

          {/*
           * The one bulk action on this screen, and the count comes first: it says what the Bot
           * would hold afterwards, before anybody presses anything, because the alternative is a
           * button whose result is only visible once it has happened forty times.
           *
           * Hidden when there is nothing left for it to do. A button promising a state the Bot is
           * already in can only be pressed to find that out.
           */}
          {ungranted.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted-foreground text-xs">
                {`这样这位员工将拿到这个应用的 ${wouldHold} 个工具。`}
              </p>
              <Button
                disabled={granting !== null}
                onClick={() => void grantEveryRead(ungranted)}
                size="sm"
                type="button"
                variant="outline"
              >
                {/* The one in flight, not the ones finished: a count starting at zero of forty reads as nothing happening. */}
                {granting
                  ? `正在授予第 ${Math.min(granting.done + 1, granting.total)} 个，共 ${granting.total} 个…`
                  : "打开所有只读动作"}
              </Button>
            </div>
          ) : null}

          <PageSection
            description={
              sharedSectionSentence("read", shared) ??
              "这些只读。针对写入的边界规则对它们不生效。"
            }
            title="只读"
          >
            {reads.length === 0 ? (
              <PageEmpty
                icon={needle ? IconSearch : IconListDetails}
                title={needle ? "没有匹配的动作" : "没有只读动作"}
              >
                {needle
                  ? `没有匹配「${search.trim()}」的只读动作。`
                  : `${appTitle} 没有只读动作。`}
              </PageEmpty>
            ) : (
              rows(reads)
            )}
          </PageSection>

          <PageSection
            description={
              sharedSectionSentence("write", shared) ??
              "这些会在服务商那边改动东西。针对写入的边界规则对它们有效，命中时每次调用都会被拒绝。"
            }
            title="会改动"
          >
            {writes.length === 0 ? (
              <PageEmpty
                icon={needle ? IconSearch : IconListDetails}
                title={needle ? "没有匹配的动作" : "没有会改动东西的动作"}
              >
                {needle
                  ? `没有匹配「${search.trim()}」的改动类动作。`
                  : `${appTitle} 没有会改动东西的动作。`}
              </PageEmpty>
            ) : (
              rows(writes)
            )}
          </PageSection>

          {/*
           * Stacked over the switch it came from, same pattern as a Bot's delete confirmation in
           * `bot-profile/manage.tsx`: the consent a Shared app needs is its own moment, not a row that
           * happens to have grown a form. Closing without confirming — the backdrop, Escape, or
           * Cancel — leaves `pendingGrant` behind and the Switch stays exactly where it was; nothing
           * is granted until the confirm button below runs.
           */}
          <Dialog
            onOpenChange={(next) => !next && setPendingGrant(null)}
            open={pendingGrant !== null}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  让 {botName} 使用共享的 {appTitle} 账号？
                </DialogTitle>
              </DialogHeader>
              <DialogBody className="mt-4">
                <SharedApprovalFields onChange={setApproval} value={approval} />
              </DialogBody>
              {/*
               * The same `error` the rest of the screen reports a refused write with, shown here too:
               * the dialog stays open on a refusal rather than closing over it, so whoever is looking
               * at the form that was refused is where the reason has to be.
               */}
              {error ? (
                <p className="mt-4 text-destructive text-sm" role="alert">
                  {error}
                </p>
              ) : null}
              <DialogFooter className="mt-4">
                <Button
                  onClick={() => setPendingGrant(null)}
                  size="sm"
                  variant="outline"
                >
                  取消
                </Button>
                <Button
                  disabled={grantingShared}
                  onClick={() => void confirmSharedGrant()}
                  size="sm"
                >
                  {grantingShared ? "正在允许…" : "允许"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </PageShell>
  );
}
