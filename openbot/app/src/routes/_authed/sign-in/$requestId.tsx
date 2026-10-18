import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { SignInForm } from "@/components/passwords/sign-in-form";
import { signInRequestQueryOptions } from "@/lib/passwords/queries";

/**
 * The private sign-in form, on a page of its own.
 *
 * Its own route, outside the chat layout, because this is where a link sent to Slack, SMS or a phone
 * lands: a person can answer a Bot that is working unattended without opening its conversation, and
 * nothing typed here is ever part of one.
 */
export const Route = createFileRoute("/_authed/sign-in/$requestId")({
  component: SignInPage,
});

function SignInPage() {
  const { requestId } = Route.useParams();
  const request = useQuery(signInRequestQueryOptions(requestId));
  return (
    <PageShell
      title={request.data ? `登录 ${request.data.origin}` : "登录"}
      description={
        request.data?.reason ??
        "你的员工需要先登录才能继续。你在这里输入的内容会直接填进它的浏览器，不会进入对话。"
      }
    >
      <SignInForm requestId={requestId} />
    </PageShell>
  );
}
