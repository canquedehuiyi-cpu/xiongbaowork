import {
  IconBrain,
  IconChartBar,
  IconChevronRight,
  IconCloud,
  IconCube,
  IconKey,
  IconSearch,
  IconShieldLock,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { HarnessMark } from "@/components/agents/harness-mark";
import { PageEmpty, PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Switch } from "@/components/ui/switch";
import { modelUsageQueryOptions } from "@/lib/enterprise/queries";
import { markFor } from "@/lib/marks";
import { effortLabel } from "@/lib/models/effort";
import {
  availableModelsQueryOptions,
  type ModelOption,
  type ModelSource,
} from "@/lib/models/queries";
import { ControlsSection } from "./controls-section";

/** Who serves the models, by the name an admin knows it by. */
const SOURCE_NAMES: Record<ModelSource, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
  gateway: "兼容 OpenAI 的接口",
  chatgpt: "ChatGPT 订阅",
  claude: "Claude 订阅",
};

/**
 * The mark that stands beside a source, from `shared/marks`. A Claude plan is Claude's own; a
 * ChatGPT plan is OpenAI's, whose mark ChatGPT itself uses. An endpoint is nobody's, so that row
 * gets a plain icon. Nothing is drawn to stand in for a missing mark.
 */
const SOURCE_VENDORS: Partial<Record<ModelSource, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  xai: "xai",
  chatgpt: "openai",
  claude: "claude",
};

/**
 * Admin, Providers: what serves the models built-in Bots run on. One today, read from the
 * deployment's configuration; a row each once a deployment can hold more than one.
 */
export function ProviderSection() {
  const available = useQuery(availableModelsQueryOptions());
  return (
    <ControlsSection
      description="内置员工和部署时选定的框架，都运行在这个提供方的模型上。"
      title="已连接"
    >
      {() => {
        if (available.isPending) return null;
        if (available.error)
          return (
            <p className="mt-4 text-destructive text-sm" role="alert">
              读不到模型提供方。请刷新页面。
            </p>
          );
        const { source } = available.data;
        const name = SOURCE_NAMES[source] ?? source;
        const vendor = SOURCE_VENDORS[source];
        return (
          <PageRows>
            <Item size="sm">
              {vendor && markFor(vendor) ? (
                <ItemMedia>
                  <HarnessMark id={vendor} name={name} />
                </ItemMedia>
              ) : (
                <ItemMedia variant="icon">
                  <IconCloud />
                </ItemMedia>
              )}
              <ItemContent>
                <ItemTitle>{name}</ItemTitle>
                <ItemDescription>
                  {available.data.listed
                    ? `默认 ${available.data.default} · 列出了 ${available.data.models.length} 个模型`
                    : `默认 ${available.data.default} · 读不到它的模型列表`}
                </ItemDescription>
              </ItemContent>
            </Item>
          </PageRows>
        );
      }}
    </ControlsSection>
  );
}

/**
 * Admin, Providers: what people pick from in a conversation. Everything the credential lists for
 * one person on their own machine; in a team, the models allowed below, and until there are any,
 * the default only. No switch: what is allowed says it.
 */
export function ModelChoiceSection() {
  const available = useQuery(availableModelsQueryOptions());
  return (
    <ControlsSection
      description={() => {
        const data = available.data;
        if (!data) return "大家在每段对话里可以挑选哪些模型。";
        return data.exposure === "all"
          ? `大家在每段对话里可以挑选提供方列出的任意模型及其思考强度。没人另选之前，员工都用 ${data.default}。`
          : `大家在每段对话里从你在下面允许的模型中挑选，并选择思考强度。你允许任何模型之前，所有对话都用 ${data.default}。`;
      }}
      title="对话中可选的模型"
    >
      {({ data }) => {
        const listing = available.data;
        if (!listing) return null;
        const allowed = data.settings.modelAllowlist.models.filter((name) =>
          listing.models.some(
            (model) => `${listing.provider}/${model.id}` === name,
          ),
        ).length;
        return (
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconBrain />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {listing.exposure === "all"
                    ? "所有列出的模型"
                    : allowed === 0
                      ? "还没有允许任何模型"
                      : `已允许 ${allowed} 个模型`}
                </ItemTitle>
                <ItemDescription>
                  {listing.exposure === "all"
                    ? `${listing.models.length} 个模型，随提供方的列表保持更新。`
                    : allowed === 0
                      ? "大家看不到模型选择器。在下面允许一些模型，就能提供给大家。"
                      : "大家会在输入框的模型选择器里看到它们和默认模型。"}
                </ItemDescription>
              </ItemContent>
            </Item>
          </PageRows>
        );
      }}
    </ControlsSection>
  );
}

