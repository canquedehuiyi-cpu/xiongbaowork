import { IconBrain, IconPlus, IconRobot, IconUser } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode, useId, useState } from "react";
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
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  createMemoryMutationOptions,
  deleteMemoryMutationOptions,
  type MemoryRecord,
  memoriesQueryOptions,
  updateMemoryMutationOptions,
} from "@/lib/memory";
import { queryClient } from "@/query-client";

/**
 * 上游的「记住一条事实」对话框与记忆列表（`MemoryList`），中文化后保留以便同步上游。熊宝的能力 › 记忆与信息源
 * 用的是 `memory-screen.tsx`，那里有同样的「让它记住一条事实」表单和每条记忆的卡片。
 *
 * A fact the person tells their Bots directly. It reaches every one of them.
 *
 * The page's one primary verb, so it is a button for `PageShell`'s `action` that opens a dialog,
 * rather than a form standing above the list somebody came to read.
 */
export function RememberFact() {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const formId = useId();
  const remember = useMutation(createMemoryMutationOptions(queryClient));
  return (
    <>
      <Button
        onClick={() => {
          // Opening starts clean: no draft or failure left from an earlier attempt.
          setContent("");
          remember.reset();
          setOpen(true);
        }}
        size="sm"
        variant="ghost"
      >
        <IconPlus />
        记住一条事实
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>记住一条事实</DialogTitle>
            <DialogDescription>你所有的员工都会知道。</DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
                direct child of DialogContent and keeps scrolling. */}
            <form
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                remember.mutate(content, {
                  onSuccess: () => {
                    setContent("");
                    setOpen(false);
                  },
                });
              }}
            >
              <Field>
                <FieldLabel htmlFor={`${formId}-content`}>
                  你希望员工知道的事
                </FieldLabel>
                <Textarea
                  id={`${formId}-content`}
                  required
                  maxLength={6000}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="我偏好上午开会。"
                />
              </Field>
            </form>
            {remember.error ? (
              <p role="alert" className="text-destructive text-sm">
                {remember.error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setOpen(false)} size="sm" variant="outline">
              取消
            </Button>
            <Button
              disabled={remember.isPending || !content.trim()}
              form={formId}
              size="sm"
              type="submit"
            >
              记住
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Everything the person's Bots remember about them, with who formed each memory. `action` and
 * `description` belong to the section, since the page heading above it is the whole Plugins screen.
 */
export function MemoryList({
  action,
  description,
}: {
  action?: ReactNode;
  description?: ReactNode;
} = {}) {
  const memories = useQuery(memoriesQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const botName = (id: string | null) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? "一位员工";
  return (
    <PageSection action={action} description={description} title="你的记忆">
      {memories.isPending ? null : memories.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {memories.error.message}
        </p>
      ) : memories.data.length ? (
        <PageRows>
          {memories.data.map((memory, index) => (
            <Fragment key={memory.id}>
              {index > 0 ? <Separator /> : null}
              <MemoryRow
                botName={botName(memory.formedByAgentId)}
                memory={memory}
              />
            </Fragment>
          ))}
        </PageRows>
      ) : (
        <PageEmpty icon={IconBrain} title="还没有任何记忆">
          用「记住一条事实」加一条。
        </PageEmpty>
      )}
    </PageSection>
  );
}

/**
 * One memory: the fact itself, then where it came from. Whether Bots use it is a switch; editing
 * its words opens a dialog, and confirming or forgetting it are the buttons beneath.
 */
function MemoryRow({
  memory,
  botName,
}: {
  memory: MemoryRecord;
  botName: string;
}) {
  const [editing, setEditing] = useState(false);
  const save = useMutation(updateMemoryMutationOptions(queryClient));
  const forget = useMutation(deleteMemoryMutationOptions(queryClient));
  const update = (input: {
    content?: string;
    enabled?: boolean;
    reviewState?: "confirmed";
  }) => save.mutate({ id: memory.id, input });
  // Intelligence keeps only the words of a memory it holds for this person, so it can be edited or
  // forgotten here but not paused or reviewed.
  const heldByIntelligence = memory.formedBy === "intelligence";
  const status = heldByIntelligence
    ? "保存在后端"
    : !memory.enabled
      ? "已停用"
      : memory.formedBy === "bot"
        ? `由 ${botName} 记下${memory.reviewState === "unreviewed" ? " · 待复核" : ""}`
        : memory.reviewState === "unreviewed"
          ? "导入的 · 待复核"
          : "已复核";
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {memory.formedBy === "bot" ? <IconRobot /> : <IconUser />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="line-clamp-none whitespace-pre-wrap">
          {memory.content}
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          {memory.provenance} · {status}
        </ItemDescription>
        {memory.formedBy === "bot" && (
          <ItemDescription className="line-clamp-none">
            来自 {memory.sourceApp ?? "一段对话"}
            {memory.observedAt
              ? `，读取于 ${new Date(memory.observedAt).toLocaleString("zh-CN")}`
              : ""}
            {memory.sourceLink && (
              <>
                {" · "}
                <a href={memory.sourceLink} target="_blank" rel="noreferrer">
                  查看记录
                </a>
              </>
            )}
          </ItemDescription>
        )}
        {/* A set, so it wraps onto its own line rather than crowding the fact. */}
        <ItemFooter>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                save.reset();
                setEditing(true);
              }}
              size="sm"
              variant="outline"
            >
              编辑
            </Button>
            {memory.reviewState === "unreviewed" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => update({ reviewState: "confirmed" })}
              >
                确认
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={forget.isPending}
              onClick={() => forget.mutate(memory.id)}
            >
              忘掉
            </Button>
          </div>
        </ItemFooter>
        {!editing && (save.error || forget.error) && (
          <p role="alert" className="text-destructive text-sm">
            {save.error?.message || forget.error?.message}
          </p>
        )}
      </ItemContent>
      {heldByIntelligence ? null : (
        <ItemActions>
          {/* Binary and immediate: Bots stop or start using it when switched. */}
          <Switch
            aria-label={`使用这条记忆：${clip(memory.content)}`}
            checked={memory.enabled}
            disabled={save.isPending}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        </ItemActions>
      )}
      {editing ? (
        <EditMemoryDialog
          memory={memory}
          onClose={() => setEditing(false)}
          onSave={(content) =>
            save.mutate(
              { id: memory.id, input: { content } },
              { onSuccess: () => setEditing(false) },
            )
          }
          error={save.error?.message ?? null}
          saving={save.isPending}
        />
      ) : null}
    </Item>
  );
}

/** A memory's words, cut short enough to name the switch beside them. */
function clip(content: string) {
  const line = content.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** The memory's words in a dialog. Saving rewrites them; the server records it as edited. */
function EditMemoryDialog({
  memory,
  saving,
  error,
  onSave,
  onClose,
}: {
  memory: MemoryRecord;
  saving: boolean;
  error: string | null;
  onSave: (content: string) => void;
  onClose: () => void;
}) {
  const [content, setContent] = useState(memory.content);
  const id = useId();
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑记忆</DialogTitle>
          <DialogDescription>{memory.provenance}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <Field>
            <FieldLabel className="sr-only" htmlFor={id}>
              记忆
            </FieldLabel>
            <Textarea
              autoFocus
              id={id}
              maxLength={6000}
              onChange={(event) => setContent(event.target.value)}
              rows={5}
              value={content}
            />
          </Field>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="outline">
            取消
          </Button>
          <Button
            disabled={saving || !content.trim()}
            onClick={() => onSave(content)}
            size="sm"
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
