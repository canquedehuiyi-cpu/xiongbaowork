import { IconKey, IconLock, IconPointer } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  cancelSignInMutationOptions,
  confirmSavedLoginMutationOptions,
  finishSignInMutationOptions,
  submitSignInMutationOptions,
  takeOverSignInMutationOptions,
} from "@/lib/passwords/mutations";
import {
  FINAL_SIGN_IN,
  signInRequestQueryOptions,
} from "@/lib/passwords/queries";
import { queryClient } from "@/query-client";

/**
 * The private sign-in form.
 *
 * Outside the conversation on purpose: what is typed here goes to the server in one request and from
 * there straight into the Bot's browser. It is never a chat message, a tool argument or a tool
 * result, so the model never sees it, and the transcript never holds it. The password lives in this
 * component's state until it is sent and is cleared the moment it is.
 *
 * Four answers: type a login, confirm a saved one, take over the browser, or decline.
 */
export function SignInForm({ requestId }: { requestId: string }) {
  const request = useQuery({
    ...signInRequestQueryOptions(requestId),
    // Polled so a takeover finishing elsewhere, or the request expiring, shows here.
    refetchInterval: (query) =>
      query.state.data && FINAL_SIGN_IN.includes(query.state.data.status)
        ? false
        : 3_000,
  });
  const submit = useMutation(submitSignInMutationOptions(queryClient));
  const confirmSaved = useMutation(
    confirmSavedLoginMutationOptions(queryClient),
  );
  const takeOver = useMutation(takeOverSignInMutationOptions(queryClient));
  const finish = useMutation(finishSignInMutationOptions(queryClient));
  const cancel = useMutation(cancelSignInMutationOptions(queryClient));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [save, setSave] = useState(false);
  const id = useId();

  if (request.isPending) return null;
  if (request.error)
    return (
      <p className="text-destructive text-sm" role="alert">
        {request.error.message}
      </p>
    );
  const data = request.data;
  const busy =
    submit.isPending ||
    confirmSaved.isPending ||
    takeOver.isPending ||
    finish.isPending ||
    cancel.isPending;
  const failure =
    submit.error ??
    confirmSaved.error ??
    takeOver.error ??
    finish.error ??
    cancel.error;

  if (FINAL_SIGN_IN.includes(data.status))
    return (
      <PageSection title={data.status === "signed_in" ? "已登录" : "已关闭"}>
        <p className="text-muted-foreground text-sm">
          {data.outcome ?? "这个登录请求已经关闭了。"}
        </p>
      </PageSection>
    );

  if (data.status === "taken_over")
    return (
      <PageSection
        title="手动登录"
        description="接管员工的浏览器，登录后交还给它。然后告诉它你已完成，员工就会接着做。"
      >
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            render={
              <Link to="/bot" search={{ agent: data.botId, watch: true }} />
            }
          >
            打开员工的浏览器
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => finish.mutate(requestId)}
          >
            {finish.isPending ? "正在完成…" : "我已登录"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => cancel.mutate(requestId)}
          >
            取消
          </Button>
        </div>
        {failure ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {failure.message}
          </p>
        ) : null}
      </PageSection>
    );

  return (
    <>
      {data.outcome ? (
        <p className="text-destructive text-sm" role="alert">
          {data.outcome}
        </p>
      ) : null}
      {data.savedLogins.length > 0 ? (
        <PageSection
          title="使用已保存的登录"
          description={`选择一个即表示确认它可以用于这次登录 ${data.origin}。`}
        >
          <PageRows>
            {data.savedLogins.map((login, index) => (
              <div key={login.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{login.username}</ItemTitle>
                    <ItemDescription>{data.origin}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        confirmSaved.mutate(
                          {
                            id: requestId,
                            loginId: login.id,
                            ...(code ? { code } : {}),
                          },
                          { onSettled: () => setCode("") },
                        )
                      }
                    >
                      确认并登录
                    </Button>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
      <PageSection
        title="输入你的登录信息"
        description="直接填进员工的浏览器。员工只会知道登录成功与否。"
      >
        <form
          className="flex flex-col gap-3"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (!password) return;
            submit.mutate(
              {
                id: requestId,
                input: {
                  ...(username ? { username } : {}),
                  password,
                  ...(code ? { code } : {}),
                  save,
                },
              },
              {
                // Cleared whatever happened: a failed attempt is retyped, never kept.
                onSettled: () => {
                  setPassword("");
                  setCode("");
                },
              },
            );
          }}
        >
          <label
            className="flex flex-col gap-1 text-sm"
            htmlFor={`${id}-username`}
          >
            用户名或邮箱
            <Input
              id={`${id}-username`}
              autoComplete="username"
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label
            className="flex flex-col gap-1 text-sm"
            htmlFor={`${id}-password`}
          >
            密码
            <Input
              id={`${id}-password`}
              autoComplete="current-password"
              name="password"
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-code`}>
            验证码（如果网站要求）
            <Input
              id={`${id}-code`}
              autoComplete="one-time-code"
              inputMode="numeric"
              name="code"
              type="password"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          {data.passwordManager ? (
            <label
              className="flex items-center gap-2 text-sm"
              htmlFor={`${id}-save`}
            >
              <Checkbox
                id={`${id}-save`}
                checked={save}
                onCheckedChange={(checked) => setSave(checked === true)}
              />
              保存到密码
            </label>
          ) : null}
          {failure ? (
            <p className="text-destructive text-sm" role="alert">
              {failure.message}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={busy || !password}>
              <IconLock />
              {submit.isPending ? "正在登录…" : "登录"}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => takeOver.mutate(requestId)}
            >
              <IconPointer />
              接管并登录
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => cancel.mutate(requestId)}
            >
              拒绝
            </Button>
          </div>
        </form>
      </PageSection>
    </>
  );
}