/** What the allowed-models row says: the models themselves, the first few by name. */
export function allowedSummary(models: readonly string[]): string {
  if (models.length === 0) return "未列出任何模型";
  if (models.length <= 3) return models.join("、");
  return `${models.slice(0, 3).join("、")}等另外 ${models.length - 3} 个`;
}

/** Admin, Providers: the allowlist every Bot's model is checked against. */
export function ModelAllowlistSection() {
  const [open, setOpen] = useState(false);
  return (
    <ControlsSection
      description="大家在每段对话里可以挑选的模型。打开「只用允许的模型」后，用其他模型的员工会在运行前被拒绝，远程员工自己的模型也会被检查。"
      title="允许的模型"
    >
      {({ data, setSetting, saving }) => {
        const { modelAllowlist } = data.settings;
        return (
          <>
            <PageRows>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconShieldLock />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>只用允许的模型</ItemTitle>
                  <ItemDescription>
                    {modelAllowlist.enabled
                      ? "员工只能用下面列出的模型运行。"
                      : "已关闭。用其他模型运行（包括远程员工自己的模型）不会被拒绝。"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label="只用允许的模型"
                    checked={modelAllowlist.enabled}
                    disabled={saving}
                    onCheckedChange={(enabled) =>
                      setSetting("modelAllowlist", {
                        ...modelAllowlist,
                        enabled,
                      })
                    }
                  />
                </ItemActions>
              </Item>
              <Separator />
              <Item
                render={<button onClick={() => setOpen(true)} type="button" />}
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconKey />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>允许的模型</ItemTitle>
                  <ItemDescription>
                    {allowedSummary(modelAllowlist.models)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </PageRows>
            {/* A fresh draft on each open, from the latest saved allowlist. */}
            {open ? (
              <AllowedModelsDialog
                builtInModel={data.builtInModel}
                initial={modelAllowlist.models}
                onClose={() => setOpen(false)}
                onSave={(models) =>
                  setSetting("modelAllowlist", { ...modelAllowlist, models })
                }
                open
              />
            ) : null}
          </>
        );
      }}
    </ControlsSection>
  );
}

/** `provider/model`, the spelling the allowlist and the usage view share. */
const FULL_NAME = /^[^\s/]+\/\S+$/;

/**
 * Pick the allowed models from what the provider or gateway lists, newest first, with the
 * deployment's own model marked. A model the listing does not have (a remote Bot's own, say) is
 * added by its full name and listed with the rest.
 */
export function AllowedModelsDialog({
  open,
  initial,
  builtInModel,
  onSave,
  onClose,
}: {
  open: boolean;
  /** As stored: `provider/model`. */
  initial: readonly string[];
  /** The deployment's model, as `provider/model`. */
  builtInModel: string | null;
  onSave: (models: string[]) => void;
  onClose: () => void;
}) {
  const available = useQuery({
    ...availableModelsQueryOptions(),
    enabled: open,
  });
  const [selected, setSelected] = useState<string[]>([...initial]);
  const [search, setSearch] = useState("");
  const [other, setOther] = useState("");

  const listed: { name: string; label: string; model?: ModelOption }[] = (
    available.data?.models ?? []
  ).map((model) => ({
    name: `${available.data?.provider}/${model.id}`,
    label: model.label,
    model,
  }));
  const listedNames = new Set(listed.map((model) => model.name));
  // The default as the list says it today: the operator's model, or the middle of the line.
  const defaultName = available.data
    ? `${available.data.provider}/${available.data.default}`
    : builtInModel;
  // Saved models the listing no longer (or never) had, so they can still be seen and removed.
  const extra: { name: string; label: string; model?: ModelOption }[] = selected
    .filter((name) => !listedNames.has(name))
    .map((name) => ({ name, label: name }));
  const needle = search.trim().toLowerCase();
  const rows = [...extra, ...listed].filter(
    (model) =>
      !needle ||
      model.label.toLowerCase().includes(needle) ||
      model.name.toLowerCase().includes(needle),
  );
  const toggle = (name: string, on: boolean) =>
    setSelected((current) =>
      on
        ? [...current.filter((entry) => entry !== name), name]
        : current.filter((entry) => entry !== name),
    );
  const otherName = other.trim();
  const otherValid = FULL_NAME.test(otherName);

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>允许的模型</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 flex flex-col gap-3 overflow-y-auto">
          <Input
            aria-label="搜索模型"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索模型"
            value={search}
          />
          {available.isPending ? null : available.error ? (
            <p className="text-destructive text-sm" role="alert">
              {available.error.message}
            </p>
          ) : !available.data.listed ? (
            <p className="text-muted-foreground text-sm">
              读不到提供方的模型列表，所以只列出了已配置的那个。其他模型请按完整名称添加。
            </p>
          ) : null}
          {rows.length === 0 ? (
            <PageEmpty icon={IconSearch} title="没有匹配的模型" />
          ) : (
            <div className="flex flex-col gap-px">
              {rows.map((model) => (
                <Item key={model.name} size="sm" variant="muted">
                  {/* The same mark the composer's picker draws, or its plain model icon. */}
                  <ItemMedia>
                    {model.model?.vendor && markFor(model.model.vendor) ? (
                      <HarnessMark
                        className="size-4"
                        id={model.model.vendor}
                        name={model.label}
                      />
                    ) : (
                      <IconCube
                        aria-hidden
                        className="size-4 text-muted-foreground"
                      />
                    )}
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{model.label}</ItemTitle>
                    <ItemDescription className="text-xs">
                      <span className="font-mono">{model.name}</span>
                      {model.name === defaultName ? " · 默认" : ""}
                      {model.model?.efforts?.length
                        ? ` · 思考强度：${model.model.efforts.map(effortLabel).join("、")}`
                        : ""}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Checkbox
                      aria-label={`允许 ${model.label}`}
                      checked={selected.includes(model.name)}
                      onCheckedChange={(checked) =>
                        toggle(model.name, checked === true)
                      }
                    />
                  </ItemActions>
                </Item>
              ))}
            </div>
          )}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!otherValid) return;
              toggle(otherName, true);
              setOther("");
            }}
          >
            <Input
              aria-label="其他模型"
              className="font-mono text-xs"
              onChange={(event) => setOther(event.target.value)}
              placeholder="未列出的模型，格式为 提供方/模型"
              value={other}
            />
            <Button
              disabled={!otherValid}
              size="sm"
              type="submit"
              variant="outline"
            >
              添加
            </Button>
          </form>
          {defaultName && !selected.includes(defaultName) ? (
            <p className="text-muted-foreground text-xs">
              {defaultName}{" "}
              是默认模型，会一直提供。打开「只用允许的模型」后，除非你允许它，用它的内置员工会被拒绝。
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            取消
          </Button>
          <Button
            onClick={() => {
              onSave(selected);
              onClose();
            }}
            size="sm"
            type="button"
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Admin, Providers: which models Bots ran on in the last 30 days. Only a team has an allowlist, so
 * only a team is told that refused runs are counted.
 */
export function ModelUsageSection({ team }: { team: boolean }) {
  const usage = useQuery(modelUsageQueryOptions(30));
  return (
    <ControlsSection
      description={
        team
          ? "最近 30 天里每个模型的运行次数，包括被允许列表拒绝的运行。"
          : "最近 30 天里每个模型的运行次数。"
      }
      title="用量"
    >
      {() =>
        usage.isPending ? null : usage.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            读不到模型用量。请刷新页面。
          </p>
        ) : usage.data.summary.length === 0 ? (
          <PageEmpty icon={IconChartBar} title="最近没有运行">
            员工回复后，运行记录会出现在这里。
          </PageEmpty>
        ) : (
          <PageRows>
            {usage.data.summary.map((row, index) => (
              <div key={`${row.model}-${row.source}`}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconChartBar />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{row.model}</ItemTitle>
                    <ItemDescription>
                      {row.people} 人运行了 {row.runs} 次
                      {row.refused > 0
                        ? ` · ${row.refused} 次不在允许列表中`
                        : ""}{" "}
                      · {row.source}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <span className="text-muted-foreground text-sm">
                      {new Date(row.lastUsedAt).toLocaleDateString()}
                    </span>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        )
      }
    </ControlsSection>
  );
}
