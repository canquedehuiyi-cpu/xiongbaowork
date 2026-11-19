import { IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, buttonVariants } from "@/components/ui/button";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { appConfig } from "@/lib/generated/application-config";
import {
  dismissSelfHostBannerMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { cn } from "@/lib/utils";

/**
 * A slim bar pointing at this tenant's support address, until this person closes it.
 *
 * Hidden until both answers are in, so it never flashes on and then off: the deployment has to say
 * the banner is on (a fork running OpenBot for its own people turns it off), and this person's
 * preferences have to say they have not closed it. With no `supportUrl` in the tenant package there is
 * nowhere to send anyone, so it never shows.
 */
export function SelfHostBanner() {
  const queryClient = useQueryClient();
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const { data: preferences, userId } = useUserPreferences();
  const dismiss = useMutation(
    dismissSelfHostBannerMutationOptions(queryClient, userId),
  );

  const supportUrl = appConfig.brand.supportUrl;
  if (!supportUrl) return null;
  if (!capabilities?.selfHostBanner) return null;
  if (!preferences || preferences.selfHostBannerDismissed) return null;

  return (
    <aside
      aria-label="自行部署"
      className="flex shrink-0 flex-wrap items-center gap-x-2 border-b border-border bg-muted/60 px-4 py-1.5 text-sm"
    >
      {/*
       * Packed from the left rather than pushing Dismiss to the far right: on localhost CopilotKit's
       * dev inspector floats over the top-right corner, which is where somebody trying OpenBot first
       * sees this, and a Dismiss under it cannot be clicked.
       *
       * Wraps rather than truncates, so a phone reads the whole sentence. The link and Dismiss stay
       * together and drop to the next line as one, which keeps Dismiss on the left there too.
       */}
      <p className="text-foreground">为你的组织自行部署一套。</p>
      <span className="flex items-center gap-2">
        {/* An anchor, not Button: Base UI gives a rendered anchor role="button", and this is a link. */}
        <a
          // Foreground, not the link variant's primary, which is a mid grey on the dark bar.
          className={cn(
            buttonVariants({ size: "sm", variant: "link" }),
            "px-0 text-foreground underline",
          )}
          href={supportUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          联系工程师
        </a>
        <Button
          aria-label="关闭"
          onClick={() => dismiss.mutate()}
          size="icon-xs"
          variant="ghost"
        >
          <IconX />
        </Button>
      </span>
    </aside>
  );
}
