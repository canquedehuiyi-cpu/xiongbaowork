import { IconBook, IconPlus, IconTrash } from "@tabler/icons-react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import {
  ResourceCard,
  textMatch,
} from "@/components/resources/capability-tabs";
import {
  CardGrid,
  NoMatch,
  QueryState,
  TabEmpty,
  TabHeader,
  TabSearch,
} from "@/components/resources/resource-kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  addSourceMutationOptions,
  createNotebookMutationOptions,
  deleteNotebookMutationOptions,
  isKnowledgeConflict,
  KNOWLEDGE_CONFLICT_MESSAGE,
  KNOWLEDGE_SOURCE_MAX_CHARS,
  type KnowledgeNotebookDetail,
  type KnowledgeSource,
  type KnowledgeSourceKind,
  type KnowledgeSourceSummary,
  knowledgeChars,
  knowledgeNotebookQueryOptions,
  knowledgeNotebooksQueryOptions,
  knowledgeSourceQueryOptions,
  removeSourceMutationOptions,
  renameNotebookMutationOptions,
  setKnowledgeBindingMutationOptions,
  updateSourceMutationOptions,
} from "@/lib/knowledge/queries";

const KIND_LABELS: Record<string, string> = {
  markdown: "Markdown",
  text: "纯文本",
};

/**
 * 能力与资源 › 知识库 (D08 RES1): a person's own knowledge bases, the text kept in them, and which of
 * their own employees may read which one.
 *
 * It used to be two screens — the standalone `/knowledge` page, and a summary tab here that counted
 * each base's grants and linked out to it. The page was archived into this tab (`/knowledge` now
 * redirects here), so the tab holds both: create, the list with each base's grant count, and the
 * open base's name, 资料 and 授权.
 *
 * 已授权 N 位员工 is the number of distinct employees bound to a base, read from each base's detail —
 * the list endpoint carries no bindings. One base's detail failing says so on that card; the list
 * failing is the tab's alert, with a retry.
 *
 * Every edit carries the revision it was drawn from. When the server answers 409 somebody else
 * (another tab, another device) wrote first: the screen says so, re-reads, and redraws the editors
 * from the fresh copy — it never retries the stale write over the newer one.
 */
export function KnowledgeScreen({
  query,
  onQuery,
}: {
  query: string;
  onQuery: (value: string) => void;
}) {
  const notebooks = useQuery(knowledgeNotebooksQueryOptions());
  const [selected, setSelected] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const rows = notebooks.data ?? [];
  const details = useQueries({
    queries: rows.map((notebook) => knowledgeNotebookQueryOptions(notebook.id)),
  });
  const visible = rows
    .map((notebook, index) => ({ notebook, index }))
    .filter(({ notebook }) => textMatch(query, notebook.title));
  // The chosen notebook while it still exists, otherwise the first one: a deleted notebook must not
  // leave the screen pointing at nothing.
  const current =
    rows.find((notebook) => notebook.id === selected)?.id ?? rows[0]?.id;

  const feedback = {
    conflict,
    onConflict: () => setConflict(true),
    clearConflict: () => setConflict(false),
  };

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
    <>
      <TabHeader
        description="把资料放进你自己的知识库，再决定哪些员工可以读。授权只读，随时可以收回。"
        search={
          <TabSearch label="搜索知识库" onChange={onQuery} value={query} />
        }
      />
      <CreateNotebookForm
        onCreated={(id) => {
          setConflict(false);
          setSelected(id);
        }}
      />

      {conflict ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {KNOWLEDGE_CONFLICT_MESSAGE}
        </p>
      ) : null}

      <PageSection className="mt-8" title="我的知识库">
        <QueryState
          label="读不到知识库"
          query={notebooks}
          skeleton={<Skeleton className="mt-3 h-14" />}
        >
          {rows.length === 0 ? (
            <TabEmpty
              description="先在上面起个名字，新建一个知识库，再授权给员工。"
              title="还没有知识库"
            />
          ) : visible.length === 0 ? (
            <NoMatch onClear={() => onQuery("")} title="没有匹配的知识库" />
          ) : (
            <CardGrid className="mt-3" label="知识库列表">
              {visible.map(({ notebook, index }) => {
                const open = notebook.id === current;
                return (
                  <ResourceCard
                    actions={
                      <Button
                        aria-label={open ? undefined : `打开 ${notebook.title}`}
                        aria-pressed={open}
                        onClick={() => {
                          setConflict(false);
                          setSelected(notebook.id);
                        }}
                        size="sm"
                        variant={open ? "secondary" : "ghost"}
                      >
                        {open ? "正在查看" : "打开"}
                      </Button>
                    }
                    key={notebook.id}
                    media={
                      <span className="flex size-[32px] items-center justify-center rounded-md bg-muted">
                        <IconBook className="size-4" />
                      </span>
                    }
                    meta={boundSentence(index)}
                    title={notebook.title}
                  />
                );
              })}
            </CardGrid>
          )}
        </QueryState>
      </PageSection>

      {current ? (
        <NotebookPanel feedback={feedback} notebookId={current} />
      ) : null}
    </>
  );
}

