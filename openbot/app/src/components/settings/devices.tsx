import { IconDeviceMobile, IconDevices, IconSend } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
import { shortName } from "@/lib/brand";
import {
  deliveryQueryOptions,
  type Reachability,
  removePushDeviceMutationOptions,
} from "@/lib/delivery";
import { queryClient } from "@/query-client";

const PLATFORM: Record<"ios" | "android", string> = {
  ios: "iOS",
  android: "Android",
};

type Delivery = Reachability["deliveries"][number];

/** Each channel as the switches under 「更新发到哪里」 name it. */
const CHANNEL: Record<Delivery["transport"], string> = {
  push: "推送",
  slack: "Slack",
  teams: "Microsoft Teams",
  sms: "短信",
};

/**
 * What a delivery was about, as the kind of update it was routed under in "Where updates go", so a
 * row can be matched to the switch that let it through: a Bot's reply goes out as Progress, an
 * approval as a Decision, and a check-in ping as Something needs you.
 */
const KIND: Record<Delivery["kind"], string> = {
  reply: "进展",
  approval: "需要你决定",
  question: "提问",
  attention: "有事需要你",
};

/**
 * Where a delivery got to. `accepted` is the provider taking it without saying yet that it arrived,
 * and `unknown` is a send that may or may not have gone; the error under the row says which.
 */
const STATE: Record<Delivery["state"], string> = {
  queued: "等待发送",
  running: "发送中",
  accepted: "发送中",
  sent: "已发出",
  delivered: "已送达",
  failed: "发送失败",
  unknown: "未确认",
  opted_out: "未发送",
};

/** The phones that receive push notifications for every one of the person's employees. */
export function NativeDevices() {
  const reach = useQuery(deliveryQueryOptions());
  const remove = useMutation(removePushDeviceMutationOptions(queryClient));
  const error = reach.error ?? remove.error;
  return (
    <PageSection
      description={`在手机上登录${shortName()}应用并打开通知，它就会出现在这里。`}
      title="接收通知的手机"
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {reach.isPending || !reach.data ? null : reach.data.devices.length ===
        0 ? (
        <PageEmpty icon={IconDevices} title="还没有设备">
          你登录过的手机和电脑会出现在这里。
        </PageEmpty>
      ) : (
        <PageRows>
          {reach.data.devices.map((device, index) => (
            <Fragment key={device.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconDeviceMobile />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{PLATFORM[device.platform]}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(device.id)}
                    size="sm"
                    variant="outline"
                  >
                    移除
                  </Button>
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/** What was sent to the person outside the web app, most recent first, with any failure. */
export function RecentDeliveries() {
  const reach = useQuery(deliveryQueryOptions());
  return (
    <PageSection title="最近送达">
      {reach.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {reach.error.message}
        </p>
      ) : null}
      {reach.isPending || !reach.data ? null : reach.data.deliveries.length ===
        0 ? (
        <PageEmpty icon={IconSend} title="还没有送达记录">
          发到你设备上的通知会出现在这里。
        </PageEmpty>
      ) : (
        <PageRows>
          {reach.data.deliveries.map((delivery, index) => (
            <Fragment key={delivery.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconSend />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{KIND[delivery.kind]}</ItemTitle>
                  <ItemDescription>
                    {CHANNEL[delivery.transport]} · {STATE[delivery.state]} ·{" "}
                    {new Date(delivery.createdAt).toLocaleString()}
                  </ItemDescription>
                  {delivery.error ? (
                    <ItemDescription className="line-clamp-none text-destructive">
                      {delivery.error}
                    </ItemDescription>
                  ) : null}
                </ItemContent>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}
