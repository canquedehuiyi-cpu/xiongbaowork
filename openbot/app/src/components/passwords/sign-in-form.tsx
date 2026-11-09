import {
  IconKey,
  IconLock,
  IconPointer,
  IconShieldCheck,
} from "@tabler/icons-react";
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
  submitSignInCodeMutationOptions,
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
 *
 * A verification code is never asked for here up front. If the site, once it has the password, sends
 * one, the server reports `code_required` and this form asks for that code alone, then sends it on
 * its own, cleared from state the same way.
 */
export function SignInForm({
  requestId,
  inDialog = false,
}: {
  requestId: string;
  /** Drawn in the chat's sign-in dialog rather than on the page of its own. */
  inDialog?: boolean;
}) {
  const request = useQuery({
    ...signInRequestQueryOptions(requestId),
    // Polled so a takeover finishing elsewhere, or the request expiring, shows here.
    refetchInterval: (query) =>
      query.state.data && FINAL_SIGN_IN.includes(query.state.data.status)
        ? false
        : 3_000,
  });
  const submit = useMutation(submitSignInMutationOptions(queryClient));
  const submitCode = useMutation(submitSignInCodeMutationOptions(queryClient));
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
  /*
   * In a dialog the sections stack in its body's own 16px rhythm. The 48px a page puts above each
   * section, to keep unrelated decisions apart, left the dialog mostly empty space above each heading.
   */
  const section = inDialog ? "mt-0" : undefined;

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
    submitCode.isPending ||
    confirmSaved.isPending ||
    takeOver.isPending ||
    finish.isPending ||
    cancel.isPending;
  const failure =
    submitCode.error ??
    submit.error ??
    confirmSaved.error ??
    takeOver.error ??
    finish.error ??
    cancel.error;

  if (FINAL_SIGN_IN.includes(data.status))
    return (
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
      <PageSection title={data.status === "signed_in" ? "已登录" : "已关闭"}>
        <p className="text-muted-foreground text-sm">
          {data.outcome ?? "这个登录请求已经关闭了。"}
=======
      <PageSection
        className={section}
        title={data.status === "signed_in" ? "Signed in" : "Closed"}
      >
        <p className="text-muted-foreground text-sm">
          {data.outcome ?? "This sign-in has ended."}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
        </p>
      </PageSection>
    );

  if (data.status === "code_required")
    return (
      <PageSection
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
        title="输入验证码"
        description="网站发来了验证码，输入后即可完成登录。"
=======
        className={section}
        title="Enter the verification code"
        description="The site sent a verification code. Enter it to finish signing in."
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
      >
        <form
          className="mt-4 flex flex-col gap-3"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            const value = code.trim();
            if (!value) return;
            submitCode.mutate(
              { id: requestId, code: value },
              // Cleared whatever happened: a code is good once, and a wrong one is retyped.
              { onSettled: () => setCode("") },
            );
          }}
        >
          <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-code`}>
            验证码
            <Input
              id={`${id}-code`}
              autoComplete="one-time-code"
              inputMode="numeric"
              name="code"
              required
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          {failure || data.outcome ? (
            <p className="text-destructive text-sm" role="alert">
              {failure?.message ?? data.outcome}
            </p>
          ) : null}
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={busy || !code.trim()}>
              <IconShieldCheck />
              {submitCode.isPending ? "正在核对…" : "完成登录"}
=======
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => cancel.mutate(requestId)}
            >
              Cancel
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
            </Button>
            <Button
              size="sm"
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => takeOver.mutate(requestId)}
            >
              <IconPointer />
              接管并完成登录
            </Button>
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => cancel.mutate(requestId)}
            >
              取消
=======
            <Button size="sm" type="submit" disabled={busy || !code.trim()}>
              <IconShieldCheck />
              {submitCode.isPending ? "Checking…" : "Finish signing in"}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
            </Button>
          </div>
        </form>
      </PageSection>
    );

  if (data.status === "taken_over")
    return (
      <PageSection
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
        title="手动登录"
        description="接管员工的浏览器，登录后交还给它。然后告诉它你已完成，员工就会接着做。"
=======
        className={section}
        title="Sign in by hand"
        description="Open the Bot's browser and sign in yourself. Then choose I've signed in and the Bot carries on."
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
      >
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => cancel.mutate(requestId)}
          >
            Cancel
          </Button>
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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => cancel.mutate(requestId)}
          >
            取消
          </Button>
=======
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
          title="使用已保存的登录"
          description={`选择一个即表示确认它可以用于这次登录 ${data.origin}。`}
=======
          className={section}
          title="Use a saved login"
          description={`Pick one to use it for this sign-in to ${data.origin}.`}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
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
                        confirmSaved.mutate({
                          id: requestId,
                          loginId: login.id,
                        })
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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
        title="输入你的登录信息"
        description="直接填进员工的浏览器。员工只会知道登录成功与否。"
=======
        className={section}
        title="Enter your login"
        description="This goes straight into the Bot's browser. The Bot only learns whether it worked."
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
      >
        <form
          className="mt-4 flex flex-col gap-3"
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
                  save,
                },
              },
              {
                // Cleared whatever happened: a failed attempt is retyped, never kept.
                onSettled: () => setPassword(""),
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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={busy || !password}>
              <IconLock />
              {submit.isPending ? "正在登录…" : "登录"}
=======
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => cancel.mutate(requestId)}
            >
              Decline
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => cancel.mutate(requestId)}
            >
              拒绝
=======
            <Button size="sm" type="submit" disabled={busy || !password}>
              <IconLock />
              {submit.isPending ? "Signing in…" : "Sign in"}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
            </Button>
          </div>
        </form>
      </PageSection>
    </>
  );
}
