import {
  IconChevronRight,
  IconDeviceDesktop,
  IconEye,
  IconId,
  IconNotes,
  IconPlugConnected,
  IconShieldCheck,
  IconStack2,
  IconTag,
  IconTextCaption,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import type { ZodType } from "zod";
import { OPENBOT_HARNESS_NAME } from "@openbot/shared/harnesses";
import { CallbackTokenPanel } from "@/components/agents/callback-token-panel";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentFormValues,
  agentFormSchema,
  profileUpdateInput,
} from "@/lib/agents/form";
import {
  ISOLATED_MAKING_PUBLIC,
  ISOLATED_PUBLIC_SHARES_LOGINS,
  ISOLATION_GONE,
  ISOLATION_NOT_ALLOWED,
  ISOLATION_UNAVAILABLE,
  ISOLATION_WITHDRAWN,
  isolatedExplained,
} from "@/lib/agents/isolation";
import { updateAgentMutationOptions } from "@/lib/agents/mutations";
import {
  type AgentProfile,
  agentCapabilitiesQueryOptions,
} from "@/lib/agents/queries";
import { shortName } from "@/lib/brand";
import { isComposing } from "@/lib/composing";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { myCapabilitiesQueryOptions } from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";

type TextField = "name" | "title" | "roleDescription" | "instructions";

const SAVE_FAILED = "没能保存，请再试一次。";

const TEXT_FIELDS: {
  field: TextField;
  label: string;
  icon: typeof IconId;
  multiline?: boolean;
}[] = [
  { field: "name", label: "名称", icon: IconId },
  { field: "title", label: "头衔", icon: IconTag },
  {
    field: "roleDescription",
    // Not "Role": beside "Title" it read as a second job title, when it is the standing
    // instruction the Bot carries into every channel. The create dialog says the same.
    // The starter Bot is the exception: this is what it does, for the person, and what it is
    // told is the row below.
    label: "它做什么",
    icon: IconTextCaption,
    multiline: true,
  },
  {
    // Only the starter Bot has this row. See `AgentProfile.instructions`.
    field: "instructions",
    label: "指令",
    icon: IconNotes,
    multiline: true,
  },
];

const TEXT_SCHEMAS: Record<TextField, ZodType<string>> = {
  name: agentFormSchema.shape.name,
  title: agentFormSchema.shape.title,
  roleDescription: agentFormSchema.shape.roleDescription,
  instructions: agentFormSchema.shape.instructions.unwrap(),
};

/** Who a Bot is and where it runs. Editable by whoever may manage it; read-only for everyone else. */
export function SetupSections({ agent }: { agent: AgentProfile }) {
  // One person and one shared computer: nobody to see a Bot, and no computer of its own to give it.
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const update = useMutation(updateAgentMutationOptions(queryClient));
  const [editing, setEditing] = useState<TextField | null>(null);
  const save = (patch: Partial<AgentFormValues>) =>
    update.mutateAsync({
      agentId: agent.id,
      input: profileUpdateInput(agent, patch),
    });
  const open = TEXT_FIELDS.find((entry) => entry.field === editing);
  const fields = TEXT_FIELDS.filter(
    ({ field }) =>
      field !== "instructions" || typeof agent.instructions === "string",
  );

  return (
    <>
      <PageSection title="身份">
        <PageRows>
          {fields.map(({ field, label, icon: Icon }, index) => (
            <Fragment key={field}>
              {index > 0 ? <Separator /> : null}
              <Item
                render={
                  agent.canManage ? (
                    <button onClick={() => setEditing(field)} type="button" />
                  ) : undefined
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <Icon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{label}</ItemTitle>
                  <ItemDescription>{agent[field]}</ItemDescription>
                </ItemContent>
                {agent.canManage ? (
                  <ItemActions>
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                ) : null}
              </Item>
            </Fragment>
          ))}
          {personal ? null : (
            <>
              <Separator />
              <VisibilityRow
                agent={agent}
                onSave={(visibility) => save({ visibility })}
              />
              <Separator />
              <IsolatedRow
                agent={agent}
                onSave={(isolated) => save({ isolated })}
              />
            </>
          )}
          {agent.systemOwned ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconShieldCheck />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>随{shortName()}自带</ItemTitle>
                  <ItemDescription>
                    随{shortName()}自带，不属于任何一个人。
                  </ItemDescription>
                </ItemContent>
              </Item>
            </>
          ) : null}
        </PageRows>
      </PageSection>
      <ConnectionSection agent={agent} />
      {open ? (
        <EditTextDialog
          label={open.label}
          multiline={open.multiline ?? false}
          onClose={() => setEditing(null)}
          onSave={(value) => save({ [open.field]: value })}
          schema={TEXT_SCHEMAS[open.field]}
          value={agent[open.field] ?? ""}
        />
      ) : null}
    </>
  );
}

