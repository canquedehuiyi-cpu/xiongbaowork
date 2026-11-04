import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AVATAR_SOURCE_LABEL_LIMIT,
  AVATAR_SOURCE_LIMIT,
  AVATAR_SOURCE_NOTE_LIMIT,
  type AvatarSource,
  addAvatarSourceMutationOptions,
  avatarSourcesQueryOptions,
  removeAvatarSourceMutationOptions,
  sourceLength,
} from "@/lib/avatar/sources";
import { advanceOnboardingMutationOptions } from "@/lib/onboarding/mutations";

/**
 * Where a person tells their 分身 where their material lives (story F1, stage 1).
 *
 * Two places, one vocabulary: the onboarding step right after the welcome, and the 分身's own detail
 * page, where a person who skipped the step configures it later (spec D3). Only declarations exist
 * yet: a name and a note in the person's own words. Nothing here reads, uploads or links a file, and
 * the page says so, because "信息来源" otherwise reads like a folder picker. A local folder waits on
 * the desktop runner (F2) and is not offered at all rather than offered greyed out (D4).
 *
 * Sending the names and notes to the model is said in a sentence and agreed to with one tick (D6),
 * before anything can be saved: they go into the 分身's prompt on every run.
 */

/** A draft as the person typed it, and whether it can be saved as it stands. */
function draftProblem(label: string, note: string): string | null {
  if (label.trim().length === 0) return "请给这个信息来源起个名字。";
  if (sourceLength(label.trim()) > AVATAR_SOURCE_LABEL_LIMIT)
    return `名称最多 ${AVATAR_SOURCE_LABEL_LIMIT} 个字。`;
  if (sourceLength(note.trim()) > AVATAR_SOURCE_NOTE_LIMIT)
    return `说明最多 ${AVATAR_SOURCE_NOTE_LIMIT} 个字。`;
  return null;
}

function ModelNotice({
  checked,
  id,
  onChange,
}: {
  checked: boolean;
  id: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
      <p className="text-muted-foreground">
        分身每次回答时，会把这些信息来源的名称和说明一起发送给你所用的模型服务。这里只登记文字说明，不会读取或上传任何文件。
      </p>
      <label className="flex items-center gap-2" htmlFor={id}>
        <Checkbox
          checked={checked}
          id={id}
          onCheckedChange={(next) => onChange(next === true)}
        />
        我已了解，信息来源的说明会发送给模型服务
      </label>
    </div>
  );
}

function DraftFields({
  idPrefix,
  label,
  note,
  onLabel,
  onNote,
}: {
  idPrefix: string;
  label: string;
  note: string;
  onLabel: (value: string) => void;
  onNote: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={`${idPrefix}-label`}>名称</label>
        <Input
          id={`${idPrefix}-label`}
          onChange={(event) => onLabel(event.target.value)}
          placeholder="例如：周报"
          value={label}
        />
        <span className="text-muted-foreground text-xs">
          {sourceLength(label.trim())}/{AVATAR_SOURCE_LABEL_LIMIT}
        </span>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={`${idPrefix}-note`}>说明（可选）</label>
        <Textarea
          id={`${idPrefix}-note`}
          onChange={(event) => onNote(event.target.value)}
          placeholder="例如：在飞书 / 工作 / 周报，每周五更新"
          value={note}
        />
        <span className="text-muted-foreground text-xs">
          {sourceLength(note.trim())}/{AVATAR_SOURCE_NOTE_LIMIT}
        </span>
      </div>
    </div>
  );
}

