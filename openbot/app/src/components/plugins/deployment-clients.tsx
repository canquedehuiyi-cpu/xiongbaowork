import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  removeDeploymentClientMutationOptions,
  saveDeploymentClientMutationOptions,
} from "@/lib/plugins/mutations";
import { deploymentClientsQueryOptions } from "@/lib/plugins/queries";
import { queryClient } from "@/query-client";

/** The app names a client may be saved under, as the server checks them. */
const SLUG = /^[a-z0-9_-]+$/;
const SLUG_MAX = 64;
const CLIENT_ID_MAX = 512;
const CLIENT_SECRET_MAX = 4096;

/**
 * Why a client typed in cannot be sent, or null. The server checks the same and answers in its own
 * words; this only spares a round trip for what is plainly wrong.
 */
export function deploymentClientProblem(input: {
  toolkit: string;
  clientId: string;
  clientSecret: string;
}): string | null {
  const toolkit = input.toolkit.trim().toLowerCase();
  if (!toolkit || toolkit.length > SLUG_MAX || !SLUG.test(toolkit)) {
    return `应用名只能包含字母、数字、下划线和连字符，最长 ${SLUG_MAX} 个字符。`;
  }
  const id = input.clientId.trim();
  const secret = input.clientSecret.trim();
  if (!id || !secret) return "客户端 ID 和客户端密钥都要填写。";
  if (id.length > CLIENT_ID_MAX) {
    return `客户端 ID 不能超过 ${CLIENT_ID_MAX} 个字符。`;
  }
  if (secret.length > CLIENT_SECRET_MAX) {
    return `客户端密钥不能超过 ${CLIENT_SECRET_MAX} 个字符。`;
  }
  return null;
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("zh-CN");
}

/**
 * The OAuth clients this deployment registered itself, for the apps that connect server to server
 * (upstream #950; Shopify's `S2S_OAUTH2` is one).
 *
 * Such an app does not appear in the directory until its client is saved here, and adding it there
 * before that is refused with the server's own sentence. The secret is typed once, sent once and
 * never drawn again: the list shows the id and the day it was saved, which is all any route answers.
 */
