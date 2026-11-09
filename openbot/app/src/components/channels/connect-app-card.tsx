import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useConnectInNewTab } from "@/components/plugins/connect-in-new-tab";
import { Button } from "@/components/ui/button";
import { type CardPlace, useCarryOn } from "@/lib/copilot/carry-on";
import {
  connectionsQueryOptions,
  personalConnections,
} from "@/lib/plugins/queries";
import { queryClient } from "@/query-client";

/**
 * The app a Bot needed, offered where the person is reading, instead of the name of a screen.
 *
 * A NEW TAB RATHER THAN THIS ONE, and that is the whole shape of this card. A consent screen is the
 * vendor's own page and the trip to it is a full navigation, so sending this tab would take the
 * person out of the conversation they are in the middle of and land them, several redirects later,
 * on the connected-accounts page with their question somewhere behind them. The flow finishes over
 * there; this tab stays where it was and watches for the connection to appear.
 *
 * WATCHING, NOT TRUSTING. The return trip proves nothing — it is an ordinary redirect in a tab this
 * one cannot read — so nothing here treats "they came back" as "it worked". The card polls this
 * person's own connections while it waits and only says connected when the server lists one.
 *
 * NOW THE FALLBACK RATHER THAN THE CARD. A refusal names the Bot it came from and `AppAccessCard`
 * draws it from the app's live state for this person on that Bot. This one is drawn only where no
 * Bot can be named — a refusal written before refusals carried one, on a surface that declared none
 * — and it can only offer Connect, which is all such a refusal ever meant.
 *
 * Once connected it carries the conversation on, as `AppAccessCard` does: see `useCarryOn`.
 */
export function ConnectAppCard({
  serverId,
  title,
  message,
  place,
}: {
  serverId: string;
  title: string;
  message: string;
  place?: CardPlace | undefined;
}) {
  const {
    open: openTab,
    waiting,
    stopWaiting,
    needsKey,
    blockedUrl,
    pending,
    error,
  } = useConnectInNewTab();
  const connections = useQuery({
    ...connectionsQueryOptions(),
    // Only while a consent is open in the other tab; otherwise this is an ordinary cached read.
    refetchInterval: waiting ? 2_000 : false,
  });
  /*
   * Upstream also skips a row whose access was withdrawn (`revoked`); this fork has no withdrawing
   * of somebody's access, so every row listed is a live connection.
   */
  const connected = personalConnections(
    connections.data?.connections ?? [],
  ).some((row) => row.serverId === serverId);
  // Every card drawn here is a refusal, so the app was blocked when the Bot asked.
  const { carried, offer } = useCarryOn({
    place,
    ready: connections.data ? connected : null,
    blockedWhenAsked: true,
    app: title,
  });

  /*
   * The grants a Bot holds are read per conversation, so the turn that follows has to be asked
   * against a store that knows about the new account. Invalidated once, on the edge.
   */
  const was = useRef(connected);
  useEffect(() => {
    if (connected && !was.current) {
      stopWaiting();
      void queryClient.invalidateQueries();
    }
    was.current = connected;
  }, [connected, stopWaiting]);

  const open = () => openTab(serverId);

  return (
    <div
      className="my-2 flex w-full max-w-2xl flex-col gap-3 rounded-xl border border-border p-4"
      data-connect-app={serverId}
    >
      <div className="flex flex-col gap-1">
        <p className="font-medium text-sm">连接 {title}</p>
        <p className="text-muted-foreground text-sm">{message}</p>
      </div>
      {connected ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm" role="status">
            {carried || offer
              ? `${title} 已连接。`
              : `${title} 已连接。再问一次，员工就能用它了。`}
          </p>
          {offer ? (
            <Button onClick={offer} size="sm">
              继续
            </Button>
          ) : null}
        </div>
      ) : needsKey ? (
        <p className="text-sm" role="status">
          {title} 需要你提供密钥。请在{" "}
          <Link
            className="underline underline-offset-2"
            params={{ key: serverId }}
            to="/settings/connected-accounts/$key"
          >
            {title} 的页面
          </Link>
          {" "}填好，然后再问一次。
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {/* The heading above already names the app; the button says what pressing it does. */}
          <Button disabled={pending} onClick={open} size="sm">
            {waiting ? `正在等待 ${title}…` : "连接"}
          </Button>
          {waiting ? (
            <p className="text-muted-foreground text-sm" role="status">
              在新打开的标签页里完成，然后回到这里。
            </p>
          ) : null}
          {blockedUrl ? (
            <p className="text-sm" role="status">
              浏览器拦截了新标签页。{" "}
              <a
                className="underline underline-offset-2"
                href={blockedUrl}
                rel="noreferrer"
                target="_blank"
              >
                打开 {title} 的登录页
              </a>
              。
            </p>
          ) : null}
          {error ? (
            <p className="break-words text-destructive text-sm" role="status">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