type Feedback = {
  conflict: boolean;
  onConflict: () => void;
  clearConflict: () => void;
};

function CreateNotebookForm({
  onCreated,
}: {
  onCreated: (notebookId: string) => void;
}) {
  const queryClient = useQueryClient();
  const create = useMutation(createNotebookMutationOptions(queryClient));
  const [title, setTitle] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) return;
    create.mutate(
      { title: name },
      {
        onSuccess: (notebook) => {
          setTitle("");
          if (notebook?.id) onCreated(notebook.id);
        },
      },
    );
  };

  return (
    <form className="mt-5 flex flex-col gap-2" onSubmit={submit}>
      <label className="font-medium text-sm" htmlFor="knowledge-new-title">
        新知识库名称
      </label>
      <div className="flex gap-2">
        <Input
          id="knowledge-new-title"
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="例如：产品手册"
          value={title}
        />
        <Button disabled={!title.trim() || create.isPending} type="submit">
          <IconPlus />
          新建知识库
        </Button>
      </div>
      {create.error ? (
        <p className="text-destructive text-sm" role="alert">
          {create.error.message}
        </p>
      ) : null}
    </form>
  );
}

function NotebookPanel({
  feedback,
  notebookId,
}: {
  feedback: Feedback;
  notebookId: string;
}) {
  const detail = useQuery(knowledgeNotebookQueryOptions(notebookId));

  if (detail.isPending) return <Skeleton className="mt-12 h-40" />;
  if (detail.error || !detail.data) {
    return (
      <p className="mt-12 text-destructive text-sm" role="alert">
        {detail.error?.message ?? "读不到这个知识库。"}
      </p>
    );
  }
  const { notebook } = detail.data;

  return (
    <>
      <PageSection title={notebook.title}>
        {/* Keyed by revision: after a refresh the form starts again from what the server holds. */}
        <NotebookSettings
          detail={detail.data}
          feedback={feedback}
          key={`${notebook.id}:${notebook.revision}`}
        />
      </PageSection>
      <SourcesSection detail={detail.data} feedback={feedback} />
      <AuthorizeFieldset detail={detail.data} />
    </>
  );
}

function NotebookSettings({
  detail,
  feedback,
}: {
  detail: KnowledgeNotebookDetail;
  feedback: Feedback;
}) {
  const queryClient = useQueryClient();
  // Conflicts are reported from the mutation's own options rather than from `mutate`'s callbacks:
  // the refetch a write settles with redraws this form under a new key, and callbacks given to
  // `mutate` are dropped once the component that called it is gone.
  const onError = (error: Error) => {
    if (isKnowledgeConflict(error)) feedback.onConflict();
  };
  const rename = useMutation({
    ...renameNotebookMutationOptions(queryClient),
    onError,
  });
  const remove = useMutation({
    ...deleteNotebookMutationOptions(queryClient),
    onError,
  });
  const { notebook } = detail;
  const [title, setTitle] = useState(notebook.title);
  const [confirming, setConfirming] = useState(false);
  const inputId = `knowledge-title-${notebook.id}`;

  const save = (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name || name === notebook.title) return;
    feedback.clearConflict();
    rename.mutate({
      notebookId: notebook.id,
      title: name,
      revision: notebook.revision,
    });
  };

  const error = [rename.error, remove.error].find(
    (candidate) => candidate && !isKnowledgeConflict(candidate),
  );

  return (
    <div className="mt-3 flex flex-col gap-3">
      <form className="flex flex-col gap-2" onSubmit={save}>
        <label className="font-medium text-sm" htmlFor={inputId}>
          名称
        </label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            value={title}
          />
          <Button
            disabled={
              !title.trim() ||
              title.trim() === notebook.title ||
              rename.isPending
            }
            type="submit"
            variant="outline"
          >
            保存名称
          </Button>
        </div>
      </form>
      <div className="flex items-center gap-2">
        {confirming ? (
          <>
            <span className="text-muted-foreground text-sm">
              删除后资料和授权都会一起移除。
            </span>
            <Button
              disabled={remove.isPending}
              onClick={() => {
                feedback.clearConflict();
                setConfirming(false);
                remove.mutate({
                  notebookId: notebook.id,
                  revision: notebook.revision,
                });
              }}
              size="sm"
              variant="destructive"
            >
              确认删除
            </Button>
            <Button
              onClick={() => setConfirming(false)}
              size="sm"
              variant="ghost"
            >
              取消
            </Button>
          </>
        ) : (
          <Button onClick={() => setConfirming(true)} size="sm" variant="ghost">
            <IconTrash />
            删除知识库
          </Button>
        )}
      </div>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
    </div>
  );
}