/** Two named choices that write on pick: no draft worth holding, so no dialog. */
function VisibilityRow({
  agent,
  onSave,
}: {
  agent: AgentProfile;
  onSave: (visibility: AgentProfile["visibility"]) => Promise<unknown>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconEye />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>可见性</ItemTitle>
        <ItemDescription>
          {error ??
            (agent.visibility === "private"
              ? agent.isolationActive
                ? `只有你能看到它、和它开始对话。${ISOLATED_MAKING_PUBLIC}`
                : "只有你能看到它、和它开始对话。"
              : agent.isolationActive
                ? `${shortName()}上的所有人都能找到并使用它。${ISOLATED_PUBLIC_SHARES_LOGINS}`
                : `${shortName()}上的所有人都能找到并使用它。`)}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {agent.canManage ? (
          <Select
            disabled={saving}
            // The label map, so the closed trigger says 私有 rather than the raw value.
            items={{ private: "私有", public: "公开" }}
            onValueChange={async (next) => {
              if (next === agent.visibility) return;
              setError(null);
              setSaving(true);
              try {
                await onSave(next as AgentProfile["visibility"]);
              } catch (failure) {
                setError(
                  failure instanceof Error ? failure.message : SAVE_FAILED,
                );
              } finally {
                setSaving(false);
              }
            }}
            value={agent.visibility}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="private">私有</SelectItem>
              <SelectItem value="public">公开</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <span className="text-muted-foreground text-sm">
            {agent.visibility === "private" ? "私有" : "公开"}
          </span>
        )}
      </ItemActions>
    </Item>
  );
}

/**
 * Whether it has a computer of its own: a switch that writes when flipped, like Visibility's choice.
 *
 * The switch shows what the owner asked for. What is actually happening is the description, decided
 * by the server: a Bot whose owner lost "Isolated Bots" keeps its tick, runs on their shared computer,
 * and says so here, so that an administrator giving the switch back restores it without anybody
 * touching the Bot.
 *
 * Turning it off is never refused, so the switch stays live for an isolated Bot even where it could
 * not be turned back on. Turning it on is offered only where the deployment can make the computer
 * and the person holds the switch; anywhere else the row says which of the two is missing.
 */
function IsolatedRow({
  agent,
  onSave,
}: {
  agent: AgentProfile;
  onSave: (isolated: boolean) => Promise<unknown>;
}) {
  const { data: capabilities } = useQuery(agentCapabilitiesQueryOptions());
  const { data: mine } = useQuery(myCapabilitiesQueryOptions());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = capabilities?.isolationAvailable ?? false;
  const allowed = mine?.capabilities?.isolatedComputers !== false;
  const isPublic = agent.visibility === "public";
  // A Bot that comes with OpenBot belongs to nobody, and the switch is a person's.
  const editable =
    agent.canManage &&
    !agent.systemOwned &&
    (agent.isolated || (available && allowed));

  const summary = agent.systemOwned
    ? `随${shortName()}自带，所以在使用它的人自己的电脑上运行。`
    : agent.isolated
      ? agent.isolationActive
        ? isolatedExplained(isPublic)
        : agent.isolationOffReason === "admin"
          ? ISOLATION_WITHDRAWN
          : agent.isolationOffReason === "deployment"
            ? ISOLATION_GONE
            : sharedSummary(isPublic)
      : !available
        ? ISOLATION_UNAVAILABLE
        : !allowed && agent.canManage
          ? ISOLATION_NOT_ALLOWED
          : sharedSummary(isPublic);

  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconDeviceDesktop />
      </ItemMedia>
      <ItemContent>
        <ItemTitle id={`isolated-${agent.id}`}>独立运行</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {error ?? summary}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {agent.canManage && !agent.systemOwned ? (
          <Switch
            aria-labelledby={`isolated-${agent.id}`}
            checked={agent.isolated}
            disabled={saving || !editable}
            onCheckedChange={async (next) => {
              setError(null);
              setSaving(true);
              try {
                await onSave(next);
              } catch (failure) {
                setError(
                  failure instanceof Error ? failure.message : SAVE_FAILED,
                );
              } finally {
                setSaving(false);
              }
            }}
          />
        ) : (
          <span className="text-muted-foreground text-sm">
            {agent.isolated ? "开" : "关"}
          </span>
        )}
      </ItemActions>
    </Item>
  );
}

