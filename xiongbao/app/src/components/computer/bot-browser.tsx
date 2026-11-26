import { useMutation } from "@tanstack/react-query";
import type { BotBrowserApiState } from "@xiongbao/shared/bot-browser";
import { type ReactNode, useId } from "react";
import {
  AddressBar,
  ClearBrowserDialog,
  latest,
  shownAddress,
  TabPanel,
  TabStrip,
  useClearBrowserData,
  useOpenedTab,
} from "@/components/browser/browser-bar";
import {
  botBrowserTabsMutationOptions,
  clearBotBrowserMutationOptions,
  navigateBotBrowserMutationOptions,
} from "@/lib/bot-browser/mutations";
import { queryClient } from "@/query-client";

/*
 * A BOT'S BROWSER, WORKED BY A PERSON (`shared/bot-browser.ts`): the bar above the Bot's screen.
 *
 * Built from the shared browser parts (`components/browser/browser-bar.tsx`). The bar acts only for the person who
 * holds the wheel (`mine`, the server's verdict).
 */

/**
 * Tabs, back, forward, reload and the address, above the Bot's screen (`children`), which is the tabs' panel with the
 * address. Live for the person holding the wheel; while the Bot (or someone else) holds it, it shows where the Bot is,
 * and nothing in it acts.
 *
 * Until the Bot's browser has first answered (`state` undefined) there is no bar, only the screen: and the screen keeps
 * its place in the tree when the bar arrives, so its live stream is not opened a second time.
 *
 * `onNavigated` is told when an address typed in the bar goes, so the keyboard can go back to the page, as Chrome's
 * address bar gives it to the page it opens.
 */
export function BotBrowserBar({
  botId,
  state,
  onNavigated,
  children,
}: {
  botId: string;
  state: BotBrowserApiState | undefined;
  onNavigated?: () => void;
  children: ReactNode;
}) {
  const tabs = useMutation(botBrowserTabsMutationOptions(queryClient, botId));
  const navigate = useMutation(
    navigateBotBrowserMutationOptions(queryClient, botId),
  );
  const clear = useMutation(clearBotBrowserMutationOptions(queryClient, botId));
  const clearing = useClearBrowserData(clear);
  const ids = useId();
  const active = state?.tabs.find((tab) => tab.active);
  const newTab = useOpenedTab(active?.id);
  const live = state ? state.mine && state.open : false;
  // A refusal belongs to the person who asked while they could. Once the wheel has gone, the bar is the Bot's and the
  // sentence about the person's last request is not news.
  const failure = live
    ? latest([
        { error: tabs.error, at: tabs.submittedAt },
        { error: navigate.error, at: navigate.submittedAt },
      ])
    : null;
  return (
    <>
      {state ? (
        <TabStrip
          ids={ids}
          tabs={state.tabs}
          disabled={!live}
          onActivate={(tabId) => tabs.mutate({ action: "activate", tabId })}
          onClose={(tabId, closed) =>
            tabs.mutate(
              { action: "close", tabId },
              closed ? { onSuccess: closed } : undefined,
            )
          }
          onNew={() =>
            tabs.mutate({ action: "new" }, { onSuccess: newTab.opened })
          }
        />
      ) : null}
      {/* Not min-h-0: the screen inside keeps its floor, and the window grows past it rather than clip it. */}
      <TabPanel
        active={active}
        className="flex flex-1 flex-col"
        ids={ids}
        tabs={state !== undefined}
      >
        {state ? (
          <AddressBar
            // A new tab, switching to one, or the wheel changing hands starts the bar again from the tab's own address:
            // an address half typed before the wheel went is not where the browser is when it comes back.
            key={`${active?.id ?? "none"}:${state.mine}`}
            address={shownAddress(active)}
            disabled={!state.open || !active}
            readOnly={!state.mine}
            focus={newTab.focus}
            onFocused={newTab.onFocused}
            onGo={(url) => {
              navigate.mutate({ url });
              // Away to the page, as Chrome's address bar does: the next keys are for the page that opens.
              onNavigated?.();
            }}
            onMove={(action) => navigate.mutate({ action })}
            // Only for the person holding the wheel, so the browser is never wiped under the Bot. Open or closed: its
            // data is there either way.
            clear={{ disabled: !state.mine, ask: clearing.ask }}
          />
        ) : null}
        {failure ? (
          <p
            className="border-b border-border px-3 py-2 text-destructive text-sm"
            role="alert"
          >
            {failure.message}
          </p>
        ) : null}
        {children}
      </TabPanel>
      {/* Over the Bot's screen, which is a dialog itself. */}
      <ClearBrowserDialog
        clear={clear}
        open={clearing.asking}
        onOpenChange={clearing.setAsking}
        stacked
      />
    </>
  );
}
