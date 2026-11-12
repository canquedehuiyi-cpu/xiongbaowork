import type { ListedRecorderConnection } from "@openbot/shared/recorder-api";
import { IconBrowser } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { appConfig } from "@/lib/generated/application-config";
import { revokeRecorderConnectionMutationOptions } from "@/lib/recorder/mutations";
import { recorderConnectionsQueryOptions } from "@/lib/recorder/queries";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

/** What the server names a person's own browser's connection now (browser/routes.ts); a row stored before the rename
 * still holds the upstream name, so the row is drawn under this one instead. */
const OWN_BROWSER_LABEL = `${appConfig.brand.englishName ?? "XiongBao Work"} browser`;

/** When a browser connected, to the minute: two copies with the same name (two Chrome profiles) stay told apart. */
const connectedAt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** The browsers signed in to this OpenBot as you, each with a Disconnect that revokes its sign-in. The row of the copy
 * in this browser (`thisInstallId`, from This browser) says so. */
export function ConnectedBrowsers({
  thisInstallId,
}: {
  thisInstallId?: string;
} = {}) {
  const connections = useQuery(
    recorderConnectionsQueryOptions({ listed: true }),
  );
  return (
    <PageSection title="已连接的浏览器">
      {connections.isPending ? null : connections.error ? (
        <p className="text-destructive text-sm" role="alert">
          读不到你已连接的浏览器。请刷新页面。
        </p>
      ) : connections.data.connections.length === 0 ? (
        <PageEmpty>还没有连接任何浏览器。</PageEmpty>
      ) : (
        <PageRows>
          {connections.data.connections.map((connection, index) => (
            <Fragment key={connection.id}>
              {index > 0 ? <Separator /> : null}
              <ConnectedBrowserRow
                connection={connection}
                here={
                  thisInstallId !== undefined &&
                  connection.installId === thisInstallId
                }
              />
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/**
 * One connected browser, with its own Disconnect: asked first in a dialog, because it signs that browser's Recorder out
 * and stops a recording running there, and pending for this row alone, so disconnecting one browser leaves every other
 * row's button as it was. A refusal is said in the dialog, where the person asked.
 */
function ConnectedBrowserRow({
  connection,
  here,
}: {
  connection: ListedRecorderConnection;
  /** The copy of the Recorder in the browser this page is open in. */
  here: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const revoke = useMutation(
    revokeRecorderConnectionMutationOptions(queryClient),
  );
  const label =
    connection.via === "openbot-browser" ? OWN_BROWSER_LABEL : connection.label;
  const name = here ? `${label} · 当前浏览器` : label;
  // The browser the dialog is about, by the name the row shows: "this browser" only for the copy in the browser this page
  // is open in, which every row's dialog used to say.
  const which = here
    ? "当前浏览器"
    : connection.via === "openbot-browser"
      ? "你的熊宝浏览器"
      : label;
  return (
    <>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconBrowser />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{name}</ItemTitle>
          <ItemDescription>
            {connection.via === "openbot-browser" ? "你的熊宝浏览器，" : ""}
            {connectedAt.format(new Date(connection.createdAt))} 连接
            {connection.via === "desktop"
              ? "，来自熊宝桌面端"
              : connection.via === "web"
                ? "，来自熊宝网页"
                : ""}
            ，
            {/* A recording streams to the gateway, not to OpenBot, so its last use lags: it says so instead. */}
            {connection.recording
              ? "正在录制"
              : connection.lastUsedAt
                ? `最近使用：${relativeTime(connection.lastUsedAt)}`
                : "从未使用"}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button
            aria-label={`断开${name}`}
            size="sm"
            variant="ghost"
            disabled={revoke.isPending}
            onClick={() => {
              revoke.reset();
              setAsking(true);
            }}
          >
            {revoke.isPending ? "正在断开…" : "断开"}
          </Button>
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setAsking} open={asking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>断开{label}？</DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4 text-sm">
            <p>
              熊宝会让{which}
              里的录制器退出登录。重新连接之前，它不会再为你录制任何内容，正在那里进行的录制也会停止。
            </p>
            {revoke.error ? (
              <p className="mt-2 text-destructive" role="alert">
                {revoke.error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() =>
                revoke.mutate(connection.id, {
                  onSuccess: () => setAsking(false),
                })
              }
            >
              {revoke.isPending ? "正在断开…" : "断开"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