function SourcesSection({
  detail,
  feedback,
}: {
  detail: KnowledgeNotebookDetail;
  feedback: Feedback;
}) {
  const queryClient = useQueryClient();
  // A stale delete is the same conflict a stale edit is: said once at the top, with the refetch the
  // write settles with already showing the newer copy.
  const remove = useMutation({
    ...removeSourceMutationOptions(queryClient),
    onError: (error: Error) => {
      if (isKnowledgeConflict(error)) feedback.onConflict();
    },
  });
  const [editing, setEditing] = useState<string | null>(null);
  const { notebook, sources } = detail;
  const editingSource = sources.find((source) => source.id === editing);

  return (
    <PageSection
      description="纯文本或 Markdown，每份最多 64K 字符。"
      title="资料"
    >
      {sources.length === 0 ? (
        <p className="mt-3 text-muted-foreground text-sm">
          这个知识库还没有资料。
        </p>
      ) : (
        <ItemGroup className="mt-3">
          {sources.map((source) => (
            <Item key={source.id} variant="muted">
              <ItemContent>
                <ItemTitle>{source.title}</ItemTitle>
                <ItemDescription>
                  {KIND_LABELS[source.kind] ?? source.kind} ·{" "}
                  {source.chars.toLocaleString("en-US")} 字符
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  aria-label={`编辑 ${source.title}`}
                  onClick={() => {
                    feedback.clearConflict();
                    setEditing(source.id);
                  }}
                  size="sm"
                  variant="outline"
                >
                  编辑
                </Button>
                <Button
                  aria-label={`删除 ${source.title}`}
                  disabled={
                    remove.isPending && remove.variables?.sourceId === source.id
                  }
                  onClick={() => {
                    feedback.clearConflict();
                    if (editing === source.id) setEditing(null);
                    remove.mutate({
                      notebookId: notebook.id,
                      sourceId: source.id,
                      // What this row shows, so a newer copy saved elsewhere is refused (409), not erased.
                      revision: source.revision,
                    });
                  }}
                  size="sm"
                  variant="ghost"
                >
                  删除
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
      {remove.error && !isKnowledgeConflict(remove.error) ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {remove.error.message}
        </p>
      ) : null}

      {editingSource ? (
        <SourceEditor
          feedback={feedback}
          // A refreshed revision redraws the editor from the server's copy.
          key={`${editingSource.id}:${editingSource.revision}`}
          onClose={() => setEditing(null)}
          source={editingSource}
        />
      ) : null}

      <AddSourceForm feedback={feedback} notebookId={notebook.id} />
    </PageSection>
  );
}

function CharCounter({ value, id }: { value: string; id: string }) {
  const count = knowledgeChars(value);
  const over = count > KNOWLEDGE_SOURCE_MAX_CHARS;
  return (
    <p
      aria-live="polite"
      className={
        over ? "text-destructive text-xs" : "text-muted-foreground text-xs"
      }
      data-over={over ? "true" : "false"}
      id={id}
    >
      {count.toLocaleString("en-US")} /{" "}
      {KNOWLEDGE_SOURCE_MAX_CHARS.toLocaleString("en-US")} 字符
      {over ? "，超过 64K 上限，请删减后再保存。" : ""}
    </p>
  );
}

function withinLimit(value: string) {
  return (
    value.trim() !== "" && knowledgeChars(value) <= KNOWLEDGE_SOURCE_MAX_CHARS
  );
}

function AddSourceForm({
  feedback,
  notebookId,
}: {
  feedback: Feedback;
  notebookId: string;
}) {
  const queryClient = useQueryClient();
  const add = useMutation(addSourceMutationOptions(queryClient));
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<KnowledgeSourceKind>("markdown");
  const [content, setContent] = useState("");
  const prefix = `knowledge-new-source-${notebookId}`;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !withinLimit(content)) return;
    feedback.clearConflict();
    add.mutate(
      { notebookId, title: title.trim(), kind, content },
      {
        onSuccess: () => {
          setTitle("");
          setContent("");
        },
      },
    );
  };

  return (
    <form
      aria-label="添加资料"
      className="mt-6 flex flex-col gap-2 rounded-lg border border-dashed p-3"
      onSubmit={submit}
    >
      <p className="font-medium text-sm">添加资料</p>
      <label className="text-sm" htmlFor={`${prefix}-title`}>
        资料名称
      </label>
      <Input
        id={`${prefix}-title`}
        maxLength={120}
        onChange={(event) => setTitle(event.target.value)}
        value={title}
      />
      <label className="text-sm" htmlFor={`${prefix}-kind`}>
        格式
      </label>
      <select
        className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm"
        id={`${prefix}-kind`}
        onChange={(event) =>
          setKind(event.target.value === "text" ? "text" : "markdown")
        }
        value={kind}
      >
        <option value="markdown">Markdown</option>
        <option value="text">纯文本</option>
      </select>
      <label className="text-sm" htmlFor={`${prefix}-content`}>
        内容
      </label>
      <Textarea
        aria-describedby={`${prefix}-count`}
        className="min-h-32 font-mono"
        id={`${prefix}-content`}
        onChange={(event) => setContent(event.target.value)}
        value={content}
      />
      <CharCounter id={`${prefix}-count`} value={content} />
      <div>
        <Button
          disabled={!title.trim() || !withinLimit(content) || add.isPending}
          type="submit"
        >
          添加资料
        </Button>
      </div>
      {add.error && !isKnowledgeConflict(add.error) ? (
        <p className="text-destructive text-sm" role="alert">
          {add.error.message}
        </p>
      ) : null}
    </form>
  );
}

function SourceEditor({
  feedback,
  onClose,
  source,
}: {
  feedback: Feedback;
  onClose: () => void;
  source: KnowledgeSourceSummary;
}) {
  const full = useQuery(
    knowledgeSourceQueryOptions(source.notebookId, source.id),
  );

  if (full.isPending) return <Skeleton className="mt-4 h-32" />;
  if (full.error || !full.data) {
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        {full.error?.message ?? "读不到这份资料。"}
      </p>
    );
  }
  return (
    <SourceEditorForm
      feedback={feedback}
      // The summary and the full read can briefly disagree after a refresh: the form is drawn from,
      // and saves against, the revision of the full copy it shows.
      key={full.data.revision}
      onClose={onClose}
      source={full.data}
    />
  );
}

function SourceEditorForm({
  feedback,
  onClose,
  source,
}: {
  feedback: Feedback;
  onClose: () => void;
  source: KnowledgeSource;
}) {
  const queryClient = useQueryClient();
  // Callbacks on the options, not on `mutate`: the refetch this write settles with redraws the
  // editor under a new key, and `mutate`'s own callbacks die with the component that called it.
  const update = useMutation({
    ...updateSourceMutationOptions(queryClient),
    onSuccess: onClose,
    onError: (error: Error) => {
      if (isKnowledgeConflict(error)) feedback.onConflict();
    },
  });
  const [title, setTitle] = useState(source.title);
  const [content, setContent] = useState(source.content);
  const prefix = `knowledge-source-${source.id}`;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !withinLimit(content)) return;
    feedback.clearConflict();
    update.mutate({
      notebookId: source.notebookId,
      sourceId: source.id,
      title: title.trim(),
      content,
      revision: source.revision,
    });
  };

  return (
    <form
      aria-label={`编辑资料 ${source.title}`}
      className="mt-4 flex flex-col gap-2 rounded-lg border p-3"
      onSubmit={submit}
    >
      <label className="text-sm" htmlFor={`${prefix}-title`}>
        资料名称
      </label>
      <Input
        id={`${prefix}-title`}
        maxLength={120}
        onChange={(event) => setTitle(event.target.value)}
        value={title}
      />
      <label className="text-sm" htmlFor={`${prefix}-content`}>
        内容（{KIND_LABELS[source.kind] ?? source.kind}）
      </label>
      <Textarea
        aria-describedby={`${prefix}-count`}
        className="min-h-32 font-mono"
        id={`${prefix}-content`}
        onChange={(event) => setContent(event.target.value)}
        value={content}
      />
      <CharCounter id={`${prefix}-count`} value={content} />
      <div className="flex gap-2">
        <Button
          disabled={!title.trim() || !withinLimit(content) || update.isPending}
          type="submit"
        >
          保存资料
        </Button>
        <Button onClick={onClose} type="button" variant="ghost">
          取消
        </Button>
      </div>
      {update.error && !isKnowledgeConflict(update.error) ? (
        <p className="text-destructive text-sm" role="alert">
          {update.error.message}
        </p>
      ) : null}
    </form>
  );
}

