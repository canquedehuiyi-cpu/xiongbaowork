import { IconBook, IconPencil, IconPlus, IconRoute } from "@tabler/icons-react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
import { ProjectsSection } from "@/components/resources/projects-section";
import { Skeleton } from "@/components/ui/skeleton";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { componentDisplayTitle } from "@/lib/components/display-title";
import { componentListQueryOptions } from "@/lib/components/queries";
import {
  knowledgeNotebookQueryOptions,
  knowledgeNotebooksQueryOptions,
} from "@/lib/knowledge/queries";
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
  poolChoiceName,
} from "@/lib/models/queries";
import {
  appKeyOf,
  connectionsQueryOptions,
  installListingsQueryOptions,
  listedRefs,
  type PluginServer,
  type PluginSkill,
  type PluginsPage,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

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
      width="workbench"
      description="你的员工能被赋予的东西：它们用来回答的模型、它们持有的技能与连接器、它们读取的来源，以及它们直接给出的界面。"
      title="能力与资源"
    >
      <PlatformModelZone />
      <ModelZone />
      <WakerFlowEntry />
      <SkillZone />
      <ConnectorZone />
      <KnowledgeZone />
      <ProjectsSection />
      <ComponentZone />
    </PageShell>
  );
}

/**
 * The way into WakerFlow management (story WF1).
 *
 * Kept as one self-contained block on purpose: where this entry finally lives (here or in the
 * sidebar) is still open, and moving it should be a change to one file.
 */
function WakerFlowEntry() {
  return (
    <PageSection
      action={
        <Button
          render={(props) => <Link to="/wakerflows" {...props} />}
          size="sm"
          variant="outline"
        >
          <IconRoute />
          管理
        </Button>
      }
      description="用一句话描述想要的流程，生成由多位员工分步执行、可以修改保存的计划。"
      title="WakerFlow"
    />
  );
}

