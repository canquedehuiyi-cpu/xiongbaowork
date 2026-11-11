import { IconBolt, IconPlugOff, IconTool } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
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
import { agentListQueryOptions } from "@/lib/agents/queries";
import { ALWAYS_ON_APP } from "@/lib/connections/rows";
import { useManagePaths } from "@/lib/manage-paths";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * One tool, and which Bots hold it.
 *
 * Its own screen because a grant is a per-Bot decision and there is no upper bound on Bots. The
 * connector page used to draw a chip for every Bot inside every tool row: at three Bots and eight
 * tools that is twenty-four controls stacked in a list, wrapping onto second and third lines, where
 * the thing being decided — does THIS Bot get THIS tool — was the least legible part of it. Here each
 * Bot is one row with one switch, which is the same decision with nothing competing for it.
 *
 * Its routes use `$key_`, which opts them out of nesting under the connector page, so that page stays
 * a page rather than becoming a layout with an outlet.
 */
export function PluginToolPage({
  pluginKey: key,
  toolName,
}: {
  pluginKey: string;
  toolName: string;
}) {
  // Routines is every Bot's, in every edition: there is no switch to take it from one.
  const alwaysOn = key === ALWAYS_ON_APP;
  const paths = useManagePaths();
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  /* The ones this person has hidden, so a grant one of them holds still has its switch here. */
  const { data: hiddenAgents } = useQuery(agentListQueryOptions(true));
  /*
   * Whether a call from this Bot could be authenticated at all.
   *
   * Its own issued credential, or the deployment's shared one. Separate from the grant: the switch
   * decides whether the tool is offered to the model, this decides whether the call it makes gets
   * past the front door. A Bot with the grant and neither credential produced "May call this tool"
   * beside a tool that refused every call, with no audit row, because the call never arrived.
   */
  const sharedCallback = plugins.data?.botsMayCallBack === true;
  const canCallBack = (bot: { id: string }) =>
    sharedCallback ||
    [...(agents ?? []), ...(hiddenAgents ?? [])].find(
      (one) => one.id === bot.id,
    )?.hasCallbackToken === true;
  const [error, setError] = useState<string | null>(null);

  const setGrant = useMutation({
    ...setPluginGrantMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
  });

  const server = plugins.data?.servers.find((row) => row.id === key);
  const tool = server?.tools.find((row) => row.name === toolName);

  const back = {
    label: server?.title ?? "插件",
    linkProps: paths.plugin(key),
  };

  /* Nothing rather than a placeholder, so no sentence asserts anything while the fetch is open. */
  if (plugins.isPending) {
    return <PageShell title="工具">{null}</PageShell>;
  }

  /*
   * A plugin list that could not be read is said as that, not as a connector that is not enabled:
   * `isPending` goes false on a failed fetch too, and the sentence below is a claim about this
   * deployment that a request that never came back is no evidence for. The per-Bot grant screen
   * keeps the same guard.
   */
  if (!plugins.data) {
    return (
      <PageShell backButton={back} title={toolName}>
        <p className="mt-12 text-destructive text-sm" role="alert">
          读不到插件。请刷新页面。
        </p>
      </PageShell>
    );
  }

  if (!tool) {
    return (
      <PageShell
        backButton={back}
        description="这个连接器没有叫这个名字的工具。"
        title={toolName}
      >
        {/*
         * Says which of the two it is. A tool disappears from this list when the vendor stops
         * offering it, and that reads very differently from a mistyped address.
         */}
        <PageEmpty
          icon={server ? IconTool : IconPlugOff}
          title={server ? "找不到这个工具" : "这个连接器没有打开"}
        >
          {server
            ? "上次刷新工具列表之后，它可能已经被移除了。"
            : "打开它才能看到它的工具。"}
        </PageEmpty>
      </PageShell>
    );
  }

  /*
   * Everybody on the roster, and anybody hidden from it who holds this tool: see `grantRoster`.
   * Named from the roster rows themselves, because the id-to-name lookup other admin screens use is
   * built from the visible roster alone.
   */
  const bots = grantRoster({
    roster: agents ?? [],
    hidden: hiddenAgents ?? [],
    holders: tool.grantedTo,
  }).map((agent) => ({
    id: agent.id,
    name: agent.name,
    hidden: agent.hidden,
  }));

  return (
    <PageShell
      backButton={back}
      description={tool.description || "这个工具没有说明。"}
      title={toolName}
    >
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <PageSection
        description={
          tool.effect === "write"
            ? "这个工具会在服务商那边改动东西，针对写入的边界规则对它生效。"
            : "这个工具只读，针对写入的边界规则对它不生效。"
        }
        title="它做什么"
      >
        <PageRows>
          {/*
           * Read-only, and the layout skill's third row kind is right here: there is one of it, it is
           * the fact the section exists to state, and nothing about it is switchable. The effect
           * comes from the vendor's own classification, not from the tool's name.
           */}
          <Item size="sm">
            <ItemContent>
              <ItemTitle>影响</ItemTitle>
              <ItemDescription>
                由连接器标注，不看工具的名字。不知道的一律当作会改动。
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span
                className={
                  tool.effect === "write"
                    ? "text-amber-600 text-xs dark:text-amber-500"
                    : "text-muted-foreground text-xs"
                }
              >
                {tool.effect === "write" ? "会改动" : "只读"}
              </span>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      <PageSection
        description="员工只有在开关打开时才能调用这个工具。关掉从下一次调用开始生效。"
        title="员工"
      >
        {bots.length === 0 ? (
          <PageEmpty icon={IconBolt} title="还没有员工">
            先新建一位员工，再把这个工具给它。
          </PageEmpty>
        ) : (
          <PageRows>
            {bots.map((bot, index) => {
              const held = tool.grantedTo.includes(bot.id);
              return (
                <div key={bot.id}>
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{bot.name}</ItemTitle>
                      <ItemDescription>
                        {bot.hidden ? "已从你的员工列表里隐藏。" : ""}
                        {held
                          ? canCallBack(bot)
                            ? `可以调用这个工具。每次调用仍要经过边界规则检查，并记在${paths.auditLabel}里。`
                            : "已允许，但这位员工没有回调令牌，每次调用都会被拒绝。请在它的页面上签发一个，或者设置 AGENT_TOOL_TOKEN。"
                          : "不能调用这个工具，员工看不到它。"}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * Binary and immediate, which is what a Switch is for: it takes effect when
                       * switched and there is no save. Disabled only while its own write is in
                       * flight, so switching one Bot does not freeze the rest of the list.
                       */}
                      {alwaysOn ? (
                        // Refused one Bot at a time by the server: Routines is every Bot's.
                        <span className="text-muted-foreground text-xs">
                          一直开着
                        </span>
                      ) : (
                        <Switch
                          aria-label={`允许 ${bot.name} 调用 ${toolName}`}
                          checked={held}
                          disabled={
                            setGrant.isPending &&
                            setGrant.variables?.agentId === bot.id
                          }
                          onCheckedChange={(next) => {
                            setError(null);
                            setGrant.mutate({
                              agentId: bot.id,
                              granted: next,
                              kind: "mcp",
                              ref: tool.ref,
                            });
                          }}
                        />
                      )}
                    </ItemActions>
                  </Item>
                  {index !== bots.length - 1 && <Separator />}
                </div>
              );
            })}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
