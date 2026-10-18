import { IconBook, IconPencil, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useState } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { componentDisplayTitle } from "@/lib/components/display-title";
import { componentListQueryOptions } from "@/lib/components/queries";
import { memorySourcesQueryOptions } from "@/lib/memory";
import {
  connectModelMutationOptions,
  deleteModelMutationOptions,
  modelReferencesMutationOptions,
  setModelEnabledMutationOptions,
  testModelMutationOptions,
} from "@/lib/models/mutations";
import type { ConnectedModel } from "@/lib/models/queries";
import {
  modelChoiceName,
  modelLibraryQueryOptions,
  PROVIDER_NAMES,
} from "@/lib/models/queries";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * The one screen holding everything a coworker can be assembled from.
 *
 * QoderWake's "能力与资源" is a single list of what an employee is given. This deployment had the same
 * contents over four screens — skills on their own page, connectors and components behind the
 * administrator's area, knowledge sources on another — and no screen at all for models, which is the
 * thing this fork's employees differ by.
 *
 * Every zone is an aggregate of an endpoint that already exists. Nothing here is a second write path:
 * the model zone is the one thing a person fully owns, and the zones they do not are a list plus the
 * way to the screen that decides.
 */
export const Route = createFileRoute("/_authed/_app/resources")({
  component: ResourcesPage,
});

function ResourcesPage() {
  return (
    <PageShell
      description="你的员工能被赋予的东西：它们用来回答的模型、它们持有的技能与连接器、它们读取的来源，以及它们直接给出的界面。"
      title="能力与资源"
    >
      <ModelZone />
      <SkillZone />
      <ConnectorZone />
      <KnowledgeZone />
      <ComponentZone />
    </PageShell>
  );
}

/** The four states a list of anything has, said once rather than five times. */
function ZoneRows({
  children,
  empty,
  error,
  pending,
}: {
  children: ReactNode;
  empty: boolean;
  error: unknown;
  pending: boolean;
}) {
  if (pending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-14" />
        <Skeleton className="h-14 w-2/3" />
      </div>
    );
  }
  if (error) {
    return (
      <p className="text-destructive text-sm" role="status">
        这一块没能加载。
      </p>
    );
  }
  if (empty) return null;
  return <PageRows>{children}</PageRows>;
}

function ZoneEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Empty className="h-[140px] border border-dashed">
      <EmptyHeader>
        <EmptyTitle className="text-muted-foreground">{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * The tenant's own model library.
 *
 * A connection is saved before it can be tested: the key goes straight into the encrypted vault and
 * the probe runs against the stored row, so no half-typed credential is ever dialled and no key sits
 * in browser state waiting on a second click.
 */
function ModelZone() {
  const queryClient = useQueryClient();
  const library = useQuery(modelLibraryQueryOptions());
  const [connecting, setConnecting] = useState(false);
  const models = library.data?.models ?? [];

  return (
    <PageSection
      action={
        <Button
          onClick={() => setConnecting((open) => !open)}
          size="sm"
          variant={connecting ? "secondary" : "default"}
        >
          <IconPlus />
          接入
        </Button>
      }
      description="每位员工都在这些模型之一上回答，或者用这个部署启动时自带的模型——正因如此，开发者可以跑在一个模型上、它的审核员跑在另一个上。"
      title="模型"
    >
      {connecting ? <ConnectForm onDone={() => setConnecting(false)} /> : null}
      <ZoneRows
        empty={models.length === 0}
        error={library.error}
        pending={library.isPending}
      >
        {models.map((model) => (
          <ModelRow key={model.id} model={model} queryClient={queryClient} />
        ))}
      </ZoneRows>
      {!library.isPending && !library.error && models.length === 0 ? (
        <ZoneEmpty
          description="每位员工都在用这个部署自带的模型回答。接入一个模型，才能给某位员工配上它自己的模型。"
          title="还没有接入任何模型"
        />
      ) : null}
    </PageSection>
  );
}

function ConnectForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const library = useQuery(modelLibraryQueryOptions());
  const templates = library.data?.templates ?? [];
  const [provider, setProvider] = useState("");
  const [modelName, setModelName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const connect = useMutation(connectModelMutationOptions(queryClient));

  const template = templates.find((entry) => entry.id === provider);
  const ready = Boolean(provider && modelName.trim() && apiKey.trim());

  return (
    <form
      className="mb-4 flex flex-col gap-3 rounded-lg border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        connect.mutate(
          {
            provider,
            modelName: modelName.trim(),
            apiKey: apiKey.trim(),
            ...(template?.allowsBaseUrl && baseUrl.trim()
              ? { baseUrl: baseUrl.trim() }
              : {}),
          },
          { onSuccess: onDone },
        );
      }}
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="font-medium text-sm">接入一个模型</legend>
        <Select
          // The label map, so the closed trigger names the provider rather than its slug.
          items={Object.fromEntries(
            templates.map((entry) => [
              entry.id,
              PROVIDER_NAMES[entry.id] ?? entry.label,
            ]),
          )}
          onValueChange={(value) => setProvider(value ?? "")}
          value={provider}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="服务商" />
          </SelectTrigger>
          <SelectContent>
            {templates.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {PROVIDER_NAMES[entry.id] ?? entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          onChange={(event) => setModelName(event.target.value)}
          placeholder="模型名，例如 gpt-6"
          value={modelName}
        />
        {template?.allowsBaseUrl ? (
          <Input
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="接口地址，例如 https://llm.internal/v1"
            value={baseUrl}
          />
        ) : null}
        <Input
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="API 密钥"
          type="password"
          value={apiKey}
        />
        <p className="text-muted-foreground text-xs">
          密钥在写入时加密，之后不会再显示。
        </p>
        {connect.error ? (
          <p className="text-destructive text-sm" role="alert">
            {connect.error.message}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            disabled={connect.isPending || !ready}
            size="sm"
            type="submit"
          >
            {connect.isPending ? "正在接入…" : "接入"}
          </Button>
          <Button
            disabled={connect.isPending}
            onClick={onDone}
            size="sm"
            type="button"
            variant="outline"
          >
            取消
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function ModelRow({
  model,
  queryClient,
}: {
  model: ConnectedModel;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const toggle = useMutation(setModelEnabledMutationOptions(queryClient));
  const test = useMutation(testModelMutationOptions());
  const remove = useMutation(deleteModelMutationOptions(queryClient));
  const references = useMutation(modelReferencesMutationOptions());
  const [listed, setListed] = useState<string[] | null>(null);
  const failure = [
    test.error,
    remove.error,
    references.error,
    toggle.error,
  ].find((error): error is Error => error instanceof Error);
  const message = failure?.message ?? (failure ? "这件事没能完成。" : null);

  return (
    <Item variant="muted">
      <ItemContent>
        <ItemTitle>{modelChoiceName(model)}</ItemTitle>
        <ItemDescription>
          {model.enabled
            ? `有 ${model.coworkers} 位员工在它上面回答`
            : "已停用——绑定到它的员工都用这个部署自带的模型回答"}
          {test.data ? (
            <span className="block">
              {test.data.ok
                ? "连接测试通过。"
                : `连接测试失败：${test.data.error ?? "服务商拒绝了这次请求"}`}
            </span>
          ) : null}
          {listed?.length ? (
            <span className="block">{listed.join(", ")}</span>
          ) : null}
          {message ? (
            <span className="block text-destructive">{message}</span>
          ) : null}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          disabled={test.isPending}
          onClick={() => test.mutate(model.id)}
          size="sm"
          variant="outline"
        >
          {test.isPending ? "正在测试…" : "测试"}
        </Button>
        <Button
          disabled={toggle.isPending}
          onClick={() =>
            toggle.mutate({ id: model.id, enabled: !model.enabled })
          }
          size="sm"
          variant="outline"
        >
          {model.enabled ? "停用" : "启用"}
        </Button>
        {model.coworkers > 0 ? (
          /*
           * Blocked rather than merely warned. Deleting unbinds these coworkers and they start
           * answering on the deployment's model — a change nobody reads off a toast — so the person is
           * made to see which ones first, and go rebind them if that was not the intent.
           */
          <Button
            disabled={references.isPending}
            onClick={() =>
              references.mutate(model.id, {
                onSuccess: (body) =>
                  setListed(body.coworkers.map((c) => c.name)),
              })
            }
            size="sm"
            variant="outline"
          >
            {references.isPending ? "正在加载…" : "使用中——查看"}
          </Button>
        ) : (
          <Button
            disabled={remove.isPending}
            onClick={() => remove.mutate(model.id)}
            size="sm"
            variant="outline"
          >
            {remove.isPending ? "正在移除…" : "移除"}
          </Button>
        )}
      </ItemActions>
    </Item>
  );
}

function SkillZone() {
  const plugins = useQuery(pluginsPageQueryOptions());
  const skills = plugins.data?.skills ?? [];
  return (
    <PageSection
      action={
        <Button
          render={(props) => <Link search={{}} to="/skills" {...props} />}
          size="sm"
          variant="outline"
        >
          <IconPencil />
          撰写
        </Button>
      }
      description="员工在活儿需要时会照做的说明。你自己的写在这里；管理员写的按员工授予给他们。"
      title="技能"
    >
      <ZoneRows
        empty={skills.length === 0}
        error={plugins.error}
        pending={plugins.isPending}
      >
        {skills.map((skill) => (
          <Item key={skill.slug} variant="muted">
            <ItemContent>
              <ItemTitle>{skill.title}</ItemTitle>
              <ItemDescription>{skill.summary}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {skill.grantedTo.length > 0
                  ? `已授予 ${skill.grantedTo.length} 位员工`
                  : "尚未授予"}
              </span>
            </ItemActions>
          </Item>
        ))}
      </ZoneRows>
    </PageSection>
  );
}

function ConnectorZone() {
  const plugins = useQuery(pluginsPageQueryOptions());
  const servers = plugins.data?.servers ?? [];
  return (
    <PageSection
      description="员工干活时可以碰到的系统。授予是管理员的动作，所以这里只列出有什么、在哪里决定。"
      title="连接器"
    >
      <ZoneRows
        empty={servers.length === 0}
        error={plugins.error}
        pending={plugins.isPending}
      >
        {servers.map((server) => (
          <Item key={server.id} variant="muted">
            <ItemContent>
              <ItemTitle>{server.title}</ItemTitle>
              <ItemDescription>{server.summary}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {server.hasCredential ? "已接入" : "没有凭据"}
              </span>
            </ItemActions>
          </Item>
        ))}
      </ZoneRows>
      <p className="mt-3 text-muted-foreground text-sm">
        授予在
        <Link className="underline" to="/admin/plugins">
          管理员的插件页
        </Link>
        里管理。
      </p>
    </PageSection>
  );
}

function KnowledgeZone() {
  const sources = useQuery(memorySourcesQueryOptions());
  const rows = sources.data ?? [];
  return (
    <PageSection
      action={
        <Button
          render={(props) => <Link to="/memory" {...props} />}
          size="sm"
          variant="outline"
        >
          <IconBook />
          去管理
        </Button>
      }
      description="员工在对话之外读到的东西：同步过来让它主动去拿的来源，或别人告诉它并留下来的记忆。"
      title="知识来源"
    >
      <ZoneRows
        empty={rows.length === 0}
        error={sources.error}
        pending={sources.isPending}
      >
        {rows.map((source) => (
          <Item key={source.id} variant="muted">
            <ItemContent>
              <ItemTitle>{source.title}</ItemTitle>
              <ItemDescription>
                {source.enabled ? `同步状态 ${source.syncStatus}` : "已暂停"}
                {source.lastSyncAt ? ` · 上次 ${source.lastSyncAt}` : ""}
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ZoneRows>
    </PageSection>
  );
}

function ComponentZone() {
  const components = useQuery(componentListQueryOptions());
  const rows = components.data ?? [];
  return (
    <PageSection
      description="员工可以直接给出、而不是用文字描述的界面。发布与授予在管理员的组件页里做。"
      title="组件"
    >
      <ZoneRows
        empty={rows.length === 0}
        error={components.error}
        pending={components.isPending}
      >
        <ItemGroup>
          {rows.map((component) => (
            <Item key={component.name} variant="muted">
              <ItemContent>
                <ItemTitle>{componentDisplayTitle(component)}</ItemTitle>
                <ItemDescription>
                  {component.published ? "已发布" : "草稿——没有提供给任何员工"}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </ZoneRows>
    </PageSection>
  );
}
