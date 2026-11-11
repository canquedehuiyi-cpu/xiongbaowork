import { IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useState } from "react";
import { QueryError } from "@/components/layout/query-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
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
import { cn } from "@/lib/utils";
import { CARD_FACE, SectionHead, TabEmpty } from "./resource-kit";

/**
 * 能力与资源 › 模型库: the platform's experience models and the tenant's own library, moved out of the
 * single long page into their own tab (parity plan F4) with their behaviour unchanged.
 */
export function ModelsTab() {
  return (
    <>
      <PlatformModelZone />
      <ModelZone />
    </>
  );
}

/** One zone of the tab: the section head (title, its one verb on the right), a line, the rows. */
function Zone({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-[22px]">
      <SectionHead aside={action} className="mb-[4px]" title={title} />
      <p className="max-w-prose text-pretty text-[13px] text-muted-foreground leading-[1.6]">
        {description}
      </p>
      {children}
    </section>
  );
}

/** A model's row: the workbench card face, name over its line, the verbs on the right. */
const MODEL_ROW = cn(
  CARD_FACE,
  "px-[13px] py-[10px] dark:border-border [&_[data-slot=item-title]]:font-bold [&_[data-slot=item-title]]:text-[13px] [&_[data-slot=item-description]]:text-[12px]",
);

/**
 * The four states a list of anything has, said once rather than five times. A failed read is an
 * alert with a retry; a failed background refetch keeps the rows it already had under that alert.
 */
function ZoneRows({
  children,
  empty,
  failure,
  query,
}: {
  children: ReactNode;
  empty: boolean;
  /** The zone's own words when its read failed, so a screen of failures says which ones. */
  failure: string;
  query: {
    isPending: boolean;
    isFetching: boolean;
    error: unknown;
    data: unknown;
    refetch: () => unknown;
  };
}) {
  if (query.isPending) {
    return (
      <div className="mt-[12px] flex flex-col gap-[9px]">
        <Skeleton className="h-[60px] rounded-[13px]" />
        <Skeleton className="h-[60px] w-2/3 rounded-[13px]" />
      </div>
    );
  }
  return (
    <>
      {query.error ? (
        <div className="mt-[12px]">
          <QueryError
            error={query.error}
            label={failure}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </div>
      ) : null}
      {query.data === undefined || empty ? null : (
        <div className="mt-[12px] flex flex-col gap-[9px]">{children}</div>
      )}
    </>
  );
}

function ZoneEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return <TabEmpty description={description} title={title} />;
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
    <Zone
      action={
        <Button
          disabled={locked}
          onClick={() => setConnecting((open) => !open)}
          variant={connecting ? "outline" : "default"}
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
        failure="读不到模型库"
        query={library}
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
    </Zone>
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
    <Zone
      description="平台提供并托管密钥的共享模型，套餐内可直接给员工使用，不需要你自己的 key。"
      title="平台体验模型"
    >
      <ZoneRows
        empty={pool.length === 0}
        failure="读不到平台体验模型"
        query={library}
      >
        {pool.map((model) => (
          <Item className={MODEL_ROW} key={model.id} variant="outline">
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
    </Zone>
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
      className={cn(CARD_FACE, "mt-[12px] flex flex-col gap-3 p-[14px]")}
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
        <legend className="font-bold text-[14px]">接入一个模型</legend>
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
    <Item className={MODEL_ROW} variant="outline">
      <ItemContent className="min-w-0">
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
      <ItemActions className="flex-wrap justify-end">
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
