import { OPENBOT_HARNESS_NAME } from "@openbot/shared/harnesses";
import {
  IconChevronRight,
  IconDeviceDesktop,
  IconNotes,
  IconStack2,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentFormValues,
  agentFormSchema,
  profileUpdateInput,
} from "@/lib/agents/form";
import {
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
import { myCapabilitiesQueryOptions } from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";

const SAVE_FAILED = "没能保存，请再试一次。";

/**
 * 运行方式: what runs this employee, whether it has a computer of its own, and — for the starter
 * only — what it is told, apart from what it does. Upstream's Setup page rows (Isolated,
 * Instructions) and the framework the profile names, as one section of the employee's detail page;
 * the name, title and role stay on the assembly page, which edits them with everything else.
 *
 * Each row writes the whole profile back through `profileUpdateInput`, so a flip of one switch never
 * touches the model binding, the persona or the avatar.
 */
export function BotRuntimeSection({ agent }: { agent: AgentProfile }) {
  const update = useMutation(updateAgentMutationOptions(queryClient));
  const [editing, setEditing] = useState(false);
  const save = (patch: Partial<AgentFormValues>) =>
    update.mutateAsync({
      agentId: agent.id,
      input: profileUpdateInput(agent, patch),
    });
  // Only the starter keeps its instructions apart from its role (`AgentProfile.instructions`).
  const hasInstructions = typeof agent.instructions === "string";

  return (
    <PageSection
      description="它由什么运行、在哪台电脑上干活。"
      title="运行方式"
    >
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
        <IsolatedRow agent={agent} onSave={(isolated) => save({ isolated })} />
        {hasInstructions ? (
          <>
            <Separator />
            <Item
              render={
                agent.canManage ? (
                  <button onClick={() => setEditing(true)} type="button" />
                ) : undefined
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconNotes />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>指令</ItemTitle>
                <ItemDescription>{agent.instructions}</ItemDescription>
              </ItemContent>
              {agent.canManage ? (
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              ) : null}
            </Item>
          </>
        ) : null}
      </PageRows>
      {editing ? (
        <InstructionsDialog
          onClose={() => setEditing(false)}
          onSave={(instructions) => save({ instructions })}
          value={agent.instructions ?? ""}
        />
      ) : null}
    </PageSection>
  );
}

/**
 * What runs it, by the name the server gives (`AgentProfile.framework`). OpenBot itself is said as
 * this product; a coworker connected by address with no framework named says so rather than guessing.
 */
export function frameworkName(
  agent: Pick<AgentProfile, "framework" | "builtIn">,
): string {
  if (
    agent.framework === OPENBOT_HARNESS_NAME ||
    (!agent.framework && agent.builtIn)
  )
    return "熊宝内置";
  return agent.framework ?? "未注明（按地址接入的外部员工）";
}

/** Where a coworker without a computer of its own runs: on the computer of whoever is using it. */
function sharedSummary(isPublic: boolean): string {
  return isPublic
    ? "在使用它的人自己的电脑上运行。"
    : "和你的其他员工一起在你的电脑上运行。";
}

/**
 * Whether it has a computer of its own: a switch that writes when flipped.
 *
 * The switch shows what the owner asked for; what is actually happening is the description, decided
 * by the server: a coworker whose owner lost the switch keeps its tick, runs on the shared computer
 * and says so here, so that an administrator giving the switch back restores it.
 *
 * Turning it off is never refused, so the switch stays live for an isolated coworker even where it
 * could not be turned back on. Turning it on is offered only where the deployment can make the
 * computer and the person holds the switch; anywhere else the row says which of the two is missing.
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
  const allowed = mine?.capabilities.isolatedComputers !== false;
  const isPublic = agent.visibility === "public";
  // A coworker that comes with the deployment belongs to nobody, and the switch is a person's.
  const switchable = agent.canManage && !agent.systemOwned;
  const editable = switchable && (agent.isolated || (available && allowed));

  const summary = agent.systemOwned
    ? "随熊宝自带，所以在使用它的人自己的电脑上运行。"
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
          {error ? (
            <span className="text-destructive" role="alert">
              {error}
            </span>
          ) : (
            summary
          )}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {switchable ? (
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

/** The starter's instructions in a dialog, checked against the same limits the server enforces. */
function InstructionsDialog({
  value,
  onSave,
  onClose,
}: {
  value: string;
  onSave: (value: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const parsed = agentFormSchema.shape.instructions.unwrap().safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "检查一下指令再保存。");
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
          <DialogTitle>指令</DialogTitle>
          <DialogDescription>
            它每次干活时被告知的话，和角色描述分开保存。
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 grid gap-2">
          <Textarea
            aria-label="指令"
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            rows={6}
            value={draft}
          />
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
