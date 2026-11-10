import { IconKey, IconLockOff, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { deleteSavedLoginMutationOptions } from "@/lib/passwords/mutations";
import { savedLoginsQueryOptions } from "@/lib/passwords/queries";
import { queryClient } from "@/query-client";

/**
 * The logins you saved from a private sign-in form.
 *
 * The site and username only: a password is write-only, and this page can delete one but never show
 * it. A saved login is used only when you confirm it in a sign-in form.
 *
 * Under Settings. The personal edition calls it Saved logins, and links to it from Connections too.
 */
export function PasswordsPage() {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const logins = useQuery(savedLoginsQueryOptions());
  const remove = useMutation(deleteSavedLoginMutationOptions(queryClient));
  return (
    <PageShell
      title={personal ? "保存的登录" : "密码"}
      description="管理保存的网站登录信息。员工看不到你的密码，每次使用都要经过你批准。"
    >
      <PageSection title={personal ? undefined : "保存的登录"}>
        {logins.isPending ? null : logins.error ? (
          <p className="text-destructive text-sm" role="alert">
            读不到你的密码。请刷新页面。
          </p>
        ) : !logins.data.passwordManager ? (
          <PageEmpty icon={IconLockOff} title="保存密码已关闭">
            管理员关闭了这项功能。你的登录信息仍会保留，但不会再提供给员工。
          </PageEmpty>
        ) : logins.data.logins.length === 0 ? (
          <PageEmpty icon={IconKey} title="还没有保存的登录">
            替员工登录网站时，选择「保存到密码」即可。
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
                        ? ` · 最近使用：${new Date(login.lastUsedAt).toLocaleDateString()}`
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