function SavedSources({
  onRemove,
  removingId,
  sources,
}: {
  onRemove: (id: string) => void;
  removingId: string | null;
  sources: AvatarSource[];
}) {
  if (sources.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">还没有登记信息来源。</p>
    );
  }
  return (
    <ul aria-label="已登记的信息来源" className="flex flex-col gap-2">
      {sources.map((source) => (
        <li
          className="flex items-start justify-between gap-3 rounded-lg bg-card p-3"
          key={source.id}
        >
          <div className="flex min-w-0 flex-col">
            <span className="font-medium text-sm">{source.label}</span>
            {source.note ? (
              <span className="text-muted-foreground text-xs">
                {source.note}
              </span>
            ) : null}
          </div>
          <Button
            aria-label={`删除 ${source.label}`}
            disabled={removingId === source.id}
            onClick={() => onRemove(source.id)}
            size="sm"
            variant="ghost"
          >
            {removingId === source.id ? "正在删除…" : "删除"}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The shared state of both places: the saved list, the draft, the tick, and the two writes. */
function useSourceEditor() {
  const queryClient = useQueryClient();
  const state = useQuery(avatarSourcesQueryOptions());
  const add = useMutation(addAvatarSourceMutationOptions(queryClient));
  const remove = useMutation(removeAvatarSourceMutationOptions(queryClient));
  const [label, setLabel] = React.useState("");
  const [note, setNote] = React.useState("");
  const [consent, setConsent] = React.useState(false);

  const sources = state.data?.sources ?? [];
  const full = sources.length >= AVATAR_SOURCE_LIMIT;
  const drafted = label.trim().length > 0 || note.trim().length > 0;
  const problem = draftProblem(label, note);

  /** Save the draft, then clear it. Resolves false when it was refused, so a caller can stop. */
  const saveDraft = async () => {
    try {
      await add.mutateAsync({ label: label.trim(), note: note.trim() });
    } catch {
      return false;
    }
    setLabel("");
    setNote("");
    return true;
  };

  return {
    add,
    consent,
    drafted,
    full,
    label,
    note,
    problem,
    remove,
    saveDraft,
    setConsent,
    setLabel,
    setNote,
    sources,
    state,
  };
}

/**
 * The onboarding step (spec D3, D8): save and continue, or skip and configure it later.
 *
 * Both ways out write the step to the server before moving on, so a reload comes back to the step
 * after this one; skipping writes no source and leaves the 分身 待配置.
 */
export function SourcesStep({
  nextStep,
  onAdvanced,
}: {
  /** The wizard step this one leads to. */
  nextStep: number;
  onAdvanced: () => void;
}) {
  const queryClient = useQueryClient();
  const editor = useSourceEditor();
  const advance = useMutation(advanceOnboardingMutationOptions(queryClient));
  const busy = editor.add.isPending || advance.isPending;

  const moveOn = () => advance.mutate(nextStep, { onSuccess: onAdvanced });

  const canAddAnother =
    editor.consent && editor.drafted && !editor.problem && !editor.full;
  const canContinue = editor.drafted
    ? canAddAnother
    : editor.sources.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
      <h1 className="text-center text-3xl font-semibold tracking-tight">
        告诉你的分身，你的资料在哪里
      </h1>
      <p className="text-center text-muted-foreground text-sm">
        写下资料放在哪里、是什么，分身回答与你本人有关的问题时会参考这些信息来源。最多{" "}
        {AVATAR_SOURCE_LIMIT} 个，之后也可以在分身的详情页修改。
      </p>

      <SavedSources
        onRemove={(id) => editor.remove.mutate(id)}
        removingId={
          editor.remove.isPending ? (editor.remove.variables ?? null) : null
        }
        sources={editor.sources}
      />

      {editor.full ? (
        <p className="text-muted-foreground text-sm">
          已经登记了 {AVATAR_SOURCE_LIMIT} 个信息来源，这是上限。
        </p>
      ) : (
        <DraftFields
          idPrefix="onboarding-source"
          label={editor.label}
          note={editor.note}
          onLabel={editor.setLabel}
          onNote={editor.setNote}
        />
      )}

      <ModelNotice
        checked={editor.consent}
        id="onboarding-source-consent"
        onChange={editor.setConsent}
      />

      {editor.drafted && editor.problem ? (
        <p className="text-muted-foreground text-sm">{editor.problem}</p>
      ) : null}
      {editor.add.error || advance.error || editor.remove.error ? (
        <p className="text-destructive text-sm" role="alert">
          {(editor.add.error ?? advance.error ?? editor.remove.error)?.message}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <Button
          disabled={busy || !canContinue}
          onClick={async () => {
            if (editor.drafted && !(await editor.saveDraft())) return;
            moveOn();
          }}
          size="lg"
        >
          {busy ? "正在保存…" : "保存并继续"}
        </Button>
        <Button
          disabled={busy || !canAddAnother}
          onClick={() => void editor.saveDraft()}
          size="lg"
          variant="outline"
        >
          保存，再加一个
        </Button>
        <Button disabled={busy} onClick={moveOn} size="lg" variant="ghost">
          跳过，稍后在分身详情页配置
        </Button>
      </div>
    </div>
  );
}

/** The 分身's detail page: list, add and remove, the same rules as the step. */
export function AvatarSourcesPanel() {
  const editor = useSourceEditor();

  if (editor.state.isPending) {
    return <p className="text-muted-foreground text-sm">正在加载信息来源…</p>;
  }
  if (editor.state.isError) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {editor.state.error.message}
      </p>
    );
  }

  const canAdd =
    editor.consent && editor.drafted && !editor.problem && !editor.full;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        已登记 {editor.sources.length}/{AVATAR_SOURCE_LIMIT}
        {editor.state.data?.configuredAt === null ? " · 待配置" : ""}
      </p>
      <SavedSources
        onRemove={(id) => editor.remove.mutate(id)}
        removingId={
          editor.remove.isPending ? (editor.remove.variables ?? null) : null
        }
        sources={editor.sources}
      />
      {editor.full ? (
        <p className="text-muted-foreground text-sm">
          已经登记了 {AVATAR_SOURCE_LIMIT} 个信息来源，这是上限。
        </p>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (canAdd) void editor.saveDraft();
          }}
        >
          <DraftFields
            idPrefix="avatar-source"
            label={editor.label}
            note={editor.note}
            onLabel={editor.setLabel}
            onNote={editor.setNote}
          />
          <ModelNotice
            checked={editor.consent}
            id="avatar-source-consent"
            onChange={editor.setConsent}
          />
          {editor.drafted && editor.problem ? (
            <p className="text-muted-foreground text-sm">{editor.problem}</p>
          ) : null}
          <div>
            <Button
              disabled={editor.add.isPending || !canAdd}
              size="sm"
              type="submit"
            >
              {editor.add.isPending ? "正在保存…" : "添加信息来源"}
            </Button>
          </div>
        </form>
      )}
      {editor.add.error || editor.remove.error ? (
        <p className="text-destructive text-sm" role="alert">
          {(editor.add.error ?? editor.remove.error)?.message}
        </p>
      ) : null}
    </div>
  );
}
