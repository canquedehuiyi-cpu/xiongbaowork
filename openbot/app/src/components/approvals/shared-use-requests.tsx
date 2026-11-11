import { IconShare } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  decideSharedUseMutationOptions,
  describeApproval,
  type SharedUseRequestReason,
  sharedUseRequestsQueryOptions,
} from "@/lib/plugins/shared-use";

const WHY: Record<SharedUseRequestReason, string> = {
  refused_call: "有个动作被拦下了：能用这位员工的人比批准的多。",
  publish: "它的主人放宽了谁能用它。",
  trigger: "它的主人加了一个触发方式，外部消息可以指挥它。",
  grant: "它拿到了这个应用的动作。",
};

/**
 * Requests to use a shared account, for an administrator to approve or decline: one row each,
 * saying what is approved now against what is asked, with the decision beneath. Nothing is drawn
 * for anyone else, or when nothing is waiting.
 */
export function SharedUseRequests() {
  const queryClient = useQueryClient();
  const me = useQuery(currentUserQueryOptions()).data;
  const isAdmin = me?.role === "admin";
  const requests = useQuery(sharedUseRequestsQueryOptions(isAdmin));
  const decide = useMutation(decideSharedUseMutationOptions(queryClient));
  if (!isAdmin || !requests.data?.length) return null;

  return (
    <PageSection title="团队账号使用申请">
      {decide.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {decide.error.message}
        </p>
      ) : null}
      <PageRows>
        {requests.data.map((request, index) => (
          <Fragment key={request.id}>
            {index > 0 ? <Separator /> : null}
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconShare />
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="line-clamp-none">
                  {request.botName} 想用 {request.title} 的团队账号
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {WHY[request.reason as SharedUseRequestReason] ??
                    request.reason}
                </ItemDescription>
                <p className="text-sm">
                  现在：
                  {request.current
                    ? describeApproval(request.current)
                    : "未批准"}
                </p>
                <p className="text-sm">
                  申请：{describeApproval(request.proposed)}
                </p>
              </ItemContent>
              <ItemFooter className="justify-start">
                <Button
                  disabled={decide.isPending}
                  onClick={() =>
                    decide.mutate({ id: request.id, decision: "approve" })
                  }
                  size="sm"
                >
                  批准
                </Button>
                <Button
                  disabled={decide.isPending}
                  onClick={() =>
                    decide.mutate({ id: request.id, decision: "decline" })
                  }
                  size="sm"
                  variant="outline"
                >
                  拒绝
                </Button>
              </ItemFooter>
            </Item>
          </Fragment>
        ))}
      </PageRows>
    </PageSection>
  );
}
