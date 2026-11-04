import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { newId } from "@/lib/new-id";
import {
  type AgentRoleFields,
  type AnyRoleTemplate,
  applyRoleTemplateMutationOptions,
  generateRoleProfile,
  type RoleTemplate,
  roleModelsQueryOptions,
  roleSourceQueryOptions,
  roleTemplatesQueryOptions,
} from "@/lib/roles/queries";
import type { Persona } from "../../../../shared/persona";
import {
  characterCount,
  ROLE_LIMITS,
  type RoleProfile,
  roleProfileFromMarkdown,
  roleProfileToMarkdown,
} from "../../../../shared/role-profile";

/**
 * The role editor (story ROLE1): 身份, 人设 and 手册 as three tabs, with Markdown import and export
 * and smart generation. It edits a value it is handed and saves nothing itself — whatever arrives
 * from a pasted file or from a model only fills the boxes, and the person decides whether to save.
 */

const TABS = [
  { id: "identity", label: "身份" },
  { id: "persona", label: "人设" },
  { id: "bible", label: "手册" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const PERSONA_PARTS: { key: keyof Persona; label: string }[] = [
  { key: "tone", label: "性格语气" },
  { key: "principles", label: "工作守则" },
  { key: "habits", label: "口头约束" },
];

/** Which tab a Markdown or validation error points at; null for a heading that is none of them. */
function tabOf(section: string): TabId | null {
  if (["身份", "头衔", "职责", "文件开头"].includes(section)) return "identity";
  if (["人设", "性格语气", "工作守则", "口头约束"].includes(section))
    return "persona";
  return section === "手册" ? "bible" : null;
}

export function RoleEditor({
  value,
  onChange,
  readOnly = false,
  fileName = "角色",
}: {
  value: RoleProfile;
  onChange: (next: RoleProfile) => void;
  readOnly?: boolean;
  /** The exported file's name, without `.md`. */
  fileName?: string;
}) {
  const [tab, setTab] = useState<TabId>("identity");
  const [markdown, setMarkdown] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  const setIdentity = (key: keyof RoleProfile["identity"], text: string) =>
    onChange({ ...value, identity: { ...value.identity, [key]: text } });
  const setPersona = (key: keyof Persona, text: string) =>
    onChange({ ...value, persona: { ...value.persona, [key]: text } });

  const importText = (text: string) => {
    const result = roleProfileFromMarkdown(text);
    if (!result.ok) {
      setImportNotice(null);
      setImportError(
        `「${result.section}」${result.line ? `（第 ${result.line} 行）` : ""}：${result.message}`,
      );
      const at = tabOf(result.section);
      if (at) setTab(at);
      return;
    }
    setImportError(null);
    onChange(result.profile);
    setImportNotice("已填入身份、人设和手册，确认后再保存。");
  };

  const exportMarkdown = () => {
    const blob = new Blob([roleProfileToMarkdown(value)], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileName}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const bibleLength = characterCount(value.bible);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1" role="tablist">
        {TABS.map((item) => (
          <Button
            aria-selected={tab === item.id}
            key={item.id}
            onClick={() => setTab(item.id)}
            role="tab"
            size="sm"
            type="button"
            variant={tab === item.id ? "secondary" : "ghost"}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {tab === "identity" ? (
        <div className="flex flex-col gap-3" role="tabpanel">
          <label className="flex flex-col gap-1 text-sm" htmlFor="role-title">
            <span className="font-medium">头衔</span>
            <Input
              id="role-title"
              maxLength={ROLE_LIMITS.title}
              onChange={(event) => setIdentity("title", event.target.value)}
              readOnly={readOnly}
              value={value.identity.title}
            />
          </label>
          <label
            className="flex flex-col gap-1 text-sm"
            htmlFor="role-description"
          >
            <span className="font-medium">职责</span>
            <Textarea
              id="role-description"
              maxLength={ROLE_LIMITS.roleDescription}
              onChange={(event) =>
                setIdentity("roleDescription", event.target.value)
              }
              readOnly={readOnly}
              rows={3}
              value={value.identity.roleDescription}
            />
          </label>
        </div>
      ) : tab === "persona" ? (
        <div className="flex flex-col gap-3" role="tabpanel">
          {PERSONA_PARTS.map((part) => (
            <label
              className="flex flex-col gap-1 text-sm"
              htmlFor={`role-${part.key}`}
              key={part.key}
            >
              <span className="font-medium">{part.label}</span>
              <Textarea
                id={`role-${part.key}`}
                maxLength={ROLE_LIMITS.personaPart}
                onChange={(event) => setPersona(part.key, event.target.value)}
                readOnly={readOnly}
                rows={3}
                value={value.persona[part.key]}
              />
            </label>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-1" role="tabpanel">
          <label className="flex flex-col gap-1 text-sm" htmlFor="role-bible">
            <span className="font-medium">工作手册</span>
            <span className="text-muted-foreground text-xs">
              背景知识、工作流程或术语表，支持 Markdown，最多{" "}
              {ROLE_LIMITS.bible} 字，每一轮都会完整带上。
            </span>
            <Textarea
              id="role-bible"
              aria-label="工作手册"
              onChange={(event) =>
                onChange({ ...value, bible: event.target.value })
              }
              readOnly={readOnly}
              rows={10}
              value={value.bible}
            />
          </label>
          <span
            className={
              bibleLength > ROLE_LIMITS.bible
                ? "text-destructive text-xs"
                : "text-muted-foreground text-xs"
            }
          >
            {bibleLength} / {ROLE_LIMITS.bible}
            {bibleLength > ROLE_LIMITS.bible ? "，超出上限，不能保存" : ""}
          </span>
        </div>
      )}

      <details className="rounded-md border border-border p-3 text-sm">
        <summary className="cursor-pointer font-medium">
          Markdown 导入与导出
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          {readOnly ? null : (
            <>
              <Textarea
                aria-label="粘贴 Markdown"
                onChange={(event) => setMarkdown(event.target.value)}
                placeholder={
                  "# 身份\n头衔：…\n## 职责\n…\n# 人设\n## 性格语气\n…\n# 手册\n…"
                }
                rows={5}
                value={markdown}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={!markdown.trim()}
                  onClick={() => importText(markdown)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  导入粘贴的内容
                </Button>
                <label className="text-xs">
                  <span className="sr-only">选择 .md 文件</span>
                  <input
                    accept=".md,text/markdown,text/plain"
                    aria-label="选择 .md 文件"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      // Read here, in the browser; the file is never uploaded.
                      if (file) importText(await file.text());
                      event.target.value = "";
                    }}
                    type="file"
                  />
                </label>
              </div>
            </>
          )}
          <Button
            onClick={exportMarkdown}
            size="sm"
            type="button"
            variant="outline"
          >
            导出为 .md
          </Button>
          {importError ? (
            <p className="text-destructive text-sm" role="alert">
              {importError}
            </p>
          ) : null}
          {importNotice ? (
            <p className="text-muted-foreground text-sm">{importNotice}</p>
          ) : null}
        </div>
      </details>
    </div>
  );
}

/**
 * Smart generation (§3.5): a sentence and a model from the person's own library. The answer fills
 * the editor through `onGenerated`; nothing is saved.
 */
export function RoleGeneratePanel({
  onGenerated,
}: {
  onGenerated: (profile: RoleProfile) => void;
}) {
  const models = useQuery(roleModelsQueryOptions());
  const [description, setDescription] = useState("");
  const [modelRef, setModelRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const choices = models.data ?? [];
  const chosen = modelRef || choices[0]?.id || "";

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
      <span className="font-medium">智能生成</span>
      <Input
        aria-label="一句话描述这个角色"
        maxLength={500}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="例如：一位谨慎、先写测试再改代码的后端工程师"
        value={description}
      />
      {choices.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          模型库里还没有可用的模型，先在「能力与资源」里连接一个。
        </p>
      ) : (
        <select
          aria-label="生成用的模型"
          className="h-8 rounded-md border border-input bg-transparent px-2"
          onChange={(event) => setModelRef(event.target.value)}
          value={chosen}
        >
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      )}
      <div>
        <Button
          disabled={busy || !description.trim() || !chosen}
          onClick={async () => {
            setBusy(true);
            setMessage(null);
            try {
              const result = await generateRoleProfile({
                requestId: newId(),
                modelRef: chosen,
                description: description.trim(),
              });
              if (result.state === "completed" && result.profile) {
                onGenerated(result.profile);
                setMessage("已填入编辑器，确认后再保存。");
              } else {
                setMessage(result.error ?? "生成没有完成，请重试。");
              }
            } catch (failure) {
              setMessage(
                failure instanceof Error ? failure.message : "智能生成失败。",
              );
            } finally {
              setBusy(false);
            }
          }}
          size="sm"
          type="button"
        >
          {busy ? "正在生成…" : "生成"}
        </Button>
      </div>
      {message ? (
        <p className="text-muted-foreground text-sm" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

/** What applying a template would change, field by field (§3.3). */
export function RoleDiff({
  current,
  next,
}: {
  current: RoleProfile;
  next: RoleProfile;
}) {
  const rows: { label: string; before: string; after: string }[] = [
    {
      label: "头衔",
      before: current.identity.title,
      after: next.identity.title || current.identity.title,
    },
    {
      label: "职责",
      before: current.identity.roleDescription,
      after: next.identity.roleDescription || current.identity.roleDescription,
    },
    ...PERSONA_PARTS.map((part) => ({
      label: part.label,
      before: current.persona[part.key],
      after: next.persona[part.key],
    })),
    { label: "手册", before: current.bible, after: next.bible },
  ].filter((row) => row.before !== row.after);
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-sm">内容没有变化。</p>;
  }
  return (
    <ul aria-label="改动" className="flex flex-col gap-2 text-sm">
      {rows.map((row) => (
        <li className="rounded-md border border-border p-2" key={row.label}>
          <span className="font-medium">{row.label}</span>
          <p className="text-muted-foreground line-through">
            {row.before || "（空）"}
          </p>
          <p>{row.after || "（空）"}</p>
        </li>
      ))}
    </ul>
  );
}

/** A select of the person's templates and the official ones, for 从模板开始. */
export function TemplatePicker({
  onPick,
}: {
  onPick: (template: AnyRoleTemplate | null) => void;
}) {
  const templates = useQuery(roleTemplatesQueryOptions());
  const all: AnyRoleTemplate[] = [
    ...(templates.data?.templates ?? []),
    ...(templates.data?.official ?? []),
  ];
  if (all.length === 0) return null;
  return (
    <label className="flex flex-col gap-1 text-sm" htmlFor="role-template-pick">
      <span className="font-medium">从模板开始</span>
      <select
        className="h-8 rounded-md border border-input bg-transparent px-2"
        defaultValue=""
        id="role-template-pick"
        onChange={(event) =>
          onPick(
            all.find((template) => template.id === event.target.value) ?? null,
          )
        }
      >
        <option value="">不使用模板</option>
        {all.map((template) => (
          <option key={template.id} value={template.id}>
            {template.official ? `${template.name}（官方）` : template.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A coworker's current role as a profile, for the diff and the "changed" check. */
export function roleProfileOf(profile: {
  title: string;
  roleDescription: string;
  persona: Persona | null;
  bible?: string | null;
}): RoleProfile {
  return {
    identity: {
      title: profile.title,
      roleDescription: profile.roleDescription,
    },
    persona: profile.persona ?? { tone: "", principles: "", habits: "" },
    bible: profile.bible ?? "",
  };
}

/**
 * The 角色 part of a coworker's dialog (§3.3): its 工作手册, where its role came from, and taking a
 * template — shown its diff first. The server says whether one may be taken: only the 分身 is
 * offered none (D4, revised 2026-11-04), and its Bible is still written here by hand.
 */
export function AgentRolePanel({
  agentId,
  profile,
  onSaveBible,
}: {
  agentId: string;
  profile: {
    title: string;
    roleDescription: string;
    persona: Persona | null;
    canManage: boolean;
  } & AgentRoleFields;
  onSaveBible: (bible: string | null) => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const source = useQuery(roleSourceQueryOptions(agentId));
  const templates = useQuery(roleTemplatesQueryOptions());
  const apply = useMutation(applyRoleTemplateMutationOptions(queryClient));
  const [bible, setBible] = useState(profile.bible ?? "");
  const [pending, setPending] = useState<RoleTemplate | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readOnly = !profile.canManage;
  const accepts =
    (source.data?.acceptsRoleTemplate ?? profile.acceptsRoleTemplate) === true;
  const current = roleProfileOf(profile);
  const tooLong = characterCount(bible.trim()) > ROLE_LIMITS.bible;
  const own = templates.data?.templates ?? [];
  const from = source.data?.source ?? null;
  const sourceTemplate = from ? own.find((t) => t.id === from.id) : undefined;

  const confirmApply = async () => {
    if (!pending) return;
    setError(null);
    try {
      await apply.mutateAsync({
        templateId: pending.id,
        agentId,
        version: pending.version,
      });
      setBible(pending.profile.bible);
      setPending(null);
      setMessage(`已按模板「${pending.name}」v${pending.version} 更新。`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "套用模板失败。");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {from ? (
        <div className="flex flex-col gap-1 rounded-md bg-muted p-3 text-sm">
          <span>
            来自模板「{from.name ?? "已删除的模板"}」v{from.version}
            {from.modified ? "，已在模板基础上修改" : ""}
          </span>
          {from.hasUpdate ? (
            <span>
              模板「{from.name}」有新版本（v{from.latestVersion}，当前 v
              {from.version}）
            </span>
          ) : null}
          {from.hasUpdate && accepts && !readOnly && sourceTemplate ? (
            <div>
              <Button
                onClick={() => setPending(sourceTemplate)}
                size="sm"
                type="button"
                variant="outline"
              >
                按模板更新
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <label className="flex flex-col gap-1 text-sm" htmlFor="agent-bible">
        <span className="font-medium">工作手册</span>
        <span className="text-muted-foreground text-xs">
          背景知识、工作流程或术语表，最多 {ROLE_LIMITS.bible}{" "}
          字，放在人设之后整段带上。
        </span>
        <Textarea
          id="agent-bible"
          aria-label="工作手册"
          onChange={(event) => setBible(event.target.value)}
          readOnly={readOnly}
          rows={6}
          value={bible}
        />
      </label>
      {tooLong ? (
        <p className="text-destructive text-xs" role="alert">
          手册超过 {ROLE_LIMITS.bible} 字，不能保存。
        </p>
      ) : null}
      {readOnly ? null : (
        <div>
          <Button
            disabled={tooLong || bible === (profile.bible ?? "")}
            onClick={async () => {
              setError(null);
              try {
                await onSaveBible(bible.trim() ? bible : null);
                setMessage("手册已保存，员工下一轮开始生效。");
              } catch (failure) {
                setError(
                  failure instanceof Error ? failure.message : "保存失败。",
                );
              }
            }}
            size="sm"
            type="button"
          >
            保存手册
          </Button>
        </div>
      )}

      {accepts && !readOnly && own.length > 0 ? (
        <label
          className="flex flex-col gap-1 text-sm"
          htmlFor="agent-apply-template"
        >
          <span className="font-medium">套用模板</span>
          <select
            className="h-8 rounded-md border border-input bg-transparent px-2"
            id="agent-apply-template"
            onChange={(event) =>
              setPending(own.find((t) => t.id === event.target.value) ?? null)
            }
            value={pending?.id ?? ""}
          >
            <option value="">选择一个模板</option>
            {own.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}（v{template.version}）
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {pending ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <span className="font-medium text-sm">
            套用「{pending.name}」v{pending.version} 会改动：
          </span>
          <RoleDiff current={current} next={pending.profile} />
          <div className="flex gap-2">
            <Button
              disabled={apply.isPending}
              onClick={confirmApply}
              size="sm"
              type="button"
            >
              确认更新
            </Button>
            <Button
              onClick={() => setPending(null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              取消
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="text-muted-foreground text-sm">{message}</p>
      ) : null}
    </div>
  );
}
