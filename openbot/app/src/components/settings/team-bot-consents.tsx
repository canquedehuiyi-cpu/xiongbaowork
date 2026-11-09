import { useMutation, useQuery } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { clearTeamBotConsentsMutationOptions } from "@/lib/team-bots";

/**
 * A Bot someone shared with you uses its owner's connected apps unless you let it use yours on the
 * card it shows you. This forgets every one of those answers, so each such Bot asks again.
 *
 * On Approvals rather than Connections because it is an answer to "may this Bot use my apps",
 * which is the question every other row on Approvals answers, not a connection of its own.
 */
export function TeamBotConsents() {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const clear = useMutation(clearTeamBotConsentsMutationOptions());
  if (personal) return null;
  return (
    <PageSection
      description="共享给你的员工用的是它主人的应用。只有你在对话里同意过的地方，它才会用你的应用。"
      title="共享给你的员工"
    >
      {clear.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {clear.error.message}
        </p>
      ) : null}
      <PageRows>
        <Item size="sm">
          <ItemContent>
            <ItemTitle>你允许共享员工使用的应用</ItemTitle>
            <ItemDescription>
              {clear.isSuccess
                ? "已重置。每位共享员工都会重新问你。"
                : "清除所有回答，让每位共享员工重新问你。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
              size="sm"
              variant="outline"
            >
              重置
            </Button>
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}