/**
 * 授权给: the person's own employees (Wakers), one box each.
 *
 * Only Wakers the person created are offered — the server refuses a binding to anybody else's with
 * a 403, and a box that can only bounce is worse than not drawing it.
 *
 * Hidden ones too: `/api/agents` leaves out the Wakers this person has hidden, which only come back
 * with `?hidden=true`, and a binding one of them holds still lets it read the notebook. Reading the
 * default list alone dropped that box, so the grant could neither be seen nor taken back here.
 */
function AuthorizeFieldset({ detail }: { detail: KnowledgeNotebookDetail }) {
  const queryClient = useQueryClient();
  const shown = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  const agents = {
    isPending: shown.isPending || hidden.isPending,
    error: shown.error ?? hidden.error,
  };
  const setBinding = useMutation(
    setKnowledgeBindingMutationOptions(queryClient),
  );
  const { notebook, bindings } = detail;
  const hiddenIds = new Set((hidden.data ?? []).map((agent) => agent.id));
  const owned = [
    ...(shown.data ?? []),
    ...(hidden.data ?? []).filter(
      (agent) => !(shown.data ?? []).some((other) => other.id === agent.id),
    ),
  ].filter((agent) => agent.mine);
  const bound = new Set(bindings.map((binding) => binding.agentId));

  return (
    <PageSection
      description="勾选的员工可以只读这个知识库；取消勾选立即收回。"
      title="授权"
    >
      <fieldset className="mt-3 flex flex-col gap-2 rounded-lg border p-3">
        <legend className="px-1 font-medium text-sm">授权给</legend>
        {agents.isPending ? (
          <Skeleton className="h-8" />
        ) : agents.error ? (
          <p className="text-destructive text-sm" role="alert">
            读不到你的员工列表。
          </p>
        ) : owned.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            你还没有自己的员工，招聘一位后再来授权。
          </p>
        ) : (
          owned.map((agent) => {
            const id = `knowledge-bind-${notebook.id}-${agent.id}`;
            return (
              // The label sits beside the box rather than around it: wrapped, its text would include
              // the box's own aria-label and name it twice ("小熊审稿 小熊审稿").
              <div className="flex items-center gap-2 text-sm" key={agent.id}>
                <Checkbox
                  aria-label={agent.name}
                  checked={bound.has(agent.id)}
                  disabled={
                    setBinding.isPending &&
                    setBinding.variables?.agentId === agent.id
                  }
                  id={id}
                  onCheckedChange={(checked) =>
                    setBinding.mutate({
                      notebookId: notebook.id,
                      agentId: agent.id,
                      granted: checked === true,
                    })
                  }
                />
                <label htmlFor={id}>{agent.name}</label>
                {hiddenIds.has(agent.id) ? (
                  <span className="text-muted-foreground text-xs">已隐藏</span>
                ) : null}
              </div>
            );
          })
        )}
      </fieldset>
      {setBinding.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {setBinding.error.message}
        </p>
      ) : null}
    </PageSection>
  );
}