export function DeploymentClientsSection() {
  const clients = useQuery(deploymentClientsQueryOptions());
  const [editing, setEditing] = React.useState<string | null>(null);
  const [toolkit, setToolkit] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{
    tone: "status" | "error";
    text: string;
  } | null>(null);

  const save = useMutation({
    ...saveDeploymentClientMutationOptions(queryClient),
    onSuccess: (saved) => {
      // The secret field is emptied on success: it is never shown again, here or anywhere.
      setClientSecret("");
      setEditing(null);
      setNotice({
        tone: "status",
        text: saved.replaced
          ? `已替换 ${saved.toolkit} 的客户端。已经启用的 ${saved.toolkit} 仍沿用旧的授权配置；要换上新的，请先移除这个应用再重新启用。`
          : `已保存 ${saved.toolkit} 的客户端。现在可以在应用目录里添加它了。`,
      });
    },
  });
  const remove = useMutation({
    ...removeDeploymentClientMutationOptions(queryClient),
    onMutate: () => setNotice(null),
    onError: (thrown: Error) =>
      setNotice({ tone: "error", text: thrown.message }),
    onSuccess: (removed, slug) =>
      setNotice({
        tone: "status",
        text:
          removed.note ??
          (removed.removed
            ? `已删除 ${slug} 的客户端。`
            : `${slug} 没有保存过客户端，没有删除任何东西。`),
      }),
  });

  const open = (slug: string | null) => {
    save.reset();
    setProblem(null);
    setNotice(null);
    setToolkit(slug ?? "");
    setClientId("");
    setClientSecret("");
    setEditing(slug ?? "");
  };

  const submit = () => {
    const input = { toolkit, clientId, clientSecret };
    const wrong = deploymentClientProblem(input);
    setProblem(wrong);
    if (wrong) return;
    // A fresh object, so the mutation's erasing of the secret touches nothing the form still holds.
    save.mutate({
      toolkit: toolkit.trim().toLowerCase(),
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
    });
  };

  const list = clients.data ?? [];

  return (
    <PageSection
      description="有些应用（比如 Shopify）要用这个部署自己在服务商那里注册的 OAuth 客户端，以服务器到服务器的方式连接。先在这里保存它，应用才会出现在目录里。这类连接是管理员账号的，员工通过它调用时以管理员身份。"
      title="部署专属客户端"
    >
      {notice ? (
        <p
          className={
            notice.tone === "error"
              ? "mt-4 text-destructive text-sm"
              : "mt-4 text-muted-foreground text-sm"
          }
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      ) : null}

      {clients.isPending ? null : clients.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {clients.error.message}
        </p>
      ) : (
        <>
          {list.length === 0 ? (
            <PageEmpty>还没有保存任何客户端。</PageEmpty>
          ) : (
            <PageRows>
              {list.map((entry, index) => (
                <React.Fragment key={entry.toolkit}>
                  <Item
                    data-testid={`deployment-client-${entry.toolkit}`}
                    size="sm"
                  >
                    <ItemContent>
                      <ItemTitle>{entry.toolkit}</ItemTitle>
                      <ItemDescription>
                        {[
                          entry.clientId
                            ? `客户端 ID：${entry.clientId}`
                            : "客户端 ID 未记录",
                          entry.storedAt
                            ? `保存于 ${formatDay(entry.storedAt)}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        onClick={() => open(entry.toolkit)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        替换
                      </Button>
                      <Button
                        disabled={
                          remove.isPending && remove.variables === entry.toolkit
                        }
                        onClick={() => remove.mutate(entry.toolkit)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {remove.isPending && remove.variables === entry.toolkit
                          ? "正在删除…"
                          : "删除"}
                      </Button>
                    </ItemActions>
                  </Item>
                  {index !== list.length - 1 && <Separator />}
                </React.Fragment>
              ))}
            </PageRows>
          )}
          <div className="mt-3">
            <Button
              onClick={() => open(null)}
              size="sm"
              type="button"
              variant="outline"
            >
              保存客户端
            </Button>
          </div>
        </>
      )}

      <Dialog
        onOpenChange={(next) => {
          if (!next) {
            setEditing(null);
            setClientSecret("");
          }
        }}
        open={editing !== null}
      >
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {editing ? `替换 ${editing} 的客户端` : "保存部署专属客户端"}
              </DialogTitle>
              <DialogDescription>
                来自服务商的开发者后台。密钥保存在这个部署的保险库里，保存后不会再显示。换客户端时，已启用的应用沿用旧授权配置，需先移除应用再重新启用。
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="mt-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="deployment-client-toolkit">
                    应用名
                  </FieldLabel>
                  <Input
                    autoComplete="off"
                    disabled={Boolean(editing)}
                    id="deployment-client-toolkit"
                    onChange={(event) => setToolkit(event.target.value)}
                    placeholder="shopify"
                    value={toolkit}
                  />
                  <FieldDescription>
                    应用在目录里的英文名，只能包含小写字母、数字、下划线和连字符。
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="deployment-client-id">
                    客户端 ID
                  </FieldLabel>
                  <Input
                    autoComplete="off"
                    id="deployment-client-id"
                    onChange={(event) => setClientId(event.target.value)}
                    value={clientId}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="deployment-client-secret">
                    客户端密钥
                  </FieldLabel>
                  <Input
                    autoComplete="new-password"
                    id="deployment-client-secret"
                    onChange={(event) => setClientSecret(event.target.value)}
                    type="password"
                    value={clientSecret}
                  />
                </Field>
              </FieldGroup>
              {problem || save.error ? (
                <p className="mt-3 text-destructive text-sm" role="alert">
                  {problem ?? save.error?.message}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter className="mt-4">
              <Button
                onClick={() => {
                  setEditing(null);
                  setClientSecret("");
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                取消
              </Button>
              <Button disabled={save.isPending} size="sm" type="submit">
                {save.isPending ? "正在保存…" : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}
