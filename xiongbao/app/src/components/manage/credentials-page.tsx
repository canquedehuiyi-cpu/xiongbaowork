import { IconKey, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { revokeCredentialMutationOptions } from "@/lib/credentials/mutations";
import { credentialListQueryOptions } from "@/lib/credentials/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useManagePaths } from "@/lib/manage-paths";

export function CredentialsPage() {
  const paths = useManagePaths();
  // Called Keys in the personal edition, which links here from Connections too.
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const queryClient = useQueryClient();
  const credentials = useQuery(credentialListQueryOptions());
  const revokeCredential = useMutation(
    revokeCredentialMutationOptions(queryClient),
  );

  return (
    <PageShell
      action={
        // Its own screen, `credentials_.new.tsx`, which says why the form is not on this page.
        <Button
          render={(props) => <Link {...props} {...paths.newCredential()} />}
          size="sm"
          variant="ghost"
        >
          <IconPlus />
          添加凭据
        </Button>
      }
      description={
        personal
          ? "你的应用和模型用到的 API 密钥和令牌。保存后的密钥不能再查看。"
          : "管理这个部署的密钥和令牌。保存后的密钥不能再查看。"
      }
      title={paths.credentialsLabel}
    >
      <PageSection title="已保存的凭据">
        {credentials.isPending ? null : credentials.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            读不到凭据。请刷新页面。
          </p>
        ) : credentials.data?.length === 0 ? (
          <PageEmpty
            action={
              <Button
                render={(props) => (
                  <Link {...props} {...paths.newCredential()} />
                )}
                size="sm"
                variant="outline"
              >
                <IconPlus />
                添加凭据
              </Button>
            }
            icon={IconKey}
            title="还没有凭据"
          >
            模型和连接器用的密钥和令牌保存在这里。
          </PageEmpty>
        ) : (
          <PageRows>
            {credentials.data?.map((credential, index) => (
              <StaggerItem index={index} key={credential.id}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>{credential.provider}</ItemTitle>
                    <ItemDescription>
                      {credential.kind} · {credential.keyId} ·{" "}
                      {credential.revokedAt ? "已撤销" : "使用中"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      disabled={
                        Boolean(credential.revokedAt) ||
                        revokeCredential.isPending
                      }
                      onClick={() => revokeCredential.mutate(credential.id)}
                      size="sm"
                      variant="outline"
                    >
                      撤销
                    </Button>
                  </ItemActions>
                </Item>
                {index !== (credentials.data?.length ?? 0) - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