/** The four states a list of anything has, said once rather than five times. */
function ZoneRows({
  children,
  empty,
  error,
  failure = "这一块没能加载。",
  pending,
}: {
  children: ReactNode;
  empty: boolean;
  error: unknown;
  /** The zone's own sentence when its read failed, so a screen of failures says which ones. */
  failure?: string;
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
        {failure}
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
  /*
   * Connecting a model with one's own key is a Pro capability (K1). The server refuses the write on
   * Free whatever this screen shows; the screen's part is to say so before the key is typed, and to
   * point at the one place that changes it. Until the library answers, the button waits too.
   */
  const locked = library.data ? !library.data.customModels : true;

  return (
    <PageSection
      action={
        <Button
          disabled={locked}
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
      {library.data && locked ? (
        <ConnectForm locked onDone={() => {}} />
      ) : connecting ? (
        <ConnectForm onDone={() => setConnecting(false)} />
      ) : null}
      <ZoneRows
        empty={models.length === 0}
        error={library.error}
        failure="读不到模型库。"
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

/**
 * The platform's own experience models (stories H1, K1), read-only.
 *
 * They are keyed and run by the platform, so nothing here edits them: a person sees which ones their
 * plan offers, how many of their coworkers answer on each, and which ones cannot be picked right now
 * because the deployment holds no key for them. Binding one is done on the coworker, like any model.
 */
function PlatformModelZone() {
  const library = useQuery(modelLibraryQueryOptions());
  const pool = library.data?.pool ?? [];
  return (
    <PageSection
      description="平台提供并托管密钥的共享模型，套餐内可直接给员工使用，不需要你自己的 key。"
      title="平台体验模型"
    >
      <ZoneRows
        empty={pool.length === 0}
        error={library.error}
        pending={library.isPending}
      >
        {pool.map((model) => (
          <Item key={model.id} variant="muted">
            <ItemContent>
              <ItemTitle>{poolChoiceName(model)}</ItemTitle>
              <ItemDescription>
                {model.available
                  ? `有 ${model.coworkers} 位员工在它上面回答`
                  : `暂不可用——平台还没有为它配置密钥（有 ${model.coworkers} 位员工绑定了它）`}
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ZoneRows>
      {!library.isPending && !library.error && pool.length === 0 ? (
        <ZoneEmpty
          description="你的套餐目前没有可用的平台体验模型。"
          title="暂无平台体验模型"
        />
      ) : null}
    </PageSection>
  );
}

/**
 * The form a person connects a model of their own through.
 *
 * `locked` is the Free plan's view of it (K1): drawn whole, so it is plain what Pro unlocks, but
 * every field and the submit disabled, with the way to the plans page beside it.
 */
function ConnectForm({
  locked = false,
  onDone,
}: {
  locked?: boolean;
  onDone: () => void;
}) {
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
        if (locked || !ready) return;
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
      {locked ? (
        <p className="text-sm" role="note">
          免费版只能使用平台体验模型。
          <Link className="underline" to="/plans">
            升级 Pro 解锁自定义 key
          </Link>
        </p>
      ) : null}
      <fieldset className="flex flex-col gap-3" disabled={locked}>
        <legend className="font-medium text-sm">接入一个模型</legend>
        <Select
          disabled={locked}
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
          disabled={locked}
          onChange={(event) => setModelName(event.target.value)}
          placeholder="模型名，例如 gpt-6"
          value={modelName}
        />
        {template?.allowsBaseUrl ? (
          <Input
            disabled={locked}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="接口地址，例如 https://llm.internal/v1"
            value={baseUrl}
          />
        ) : null}
        <Input
          disabled={locked}
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
            disabled={locked || connect.isPending || !ready}
            size="sm"
            type="submit"
          >
            {connect.isPending ? "正在接入…" : "接入"}
          </Button>
          {locked ? null : (
            <Button
              disabled={connect.isPending}
              onClick={onDone}
              size="sm"
              type="button"
              variant="outline"
            >
              取消
            </Button>
          )}
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

/*
 * ── Stories E1/E4 (D08-7): skills, connectors and knowledge as the aggregate view. ──
 *
 * Self-contained blocks, each its own reads and its own failure: an error in one zone draws that
 * zone's sentence and leaves every other zone as it was. The skill and connector zones share the one
 * `/api/plugins` read, so that request failing is two zones' sentence; the reads beside it (who you
 * are, what is listed, what you connected, the knowledge bases) only take away the detail they add.
 */

/** A small tag beside a row's title. Not a control, so plain text a screen reader reads in line. */
function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-border px-2 py-0.5 font-normal text-muted-foreground text-xs">
      {children}
    </span>
  );
}

/** "已授予 N 位员工", or that nobody holds it yet. */
function grantedSentence(count: number): string {
  return count > 0 ? `已授予 ${count} 位员工` : "尚未授予任何员工";
}

/**
 * Story E1's skill zone: the person's own skills and the deployment's, as two lists.
 *
 * Only the signed-in person's own count as 我的. An administrator's `/api/plugins` also carries other
 * people's personal skills; those are governed on the administrator's skill screen and are neither
 * this person's nor the deployment's, so this view leaves them out. A deployment skill an
 * administrator listed (上架, spec E3) carries 可自助安装: an owner ticks it onto a Waker on the
 * assembly page without asking anyone. The listings are a separate read, so failing to read them
 * drops the tag and nothing else.
 */
function SkillZone() {
  const plugins = useQuery(pluginsPageQueryOptions());
  const me = useQuery(currentUserQueryOptions());
  const listings = useQuery(installListingsQueryOptions());
  const skills = plugins.data?.skills ?? [];
  const meId = me.data?.id;
  const mine = skills.filter(
    (skill) => skill.ownerUserId !== null && skill.ownerUserId === meId,
  );
  const deployment = skills.filter((skill) => skill.ownerUserId === null);
  const listed = listedRefs(listings.data, "skill");

  const row = (skill: PluginSkill, selfInstall: boolean) => (
    <Item key={skill.slug} variant="muted">
      <ItemContent>
        <ItemTitle>
          {skill.title}
          {selfInstall ? <Tag>可自助安装</Tag> : null}
        </ItemTitle>
        <ItemDescription>{skill.summary}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <span className="text-muted-foreground text-sm">
          {grantedSentence(skill.grantedTo.length)}
        </span>
      </ItemActions>
    </Item>
  );

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
      description="员工在活儿需要时会照做的说明。你自己写的在“我的”里；管理员写的在“部署”里，按员工授予给他们，标着可自助安装的由你在员工装配页里自己装上。"
      title="技能"
    >
      <ZoneRows
        empty={false}
        error={plugins.error}
        failure="读不到技能。"
        pending={plugins.isPending || me.isPending}
      >
        <SkillGroup
          empty={me.error ? "读不到你自己的技能。" : "你还没有写过技能。"}
          rows={mine.map((skill) => row(skill, false))}
          title="我的"
        />
        <SkillGroup
          empty="这个部署还没有管理员写的技能。"
          rows={deployment.map((skill) => row(skill, listed.has(skill.slug)))}
          title="部署"
        />
      </ZoneRows>
    </PageSection>
  );
}

function SkillGroup({
  empty,
  rows,
  title,
}: {
  empty: string;
  rows: ReactNode[];
  title: string;
}) {
  return (
    <div className="flex flex-col gap-2 p-2">
      <h3 className="font-medium text-sm">{title}</h3>
      {rows.length > 0 ? (
        <ItemGroup>{rows}</ItemGroup>
      ) : (
        <p className="text-muted-foreground text-sm">{empty}</p>
      )}
    </div>
  );
}

/**
 * Whether an app answers as whoever is asking, so a Waker reaches it only once this person connected
 * their own account: a catalogue `user-oauth` vendor, or a brokered app that needs an account. The
 * same rule the assembly page and the connected-accounts page decide by.
 */
function connectsPerPerson(server: PluginServer, page: PluginsPage): boolean {
  if (server.provenance === "composio") return server.authScheme !== "NO_AUTH";
  // The catalogue key, not the row id: a curated connector is the team's row `team:<key>`.
  const key = appKeyOf(server);
  return page.catalogue.some(
    (entry) => entry.key === key && entry.auth === "user-oauth",
  );
}

/**
 * Story E1's connector zone, with where each one stands.
 *
 * 已授予 N 位员工 counts Wakers, not grants: the union of every tool's `grantedTo`, so a Waker that
 * holds three of a connector's tools is one employee. For an app reached as the person asking, the row
 * also says whether THIS person connected their account — a granted tool on an unconnected account
 * reaches nothing. That comes from `/api/plugins/connections`; when it cannot be read the row says so
 * rather than guessing 未连接.
 */
function ConnectorZone() {
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const servers = plugins.data?.servers ?? [];
  const connected = new Set(
    (connections.data?.connections ?? []).map((row) => row.serverId),
  );

  const accountState = (server: PluginServer): string => {
    if (!plugins.data || !connectsPerPerson(server, plugins.data))
      return server.hasCredential ? "已接入" : "没有凭据";
    if (connections.isPending) return "正在读取你的连接…";
    if (connections.error) return "读不到你的连接";
    return connected.has(server.id) ? "你已连接" : "未连接";
  };

  return (
    <PageSection
      description="员工干活时可以碰到的系统。授予是管理员的动作，所以这里列出有什么、授予了几位员工、你自己的账号连上没有，以及在哪里决定。"
      title="连接器"
    >
      <ZoneRows
        empty={servers.length === 0}
        error={plugins.error}
        failure="读不到连接器。"
        pending={plugins.isPending}
      >
        {servers.map((server) => (
          <Item key={server.id} variant="muted">
            <ItemContent>
              <ItemTitle>{server.title}</ItemTitle>
              <ItemDescription>
                {server.summary}
                <span className="block">
                  {grantedSentence(
                    new Set(server.tools.flatMap((tool) => tool.grantedTo))
                      .size,
                  )}
                </span>
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {accountState(server)}
              </span>
            </ItemActions>
          </Item>
        ))}
      </ZoneRows>
      {!plugins.isPending && !plugins.error && servers.length === 0 ? (
        <ZoneEmpty
          description="管理员在插件页里添加连接器之后，它们会出现在这里。"
          title="还没有连接器"
        />
      ) : null}
      <p className="mt-3 text-muted-foreground text-sm">
        授予在
        <Link className="underline" to="/admin/plugins">
          管理员的插件页
        </Link>
        里管理；你自己的账号在
        <Link className="underline" to="/settings/connected-accounts">
          已连接的账号
        </Link>
        里连接。
      </p>
    </PageSection>
  );
}

/**
 * Story E1's knowledge zone: the person's knowledge bases (D08 RES1) first, then the memory sources.
 *
 * 已授权 N 位员工 is the number of distinct Wakers bound to a base, read from each base's detail —
 * the list endpoint carries no bindings. One base's detail failing says so on that row; the list
 * failing is the bases' sentence, and the memory sources below are a read of their own.
 */
function KnowledgeZone() {
  const notebooks = useQuery(knowledgeNotebooksQueryOptions());
  const bases = notebooks.data ?? [];
  const details = useQueries({
    queries: bases.map((notebook) =>
      knowledgeNotebookQueryOptions(notebook.id),
    ),
  });
  const sources = useQuery(memorySourcesQueryOptions());
  const rows = sources.data ?? [];

  const boundSentence = (index: number): string => {
    const detail = details[index];
    if (!detail || detail.isPending) return "正在读取授权…";
    if (detail.error || !detail.data) return "读不到授权";
    const count = new Set(
      detail.data.bindings.map((binding) => binding.agentId),
    ).size;
    return count > 0 ? `已授权 ${count} 位员工` : "尚未授权任何员工";
  };

  return (
    <PageSection
      action={
        <Button
          render={(props) => <Link to="/knowledge" {...props} />}
          size="sm"
          variant="outline"
        >
          <IconBook />
          知识库
        </Button>
      }
      description="员工在对话之外读到的东西：你整理好、授权给员工去读的知识库；同步过来让它主动去拿的来源；别人告诉它并留下来的记忆。"
      title="知识来源"
    >
      <h3 className="mt-4 mb-2 font-medium text-sm">知识库</h3>
      <ZoneRows
        empty={bases.length === 0}
        error={notebooks.error}
        failure="读不到知识库。"
        pending={notebooks.isPending}
      >
        {bases.map((notebook, index) => (
          <Item key={notebook.id} variant="muted">
            <ItemContent>
              <ItemTitle>{notebook.title}</ItemTitle>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {boundSentence(index)}
              </span>
            </ItemActions>
          </Item>
        ))}
      </ZoneRows>
      {!notebooks.isPending && !notebooks.error && bases.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          还没有知识库。在知识库页里建一个，再授权给员工。
        </p>
      ) : null}
      <div className="mt-4 mb-2 flex items-center justify-between gap-4">
        <h3 className="font-medium text-sm">信息源与记忆</h3>
        <Link className="text-sm underline" to="/memory">
          去管理
        </Link>
      </div>
      <ZoneRows
        empty={rows.length === 0}
        error={sources.error}
        failure="读不到信息源。"
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
      {!sources.isPending && !sources.error && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">还没有接入信息源。</p>
      ) : null}
    </PageSection>
  );
}
/* ── end E1/E4 (D08-7) ── */

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
        failure="读不到组件。"
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