/** Where a Bot without a computer of its own runs: on the computer of whoever is using it. */
function sharedSummary(isPublic: boolean): string {
  return isPublic
    ? "在使用它的人自己的电脑上运行。"
    : "和你的其他员工一起在你的电脑上运行。";
}

/**
 * One text field in a dialog, validated against the same limits the server enforces. Enter saves a
 * single-line field — but not the Enter that confirms a composed character, which would save the
 * value before the person finished typing it.
 */
function EditTextDialog({
  label,
  value,
  multiline,
  schema,
  onSave,
  onClose,
}: {
  label: string;
  value: string;
  multiline: boolean;
  schema: ZodType<string>;
  onSave: (value: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const parsed = schema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "检查一下这一项再保存。");
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed.data);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : SAVE_FAILED);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 grid gap-2">
          {multiline ? (
            <Textarea
              aria-label={label}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              rows={5}
              value={draft}
            />
          ) : (
            <Input
              aria-label={label}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isComposing(event)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              value={draft}
            />
          )}
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            disabled={saving}
            onClick={onClose}
            size="sm"
            variant="outline"
          >
            取消
          </Button>
          <Button disabled={saving} onClick={() => void submit()} size="sm">
            {saving ? "正在保存…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Where it runs. A built-in Bot runs on the deployment's own Bot, whose process already holds the
 * deployment's tool credential, so there is nothing to show but that sentence.
 */
function ConnectionSection({ agent }: { agent: AgentProfile }) {
  const builtIn = !agent.endpoint || agent.builtIn;
  return (
    <PageSection title="运行方式">
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconStack2 />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>框架</ItemTitle>
            <ItemDescription data-testid="coworker-framework">
              {frameworkName(agent)}
            </ItemDescription>
          </ItemContent>
        </Item>
        <Separator />
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconPlugConnected />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{builtIn ? "内置" : "员工地址"}</ItemTitle>
            <ItemDescription
              className={
                builtIn ? undefined : "line-clamp-none break-all font-mono"
              }
            >
              {builtIn
                ? `在${shortName()}里运行，不需要连接。`
                : agent.endpoint}
            </ItemDescription>
          </ItemContent>
        </Item>
      </PageRows>
      {!builtIn && agent.canManage ? (
        <CallbackTokenPanel
          agentId={agent.id}
          hasToken={agent.hasCallbackToken}
          fromOpenBot={agent.keyFromOpenBot === true}
        />
      ) : null}
    </PageSection>
  );
}

/**
 * What runs it, by the name the server gives (`AgentProfile.framework`). OpenBot itself is said as
 * this product; an employee connected by address with no framework named says so rather than guessing.
 */
export function frameworkName(
  agent: Pick<AgentProfile, "framework" | "builtIn">,
): string {
  if (
    agent.framework === OPENBOT_HARNESS_NAME ||
    (!agent.framework && agent.builtIn)
  )
    return `${shortName()}内置`;
  return agent.framework ?? "未注明（按地址接入的外部员工）";
}
