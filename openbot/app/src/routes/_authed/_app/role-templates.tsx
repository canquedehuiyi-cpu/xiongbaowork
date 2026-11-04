import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { RoleEditor, RoleGeneratePanel } from "@/components/roles/role-editor";
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
  type AnyRoleTemplate,
  deleteRoleTemplateMutationOptions,
  roleTemplatesQueryOptions,
  saveRoleTemplateMutationOptions,
} from "@/lib/roles/queries";
import {
  characterCount,
  emptyRoleProfile,
  ROLE_LIMITS,
  type RoleProfile,
  validateRoleProfile,
} from "../../../../../shared/role-profile";

export const Route = createFileRoute("/_authed/_app/role-templates")({
  component: RoleTemplatesScreen,
});

/** What the editor is working on: a new template, one of the person's own, or an official one. */
type Draft = {
  id?: string;
  version?: number;
  official: boolean;
  name: string;
  profile: RoleProfile;
  /** The saved state, so the screen can tell an unsaved change. */
  savedName: string;
  savedProfile: RoleProfile;
};

const draftOf = (template: AnyRoleTemplate): Draft => ({
  ...(template.official ? {} : { id: template.id, version: template.version }),
  official: template.official,
  name: template.name,
  profile: template.profile,
  savedName: template.name,
  savedProfile: template.profile,
});

const blankDraft = (): Draft => ({
  official: false,
  name: "",
  profile: emptyRoleProfile(),
  savedName: "",
  savedProfile: emptyRoleProfile(),
});

/**
 * 角色模板 (story ROLE1): the person's own role templates and the package's official ones.
 *
 * A template is identity, persona and 工作手册, written by hand, pasted as Markdown or proposed by
 * smart generation — and saved only when the person saves it. Coworkers made from one are copies
 * with a pointer back; editing a template changes none of them until each is updated by hand.
 */
export function RoleTemplatesScreen() {
  const queryClient = useQueryClient();
  const templates = useQuery(roleTemplatesQueryOptions());
  const save = useMutation(saveRoleTemplateMutationOptions(queryClient));
  const remove = useMutation(deleteRoleTemplateMutationOptions(queryClient));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dirty =
    draft !== null &&
    (draft.name !== draft.savedName ||
      JSON.stringify(draft.profile) !== JSON.stringify(draft.savedProfile));

  // Leaving with an unsaved change asks first, in the app and on a reload or tab close alike.
  useBlocker({
    shouldBlockFn: () =>
      dirty && !window.confirm("有未保存的修改，确定要离开吗？"),
    enableBeforeUnload: () => dirty,
  });

  /** Switching to another template is leaving this one, so it asks the same question. */
  const open = (next: Draft) => {
    if (dirty && !window.confirm("有未保存的修改，确定要放弃吗？")) return;
    setError(null);
    setNotice(null);
    setDraft(next);
  };

  const onSave = async () => {
    if (!draft) return;
    setError(null);
    setNotice(null);
    const checked = validateRoleProfile(draft.profile);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    try {
      const saved = await save.mutateAsync({
        ...(draft.id ? { id: draft.id, version: draft.version } : {}),
        name: draft.name.trim(),
        profile: checked.profile,
      });
      setDraft(draftOf(saved));
      setNotice(`已保存为 v${saved.version}。用它建的员工不会自动更新。`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "模板保存失败。");
    }
  };

  const own = templates.data?.templates ?? [];
  const official = templates.data?.official ?? [];
  const tooLong =
    draft !== null && characterCount(draft.profile.bible) > ROLE_LIMITS.bible;

  return (
    <PageShell
      action={
        <Button onClick={() => open(blankDraft())} size="sm" variant="outline">
          新建模板
        </Button>
      }
      description="角色模板包含身份、人设和工作手册，可以复用给新员工。模板更新后，员工不会自动跟随，需要在员工详情里按模板更新。"
      title="角色模板"
    >
      <PageSection title="我的模板">
        {templates.isError ? (
          <p className="text-destructive text-sm" role="alert">
            读不到角色模板。
          </p>
        ) : own.length === 0 ? (
          <p className="text-muted-foreground text-sm">还没有模板。</p>
        ) : (
          <div className="flex flex-col gap-1">
            {own.map((template) => (
              <Item key={template.id} variant="muted">
                <ItemContent>
                  <ItemTitle>{template.name}</ItemTitle>
                  <ItemDescription>
                    v{template.version}
                    {template.profile.identity.title
                      ? ` · ${template.profile.identity.title}`
                      : ""}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    onClick={() => open(draftOf(template))}
                    size="sm"
                    variant="outline"
                  >
                    编辑
                  </Button>
                  <Button
                    disabled={remove.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `删除模板「${template.name}」？用它建的员工会保留现有内容。`,
                        )
                      ) {
                        remove.mutate(template.id);
                        if (draft?.id === template.id) setDraft(null);
                      }
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    删除
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </div>
        )}
      </PageSection>

      {official.length > 0 ? (
        <PageSection title="官方模板">
          <div className="flex flex-col gap-1">
            {official.map((template) => (
              <Item key={template.id} variant="muted">
                <ItemContent>
                  <ItemTitle>{template.name}</ItemTitle>
                  <ItemDescription>
                    {template.profile.identity.title} · 只读
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    onClick={() => open(draftOf(template))}
                    size="sm"
                    variant="outline"
                  >
                    查看
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </div>
        </PageSection>
      ) : null}

      {draft ? (
        <PageSection
          title={
            draft.official
              ? `官方模板：${draft.name}`
              : draft.id
                ? `编辑：${draft.savedName}（v${draft.version}）`
                : "新模板"
          }
        >
          <div className="flex flex-col gap-3">
            {draft.official ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">
                  官方模板只读，可以复制成自己的再修改。
                </span>
                <Button
                  onClick={() =>
                    setDraft({
                      ...blankDraft(),
                      name: draft.name,
                      profile: draft.profile,
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  复制为我的模板
                </Button>
              </div>
            ) : (
              <>
                <label
                  className="flex flex-col gap-1 text-sm"
                  htmlFor="role-template-name"
                >
                  <span className="font-medium">模板名称</span>
                  <Input
                    id="role-template-name"
                    maxLength={ROLE_LIMITS.templateName}
                    onChange={(event) =>
                      setDraft({ ...draft, name: event.target.value })
                    }
                    value={draft.name}
                  />
                </label>
                <RoleGeneratePanel
                  onGenerated={(profile) => setDraft({ ...draft, profile })}
                />
              </>
            )}
            <RoleEditor
              fileName={draft.name || "角色"}
              onChange={(profile) => setDraft({ ...draft, profile })}
              readOnly={draft.official}
              value={draft.profile}
            />
            {draft.official ? null : (
              <div className="flex items-center gap-2">
                <Button
                  disabled={
                    save.isPending || !draft.name.trim() || tooLong || !dirty
                  }
                  onClick={onSave}
                  size="sm"
                >
                  {save.isPending ? "正在保存…" : "保存模板"}
                </Button>
                {dirty ? (
                  <span className="text-muted-foreground text-xs">
                    有未保存的修改
                  </span>
                ) : null}
              </div>
            )}
            {error ? (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p className="text-muted-foreground text-sm">{notice}</p>
            ) : null}
          </div>
        </PageSection>
      ) : null}
    </PageShell>
  );
}
