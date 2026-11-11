/*
 * M5b 第 0 步：从 `routes/_authed/_app/role-templates.tsx` 剪出的页面主体，原样保留，地址改成重定向（/role-templates → /capabilities/roles）。
 * 各组在新路由里接这个组件，再按新结构调整其中的链接与文案。
 */
import { IconLayersSubtract, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { useState } from "react";
import {
  PANEL_FACE,
  PROFILE_TAG,
  ProfileAlert,
  ProfileEmpty,
  ProfilePanel,
  ProfileSection,
} from "@/components/bot-profile/profile-kit";
import { PageShell } from "@/components/layout/page-shell";
import { RoleEditor, RoleGeneratePanel } from "@/components/roles/role-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AnyRoleTemplate,
  deleteRoleTemplateMutationOptions,
  roleTemplatesQueryOptions,
  saveRoleTemplateMutationOptions,
} from "@/lib/roles/queries";
import { cn } from "@/lib/utils";
import {
  characterCount,
  emptyRoleProfile,
  ROLE_LIMITS,
  type RoleProfile,
  validateRoleProfile,
} from "../../../../shared/role-profile";


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

  /** The row the editor has open, marked on the list (red is for what is selected). */
  const selected = (template: AnyRoleTemplate) =>
    draft !== null &&
    (template.official
      ? draft.official && draft.name === template.name
      : draft.id === template.id);

  /*
   * Drawn in the workbench frame (docs/design/ios-studio): the templates as a list of 「角色档案」
   * rows on the left and the open one's editor in a panel beside it on a wide screen; one column on
   * anything narrower, the editor under the list.
   */
  return (
    <PageShell
      action={
        <Button onClick={() => open(blankDraft())}>
          <IconPlus />
          新建模板
        </Button>
      }
      description="角色模板包含身份、人设和工作手册，可以复用给新员工。模板更新后，员工不会自动跟随，需要在员工详情里按模板更新。"
      title="角色模板"
      width="workbench"
    >
      <div className="grid grid-cols-1 gap-[28px] min-[1100px]:grid-cols-[minmax(300px,400px)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-[28px]">
          <ProfileSection
            action={
              templates.data ? (
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {own.length} 个
                </span>
              ) : null
            }
            title="我的模板"
          >
            {templates.isPending ? (
              <Skeleton
                aria-label="正在读取角色模板"
                className="mt-[10px] h-[58px] rounded-[14px]"
                role="status"
              />
            ) : templates.isError ? (
              <ProfileAlert>读不到角色模板。</ProfileAlert>
            ) : own.length === 0 ? (
              <ProfileEmpty>还没有模板。</ProfileEmpty>
            ) : (
              <ProfilePanel>
                {own.map((template) => (
                  <Item
                    className={cn(
                      "relative",
                      selected(template) && TEMPLATE_SELECTED,
                    )}
                    data-selected={selected(template) ? "" : undefined}
                    key={template.id}
                    size="sm"
                  >
                    <ItemMedia className={TEMPLATE_PLATE}>
                      <IconLayersSubtract aria-hidden="true" />
                    </ItemMedia>
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
              </ProfilePanel>
            )}
            {remove.error ? (
              <p className="mt-[8px] text-[13px] text-destructive" role="alert">
                {remove.error.message}
              </p>
            ) : null}
          </ProfileSection>

          {official.length > 0 ? (
            <ProfileSection title="官方模板">
              <ProfilePanel>
                {official.map((template) => (
                  <Item
                    className={cn(
                      "relative",
                      selected(template) && TEMPLATE_SELECTED,
                    )}
                    data-selected={selected(template) ? "" : undefined}
                    key={template.id}
                    size="sm"
                  >
                    <ItemMedia className={TEMPLATE_PLATE}>
                      <IconLayersSubtract aria-hidden="true" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        {template.name}
                        <span
                          className={cn(PROFILE_TAG, "h-[19px] text-[10.5px]")}
                        >
                          官方
                        </span>
                      </ItemTitle>
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
              </ProfilePanel>
            </ProfileSection>
          ) : null}
        </div>

        {draft ? (
          <ProfileSection
            title={
              draft.official
                ? `官方模板：${draft.name}`
                : draft.id
                  ? `编辑：${draft.savedName}（v${draft.version}）`
                  : "新模板"
            }
          >
            <div
              className={cn(
                PANEL_FACE,
                "mt-[10px] flex flex-col gap-[12px] p-[14px] md:p-[18px]",
              )}
            >
              {draft.official ? (
                <div className="flex flex-wrap items-center gap-[8px] text-[13px]">
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
                    className="flex flex-col gap-[6px] text-[13px]"
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
                <div className="flex flex-wrap items-center gap-[8px] border-border border-t pt-[12px]">
                  <Button
                    disabled={
                      save.isPending || !draft.name.trim() || tooLong || !dirty
                    }
                    onClick={onSave}
                  >
                    {save.isPending ? "正在保存…" : "保存模板"}
                  </Button>
                  {dirty ? (
                    <span className="inline-flex items-center gap-[5px] text-[12px] text-muted-foreground">
                      <span
                        aria-hidden="true"
                        className="size-[5px] rounded-full bg-signal"
                      />
                      有未保存的修改
                    </span>
                  ) : null}
                </div>
              )}
              {error ? (
                <p className="text-[13px] text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              {notice ? (
                <p className="text-[13px] text-muted-foreground">{notice}</p>
              ) : null}
            </div>
          </ProfileSection>
        ) : (
          <div className="flex min-h-[180px] flex-col items-center justify-center gap-[10px] rounded-[16px] border border-border border-dashed px-[20px] py-[28px] text-center">
            <p className="font-semibold text-[14px]">选一个模板查看或编辑</p>
            <p className="max-w-[44ch] text-[13px] text-muted-foreground">
              或者点右上角「新建模板」：手写、粘贴
              Markdown，或用一句话智能生成。保存后才会生效。
            </p>
          </div>
        )}
      </div>
    </PageShell>
  );
}

/** The 33px plate a template's glyph sits on (theme.css `.symbol`). */
const TEMPLATE_PLATE =
  "size-[33px] shrink-0 rounded-[9px] border border-foreground/10 bg-muted text-foreground/85 [&_svg]:size-[17px]";

/** The open template's row: a lifted face and a short signal bar at its left edge. */
const TEMPLATE_SELECTED =
  "bg-foreground/[0.04] before:absolute before:inset-y-[12px] before:left-0 before:w-[2px] before:rounded-r-[2px] before:bg-signal before:content-['']";
