import { IconKey, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
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
import { deleteSavedLoginMutationOptions } from "@/lib/passwords/mutations";
import { savedLoginsQueryOptions } from "@/lib/passwords/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/passwords")({
  component: PasswordsPage,
});

/**
 * The logins you saved from a private sign-in form.
 *
 * The site and username only: a password is write-only, and this page can delete one but never show
 * it. A saved login is used only when you confirm it in a sign-in form.
 */
function PasswordsPage() {
  const logins = useQuery(savedLoginsQueryOptions());
  const remove = useMutation(deleteSavedLoginMutationOptions(queryClient));
  return (
    <PageShell
      title="密码"
      description="你在帮员工登录网站时保存的登录信息。员工永远看不到它们，每次使用都需要你确认。"
    >
      <PageSection title="已保存的登录">
        {logins.isPending ? null : logins.error ? (
          <p className="text-destructive text-sm" role="alert">
            读不到你保存的密码。
          </p>
        ) : !logins.data.passwordManager ? (
          <PageEmpty>
            这个工作区关闭了密码保存。已有的登录信息会保留，但不会再提供。
          </PageEmpty>
        ) : logins.data.logins.length === 0 ? (
          <PageEmpty>
            还没有保存的登录。帮员工登录网站时勾选“保存到密码”即可。
          </PageEmpty>
        ) : (
          <PageRows>
            {logins.data.logins.map((login, index) => (
              <div key={login.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{login.origin}</ItemTitle>
                    <ItemDescription>
                      {login.username}
                      {login.lastUsedAt
                        ? ` · 上次使用 ${new Date(login.lastUsedAt).toLocaleDateString("zh-CN")}`
                        : " · 从未使用"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={`删除 ${login.origin} 的登录信息`}
                      size="sm"
                      variant="ghost"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(login.id)}
                    >
                      <IconTrash />
                    </Button>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        )}
        {remove.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {remove.error.message}
          </p>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
