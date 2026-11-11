import { CopilotChat } from "@copilotkit/react-core/v2";
import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { ConversationApprovals } from "@/components/approvals/inline-approval";
import { TelemetryAssistantMessage } from "@/components/channels/telemetry-assistant-message";
import { ComputerChatControls } from "@/components/computer/computer-controls";
import { ComputerViewPanel } from "@/components/computer/computer-panel";
import { DetailPanel } from "@/components/layout/detail-panel";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { BearMascot } from "@/components/layout/workbench-empty";
import { Button } from "@/components/ui/button";
import { defaultAgentId } from "@/lib/agents/default-agent";
import {
  type AgentProfile,
  agentKeys,
  agentListQueryOptions,
} from "@/lib/agents/queries";
import { tryClient } from "@/lib/client";
import { useOpenComputerOnRequest } from "@/lib/computers/panel-view";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { useBotActivity } from "@/lib/copilot/bot-activity";
import { useBotThread } from "@/lib/copilot/bot-thread";
import { useStoppedTurn } from "@/lib/copilot/stopped-turn";
import { searchTextEntry } from "@/lib/search-text";

export const Route = createFileRoute("/_authed/_app/bot")({
  component: RouteComponent,
  /*
   * `?agent=` is read as text whatever the router parsed it into (`searchText`), because search
   * values are JSON-parsed and a Bot id made of digits would otherwise arrive as a number and open
   * this deployment's default Bot rather than the named one. `?watch=` is a flag and is read as the
   * boolean it is parsed into: anything else is not the flag being set.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { agent?: string; watch?: boolean } => ({
    ...searchTextEntry("agent", search.agent),
    ...(search.watch === true ? { watch: true } : {}),
  }),
});

/**
 * Which Bot this screen is for.
 *
 * WHATEVER THIS DEPLOYMENT ACTUALLY HAS. The default used to be a hardcoded `risk-analyst`, a name
 * from a tenant package this one is not: on a clone that ships anything else, opening this screen
 * without naming a Bot took the whole page down to an unstyled error boundary, because the chat
 * throws when asked for an agent the runtime never synced. OpenBot exists to be forked, so a Bot
 * name written into a route is a defect on every fork but the one it came from.
 *
 * A named Bot that this deployment does not have is answered in a sentence rather than thrown,
 * for the same reason: a mistyped link is not a crash.
 */
type BotDetailLookup =
  | { bot: AgentProfile; status: "found" }
  | { status: "missing" };

function isAgentEnvelope(body: unknown): body is { agent: AgentProfile } {
  if (body === null || typeof body !== "object") return false;
  const agent = (body as { agent?: unknown }).agent;
  return (
    agent !== null &&
    typeof agent === "object" &&
    typeof (agent as { id?: unknown }).id === "string" &&
    typeof (agent as { name?: unknown }).name === "string"
  );
}

async function loadExplicitBot(agentId: string): Promise<BotDetailLookup> {
  const response = await tryClient(
    `/api/agents/${encodeURIComponent(agentId)}`,
  );
  if (response.status === 404) return { status: "missing" };
  if (!response.ok) throw new Error("读不到这位员工。");

  const body: unknown = await response.json().catch(() => null);
  if (!isAgentEnvelope(body)) throw new Error("读不到这位员工。");
  return { bot: body.agent, status: "found" };
}

/**
 * The packaged chat's own words, in the language the rest of the app speaks. Only the strings a
 * person reads on this screen; anything left out keeps the package's default.
 */
const BOT_CHAT_LABELS = {
  chatInputPlaceholder: "有什么需要，尽管说",
  chatInputToolbarAddButtonLabel: "添加附件",
  chatInputToolbarStartTranscribeButtonLabel: "语音输入",
  chatInputToolbarCancelTranscribeButtonLabel: "取消语音输入",
  chatInputToolbarFinishTranscribeButtonLabel: "完成语音输入",
  chatInputToolbarToolsButtonLabel: "工具",
  assistantMessageToolbarCopyCodeLabel: "复制代码",
  assistantMessageToolbarCopyCodeCopiedLabel: "已复制",
  assistantMessageToolbarCopyMessageLabel: "复制",
  assistantMessageToolbarThumbsUpLabel: "有帮助",
  assistantMessageToolbarThumbsDownLabel: "没帮助",
  assistantMessageToolbarReadAloudLabel: "朗读",
  assistantMessageToolbarRegenerateLabel: "重新回答",
  userMessageToolbarCopyMessageLabel: "复制",
  userMessageToolbarEditMessageLabel: "编辑",
  chatDisclaimerText: "员工也会出错，重要信息请再核对。",
  welcomeMessageText: "有什么可以帮你？",
};

/*
 * The transcript in the redesign's two voices (docs/design/ios-studio), the same as a channel's: the
 * person's words in the pale #e9e9e9 bubble with dark ink, the coworker's answer on a graphite card
 * with a hairline border. The package draws with its own prefixed stylesheet, so these are marked
 * important to win over it rather than relying on which stylesheet happened to load last.
 */
const BOT_CHAT_VIEW = {
  userMessage: {
    messageRenderer:
      "bg-secondary! text-secondary-foreground! dark:bg-[#e9e9e9]! dark:text-[#161617]! rounded-[16px]!",
  },
};

/** The coworker's answer on a graphite card, reached through the answer's own `data-slot`. */
const ASSISTANT_CARD =
  "[&_[data-slot=assistant-answer]]:rounded-[14px] [&_[data-slot=assistant-answer]]:border [&_[data-slot=assistant-answer]]:border-border [&_[data-slot=assistant-answer]]:bg-card [&_[data-slot=assistant-answer]]:px-4 [&_[data-slot=assistant-answer]]:py-3 [&_[data-slot=assistant-answer]]:text-card-foreground [&_[data-slot=assistant-answer]]:shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]";

/** A whole-screen sentence (a read that failed, a Bot this deployment does not have), with 熊宝. */
function BotNotice({
  children,
  mood,
}: {
  children: ReactNode;
  mood: "naughty" | "cute";
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarToggleBar />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <BearMascot mood={mood} size={45} />
        {children}
      </div>
    </div>
  );
}

function RouteComponent() {
  const search = Route.useSearch();
  const agent = search.agent === "" ? undefined : search.agent;
  const {
    data: agents,
    isError,
    isPending,
  } = useQuery(agentListQueryOptions());
  const agentId = agent ?? defaultAgentId(agents);
  const listedBot = agents?.find((candidate) => candidate.id === agentId);
  const detailAgentId = agent ?? "";
  const shouldLoadExplicitBot =
    Boolean(agent) && agents !== undefined && listedBot === undefined;
  const {
    data: detail,
    isError: isDetailError,
    isPending: isDetailPending,
  } = useQuery({
    enabled: shouldLoadExplicitBot,
    queryKey: agentKeys.botRouteDetail(detailAgentId),
    queryFn: () => loadExplicitBot(detailAgentId),
    retry: false,
  });
  const bot =
    listedBot ?? (detail?.status === "found" ? detail.bot : undefined);
  const known = bot !== undefined;

  if (isPending || (shouldLoadExplicitBot && isDetailPending)) return null;
  if (isError && agents === undefined) {
    return (
      <BotNotice mood="naughty">
        <p className="font-medium text-[14px] text-signal-ink" role="alert">
          读不到员工列表。
        </p>
      </BotNotice>
    );
  }
  if (shouldLoadExplicitBot && isDetailError) {
    return (
      <BotNotice mood="naughty">
        <p className="font-medium text-[14px] text-signal-ink" role="alert">
          读不到这位员工。
        </p>
      </BotNotice>
    );
  }
  if (!agentId || !known) {
    return (
      <BotNotice mood="cute">
        <p className="font-medium text-[14px]">
          {agent
            ? `这个部署没有叫「${agent}」的员工。`
            : "这个部署还没有员工。"}
        </p>
      </BotNotice>
    );
  }

  /*
   * Keyed on the Bot, so the hooks below never see it change under them. They cannot be called
   * conditionally, and the guards above return before any of them run.
   */
  return <BotChat agentId={agentId} key={agentId} name={bot.name} />;
}

function BotChat({ agentId, name }: { agentId: string; name: string }) {
  // Tool calls here act on this Bot's own computer.
  useActiveBot(agentId);
  /*
   * Minted by this deployment rather than by the chat. `history` reports whether Intelligence
   * still recognised the thread this browser remembered from a previous visit; when it did not,
   * `useBotThread` has already swapped in a fresh id on its own; this flag exists only so the
   * page can say so instead of letting the Bot answer as if nothing were missing. `startNew`
   * mints another fresh thread on demand for the New chat control below.
   */
  const { threadId, history, startNew } = useBotThread(agentId);
  /*
   * A turn that ends without an answer has to be said out loud here, because the packaged chat says
   * nothing. It reports a failed run to an `onError` prop and otherwise carries on as though the
   * turn simply finished: the composer unlocks, the spinner goes, and the transcript keeps the
   * person's own message with nothing under it. The banner that would have explained it belongs to
   * a provider this app does not mount.
   */
  const stopped = useStoppedTurn(agentId);
  // What the Bot did on its computer in this conversation, for the Activity pane beside its screen.
  useBotActivity(agentId);
  const { watch } = Route.useSearch();
  const navigate = Route.useNavigate();
  const showComputer = (open: boolean) =>
    navigate({
      search: (previous) => ({ ...previous, watch: open ? true : undefined }),
    });
  // A command in the chat clicked opens the Computer on its terminal.
  useOpenComputerOnRequest(agentId, () => showComputer(true));

  return (
    <DetailPanel
      title="电脑"
      open={watch === true}
      onClose={() => showComputer(false)}
      waiting={threadId ? <ConversationApprovals threadId={threadId} /> : null}
      detail={<ComputerViewPanel agentId={agentId} name={name} />}
    >
      <div className="flex h-full min-h-0 flex-col">
        <SidebarToggleBar />
        {/*
         * An open heading on the canvas (docs/design/ios-studio): the coworker's face, its name and
         * one line of what this screen is for, with the screen's controls on the same row and a
         * hairline under it — no card, so the conversation below is the content.
         */}
        <header className="border-border border-b px-[13px] pb-3 md:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <AbstractAvatar
                decorative
                name={name}
                portrait={{ kind: "coworker", id: agentId }}
                seed={agentId}
                size={38}
              />
              <div className="min-w-0">
                {/*
                 * The Bot this screen is actually showing. A name written into the markup is wrong
                 * on every deployment whose package did not happen to use it, which is the same
                 * defect the route default above was fixed for: this screen called whichever Bot
                 * you opened "Browser Bot", including the one named something else two lines of
                 * state away.
                 */}
                <h1 className="truncate font-bold text-[18px] leading-tight tracking-tight">
                  {name}
                </h1>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  让它打开一个页面，看着它干活。
                </p>
              </div>
            </div>
            {/*
             * Labelled rather than the bare icon button the sidebar uses for its own "start
             * something new" control: that one opens an empty screen, but this one throws away
             * whatever conversation is currently on screen, and a click with that consequence
             * deserves a word, not just a glyph.
             */}
            <div className="flex flex-wrap items-start gap-2">
              <ComputerChatControls
                computerId={agentId}
                open={watch === true}
                onOpenChange={showComputer}
              />
              <Button onClick={startNew} size="sm" variant="ghost">
                <IconPlus />
                新对话
              </Button>
            </div>
          </div>
        </header>
        {/*
         * Both banners render as plain siblings in this fixed order, never one nested inside the
         * other, so either can appear alone or both together without the layout jumping around
         * depending on which conditions are true.
         */}
        {history === "unavailable" ? (
          <p
            className="border-signal/25 border-b bg-signal-soft px-[13px] py-2 text-[13px] text-signal-ink md:px-6"
            data-testid="bot-chat-history-unavailable"
            role="alert"
          >
            这段对话更早的消息没能加载，员工在没有这些消息的情况下回答。
          </p>
        ) : null}
        {/*
         * Under the header rather than at the end of the transcript, which is where the missing answer
         * was going to be and where the channel draws its own version of this. The packaged chat owns
         * that list and virtualises it, so reaching into it means replacing the whole message view and
         * taking on its scrolling. The cost of putting the sentence here instead is that it is not
         * beside the gap it explains; what it buys is that it is always on screen, whatever the
         * transcript has been scrolled to, and that it survives the next release of the chat.
         */}
        {stopped ? (
          <p
            className="border-signal/25 border-b bg-signal-soft px-[13px] py-2 text-[13px] text-signal-ink md:px-6"
            data-testid="bot-chat-stopped"
            role="alert"
          >
            {stopped}
          </p>
        ) : null}
        {/*
         * The package's input pill, framed like every composer in the app: graphite, a hairline that
         * brightens on focus, no drop shadow. Reached by the package's own stable class name.
         */}
        <div
          className={`min-h-0 flex-1 ${ASSISTANT_CARD} [&_.copilotKitInput:focus-within]:border-foreground/30 [&_.copilotKitInput]:rounded-[16px]! [&_.copilotKitInput]:border [&_.copilotKitInput]:border-border [&_.copilotKitInput]:bg-card! [&_.copilotKitInput]:shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]!`}
        >
          {/*
           * Keyed on the thread as well as the agent. Switching agents was already handled by
           * `agentId`, but `startNew` changes only the thread while the agent stays put, and the
           * packaged chat's own `startNewThread`/`setActiveThreadId` are proven no-ops once
           * `threadId` is a controlled prop (node_modules/@copilotkit/react-core/dist/copilotkit-
           * C4RqjAba.mjs:226-254): asking it to start over does nothing while it still holds the
           * old id. A key that omits the thread would leave the previous conversation on screen
           * under a composer that silently posts to the new one.
           */}
          {threadId ? (
            <CopilotChat
              agentId={agentId}
              messageView={{
                ...BOT_CHAT_VIEW,
                assistantMessage: TelemetryAssistantMessage,
              }}
              key={`${agentId}:${threadId}`}
              labels={BOT_CHAT_LABELS}
              threadId={threadId}
            />
          ) : null}
        </div>
      </div>
    </DetailPanel>
  );
}
