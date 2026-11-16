import { IconRoute } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { buttonVariants } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { setUpdateRoutingMutationOptions } from "@/lib/bot-lifecycle/mutations";
import {
  type UpdateKind,
  type UpdateTransport,
  updateRoutingQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { shortName } from "@/lib/brand";
import { deliveryQueryOptions } from "@/lib/delivery";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { appConfig } from "@/lib/generated/application-config";
import { mayOpenSetup } from "@/lib/setup/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/**
 * 「消息发到哪里」（M5b 从熊宝员工详情页的 `bot-profile/profile.tsx` 搬来，跟上游一样放在设置 › 通知里，
 * 对这个人所有员工生效）。
 *
 * How each channel is turned on: Slack and Teams through an OpenTag pairing, text messages through Twilio, push through
 * the OpenBot phone app. Each is a setting where OpenBot runs, read at start-up, so the docs say what to set; the two
 * sections sit together there. The setup checklist links the same page for Slack and Teams: the deployment's support
 * page (brand `support_url`), and no link when it publishes none.
 */

const KIND_LABEL: Record<UpdateKind, { title: string; description: string }> = {
  progress: {
    title: "进展",
    description: "你没在看时，员工做的事的回复和结果。",
  },
  decision: {
    title: "决定",
    description: "员工动手前需要你批准的事。",
  },
  question: {
    title: "提问",
    description: "员工问了你、正在等你回答的事。",
  },
  attention: {
    title: "有事需要你",
    description:
      "员工在主动巡检里发现、需要你处理的事，每小时最多一次，所有员工汇总在一条提醒里。",
  },
};

const TRANSPORTS: { id: UpdateTransport; label: string }[] = [
  { id: "push", label: "推送" },
  { id: "slack", label: "Slack" },
  { id: "teams", label: "Microsoft Teams" },
  { id: "sms", label: "短信" },
];

/**
 * Which channels each kind of update may use, for every one of the person's Bots at once. How much
 * a given Bot sends is that Bot's own Notifications setting, on its page.
 */
export function UpdateRoutingSection() {
  const routing = useQuery(updateRoutingQueryOptions());
  const reach = useQuery(deliveryQueryOptions());
  const save = useMutation(setUpdateRoutingMutationOptions(queryClient));
  /*
   * Who can turn a channel on: an admin, or the one person running OpenBot themselves (the same rule as Settings,
   * Setup). They get the way to; anyone else is told it's their admin's to do.
   */
  const user = useQuery(currentUserQueryOptions());
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const setsUp = mayOpenSetup(user.data, capabilities.data);
  /*
   * A channel this deployment has not set up can carry nothing, so its switch is off and disabled
   * whatever the stored preference says, rather than on beside a channel that delivers nothing. The
   * preference itself is left alone: an administrator who configures Slack later finds it as the
   * person last set it. When the deployment's channels could not be read, the preference is shown
   * as it is rather than every channel claimed unavailable.
   */
  const configured = (transport: UpdateTransport) =>
    reach.data ? reach.data.available[transport] : true;
  /*
   * Only the channels that can carry something get a switch. A channel that is not set up has nothing to choose, and
   * four rows of switches nobody can turn on said less than one sentence does. Its stored preference is kept as it is
   * and shows again once the channel is set up.
   */
  const shown = TRANSPORTS.filter((transport) => configured(transport.id));
  const choosing =
    !routing.isPending &&
    !reach.isPending &&
    !routing.error &&
    shown.length > 0;
  /*
   * OpenBot Desktop runs OpenBot on this computer, and every one of these channels needs OpenBot where the internet can
   * reach it (a phone, OpenTag, Twilio calling it). Its settings are the Desktop's own, so it gets no link to them.
   */
  const desktop = desktopShell() !== null;
  const setupDocs = appConfig.brand.supportUrl;
  return (
    <PageSection
      // Said only above the switches: above the empty state it would point at nothing to choose.
      description={
        choosing
          ? "你没在看时，每类消息发到哪里。网页上始终显示全部。对你所有的员工生效。"
          : undefined
      }
      title="消息发到哪里"
    >
      {routing.isPending || reach.isPending ? null : routing.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          读不到你的消息去向设置，请刷新页面。
        </p>
      ) : shown.length === 0 ? (
        <PageEmpty
          action={
            setsUp && !desktop && setupDocs ? (
              // An anchor rather than Button: Base UI gives a rendered anchor role="button", and this is a link.
              <a
                className={cn(
                  buttonVariants({ size: "sm", variant: "outline" }),
                )}
                href={setupDocs}
                rel="noopener noreferrer"
                target="_blank"
              >
                怎么设置
              </a>
            ) : undefined
          }
          icon={IconRoute}
          title={`消息只在${shortName()}里显示`}
        >
          {desktop
            ? `推送、Slack、Microsoft Teams 和短信需要${shortName()}运行在服务器上。`
            : setsUp
              ? `在${shortName()}运行的地方设置好推送、Slack、Microsoft Teams 或短信后，就能在这里选择。`
              : "管理员设置好推送、Slack、Microsoft Teams 或短信后，就能在这里选择。"}
        </PageEmpty>
      ) : (
        <PageRows>
          {(Object.keys(KIND_LABEL) as UpdateKind[]).map((kind, index) => {
            const current = routing.data[kind];
            const allowed = (transport: UpdateTransport) =>
              current === "all" || current.includes(transport);
            return (
              <Fragment key={kind}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconRoute />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{KIND_LABEL[kind].title}</ItemTitle>
                    <ItemDescription>
                      {KIND_LABEL[kind].description}
                    </ItemDescription>
                  </ItemContent>
                  <ItemFooter className="flex-wrap justify-start gap-x-6 gap-y-3 pl-8">
                    {shown.map((transport) => (
                      <div
                        className="flex items-center gap-2 text-sm"
                        key={transport.id}
                      >
                        <Switch
                          aria-label={`${KIND_LABEL[kind].title}：${transport.label}`}
                          checked={
                            configured(transport.id) && allowed(transport.id)
                          }
                          disabled={save.isPending || !configured(transport.id)}
                          onCheckedChange={(checked) => {
                            const next = TRANSPORTS.map((t) => t.id).filter(
                              (id) =>
                                id === transport.id ? checked : allowed(id),
                            );
                            save.mutate({
                              kind,
                              transports:
                                next.length === TRANSPORTS.length
                                  ? "all"
                                  : next,
                            });
                          }}
                          size="sm"
                        />
                        <span className="leading-tight whitespace-nowrap">
                          {transport.label}
                        </span>
                      </div>
                    ))}
                  </ItemFooter>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}
    </PageSection>
  );
}
