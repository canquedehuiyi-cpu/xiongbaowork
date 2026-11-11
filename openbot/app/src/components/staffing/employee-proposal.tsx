import { useQuery } from "@tanstack/react-query";
import Avatar from "boring-avatars";
import { type ReactNode, useId, useState } from "react";
import { PRESET_IMAGES } from "@/components/portraits/preset-images";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { PortraitPreset } from "@/lib/portraits/queries";
import { roleTemplatesQueryOptions } from "@/lib/roles/queries";
import {
  type EmployeeDraft,
  type Proposal,
  staffingQuotaQueryOptions,
} from "@/lib/staffing/queries";
import type { Persona } from "../../../../shared/persona";
import {
  ActionProblem,
  CardShell,
  DecisionButtons,
  Section,
  UpgradeLink,
  useDecision,
} from "./card-parts";

/**
 * 新员工的提议卡片。
 *
 * 布局沿用 `components/agents/proposed-bot.tsx`：同一个框，职责描述整段给出、只滚不截——它是每一轮都交给
 * 模型的常驻指令，本人看不全就谈不上同意。与那张卡片不同的是这里可以改：改过的草稿在确认时先存回服务端
 * 再执行。
 *
 * 应用在这里只列名字：起草时算出的状态（要不要先连接、要不要管理员批准）不随提议保存，执行之后结果里
 * 逐项写明，需要连接的给连接按钮。起草时剔除了什么，员工在卡片上方那句话里已经说了，卡片不重复。
 */
export function EmployeeProposal({
  proposal,
}: {
  proposal: Proposal & { kind: "employee" };
}) {
  const [draft, setDraft] = useState<EmployeeDraft>(proposal.draft);
  const [edited, setEdited] = useState(false);
  const decision = useDecision(proposal.id);
  const quota = useQuery(staffingQuotaQueryOptions());

  const change = (patch: Partial<EmployeeDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setEdited(true);
  };
  const changePersona = (key: keyof Persona, value: string) =>
    change({
      persona: {
        tone: draft.persona?.tone ?? "",
        principles: draft.persona?.principles ?? "",
        habits: draft.persona?.habits ?? "",
        [key]: value,
      },
    });

  const limits = quota.data?.limits;
  const used = quota.data?.usage.wakers;
  const seats =
    limits && used !== undefined ? { used, limit: limits.wakers } : null;
  const full = seats !== null && seats.used >= seats.limit;
  const blank = draft.name.trim() === "" || draft.roleDescription.trim() === "";

  return (
    <CardShell
      caption="你按下「确认创建」之前，什么都不会创建。"
      proposalId={proposal.id}
      status="pending"
      title={`招聘「${draft.name.trim() || "新员工"}」`}
    >
      <EmployeeHeader draft={draft} />

      <div className="mt-3 flex flex-col">
        <Section open title="名字与头衔">
          <Field label="名字">
            {(id) => (
              <Input
                className="h-11"
                id={id}
                maxLength={80}
                onChange={(event) => change({ name: event.target.value })}
                value={draft.name}
              />
            )}
          </Field>
          <Field label="头衔">
            {(id) => (
              <Input
                className="h-11"
                id={id}
                maxLength={120}
                onChange={(event) => change({ title: event.target.value })}
                value={draft.title}
              />
            )}
          </Field>
        </Section>

        <Section title="人设与风格">
          {PERSONA_PARTS.map((part) => (
            <Field key={part.key} label={part.label}>
              {(id) => (
                <Textarea
                  className="max-h-56"
                  id={id}
                  maxLength={2000}
                  onChange={(event) =>
                    changePersona(part.key, event.target.value)
                  }
                  value={draft.persona?.[part.key] ?? ""}
                />
              )}
            </Field>
          ))}
        </Section>

        <Section open title="工作指令">
          <Field
            hint="它的常驻指令，每一轮都会把这段文字交给模型。"
            label="职责描述"
          >
            {(id) => (
              <Textarea
                className="max-h-56 overflow-y-auto"
                id={id}
                maxLength={1000}
                onChange={(event) =>
                  change({ roleDescription: event.target.value })
                }
                value={draft.roleDescription}
              />
            )}
          </Field>
        </Section>

        <Section open={Boolean(draft.bible)} title="工作手册">
          <Field
            hint="更长的做事规范，整段交给它；确认之前请读完。"
            label="工作手册"
          >
            {(id) => (
              <Textarea
                className="max-h-56 overflow-y-auto"
                id={id}
                maxLength={8000}
                onChange={(event) => change({ bible: event.target.value })}
                value={draft.bible ?? ""}
              />
            )}
          </Field>
        </Section>

        <Section title="模型与技能">
          <p className="text-sm">
            <span className="text-muted-foreground">模型：</span>
            {draft.model
              ? "modelRef" in draft.model
                ? draft.model.modelRef
                : draft.model.platformModelRef
              : "默认模型"}
          </p>
          <RemovableList
            empty="没有要装的技能"
            items={draft.skills.map((slug) => ({ key: slug, label: slug }))}
            noun="技能"
            onRemove={(slug) =>
              change({ skills: draft.skills.filter((item) => item !== slug) })
            }
          />
        </Section>

        <Section title="应用">
          <RemovableList
            empty="没有要给的应用"
            items={draft.apps.map((entry) => ({
              key: entry.app,
              label: entry.app,
              detail:
                entry.actions.length > 0
                  ? entry.actions.join("、")
                  : READ_ONLY_ACTIONS,
            }))}
            noun="应用"
            onRemove={(app) =>
              change({ apps: draft.apps.filter((entry) => entry.app !== app) })
            }
          />
          {draft.apps.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              能直接给的确认后就给；要管理员批准的会替你提申请；要先连接账号的，结果里会有连接按钮。
            </p>
          ) : null}
        </Section>

        <Section title="定时任务">
          <RemovableList
            empty="没有定时任务"
            items={draft.routines.map((routine, index) => ({
              key: String(index),
              label: routine.title || routine.cron,
              detail: `${routine.cron}${routine.timezone ? `（${routine.timezone}）` : ""} · ${routine.instruction}`,
            }))}
            noun="定时任务"
            onRemove={(key) =>
              change({
                routines: draft.routines.filter(
                  (_, index) => String(index) !== key,
                ),
              })
            }
          />
        </Section>

        <Visibility
          onPrivate={() => change({ visibility: "private" })}
          visibility={draft.visibility}
        />

        <label className="flex min-h-11 cursor-pointer items-center gap-3 border-border border-t text-sm">
          <input
            checked={draft.staffingTools}
            className="size-5 accent-[var(--signal)]"
            onChange={(event) =>
              change({ staffingTools: event.target.checked })
            }
            type="checkbox"
          />
          也给它招聘与组群能力
        </label>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {seats ? (
          full ? (
            <div className="text-sm">
              <p className="font-medium text-destructive">
                员工名额已满（{seats.used} / {seats.limit}）
              </p>
              <UpgradeLink />
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              这是第 {seats.used + 1} / {seats.limit} 个员工
            </p>
          )
        ) : null}
        {blank ? (
          <p className="text-destructive text-sm">名字和职责描述不能为空。</p>
        ) : null}
        {decision.error ? <ActionProblem error={decision.error} /> : null}
        <DecisionButtons
          busy={decision.busy}
          confirmBlocked={full || blank}
          confirmLabel="确认创建"
          onConfirm={() => void decision.confirm(edited ? draft : null)}
          onDiscard={() => void decision.discard()}
        />
      </div>
    </CardShell>
  );
}

/** 应用没有点名动作时给的是什么（服务端 `giveApp`：本人能直接给的只读动作）。 */
export const READ_ONLY_ACTIONS = "能直接给的只读动作";

/**
 * 谁能用它。公开是确认之后最难收回的一件事（团队里每个人都看得到、用得上），所以用信号色写明，并给一个
 * 改回只有自己能用的按钮；私有照常一行字。
 */
function Visibility({
  visibility,
  onPrivate,
}: {
  visibility: EmployeeDraft["visibility"];
  onPrivate: () => void;
}) {
  if (visibility !== "public")
    return (
      <p className="flex min-h-11 items-center border-border border-t text-sm">
        <span className="text-muted-foreground">可见范围：</span>
        <span>只有你能用</span>
      </p>
    );
  return (
    <div className="flex flex-col gap-1 border-border border-t py-2 text-sm">
      <p>
        <span className="text-muted-foreground">可见范围：</span>
        <span className="font-bold text-signal">公开给全团队</span>
      </p>
      <p className="text-signal text-xs">
        确认之后，团队里的每个人都能看到并使用它。
      </p>
      <Button className="h-11 self-start" onClick={onPrivate} variant="outline">
        改成只有你能用
      </Button>
    </div>
  );
}

const PERSONA_PARTS: { key: keyof Persona; label: string }[] = [
  { key: "tone", label: "性格语气" },
  { key: "principles", label: "工作守则" },
  { key: "habits", label: "口头约束" },
];

/** 顶部：头像、名字、头衔、基于哪个角色模板。 */
function EmployeeHeader({ draft }: { draft: EmployeeDraft }) {
  const templates = useQuery({
    ...roleTemplatesQueryOptions(),
    enabled: draft.roleTemplate !== undefined,
  });
  const template = draft.roleTemplate
    ? [
        ...(templates.data?.templates ?? []),
        ...(templates.data?.official ?? []),
      ].find((entry) => entry.id === draft.roleTemplate?.id)
    : undefined;
  return (
    <div className="flex items-center gap-3">
      <DraftAvatar avatar={draft.avatar} name={draft.name} />
      <div className="min-w-0">
        <p className="break-words font-semibold">{draft.name || "新员工"}</p>
        {draft.title ? (
          <p className="break-words text-muted-foreground text-sm">
            {draft.title}
          </p>
        ) : null}
        {draft.roleTemplate ? (
          <p className="text-muted-foreground text-xs">
            基于模板：{template?.name ?? "一个角色模板"}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function DraftAvatar({
  avatar,
  name,
}: {
  avatar: EmployeeDraft["avatar"];
  name: string;
}) {
  if (avatar && "preset" in avatar && avatar.preset in PRESET_IMAGES)
    return (
      <img
        alt=""
        className="size-12 shrink-0 rounded-full"
        height={48}
        src={PRESET_IMAGES[avatar.preset as PortraitPreset]}
        width={48}
      />
    );
  const seed = avatar && "seed" in avatar ? avatar.seed : name || "new";
  return (
    <span aria-hidden="true" className="size-12 shrink-0">
      <Avatar className="size-full" name={seed} size={48} />
    </span>
  );
}

/** 一个带标签的输入框；标签用 `for` 指着它，读屏和测试都按标签找得到。 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label className="text-muted-foreground text-xs" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

/** 技能、应用、定时任务：逐项列出，每项一个「移除」按钮（按钮名里带上是哪一项）。 */
function RemovableList({
  items,
  noun,
  empty,
  onRemove,
}: {
  items: { key: string; label: string; detail?: string }[];
  noun: string;
  empty: string;
  onRemove: (key: string) => void;
}) {
  if (items.length === 0)
    return <p className="text-muted-foreground text-sm">{empty}</p>;
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li className="flex items-center justify-between gap-2" key={item.key}>
          <div className="min-w-0">
            <p className="break-words text-sm">{item.label}</p>
            {item.detail ? (
              <p className="break-words text-muted-foreground text-xs">
                {item.detail}
              </p>
            ) : null}
          </div>
          <Button
            aria-label={`移除${noun} ${item.label}`}
            className="h-11 min-w-11 shrink-0"
            onClick={() => onRemove(item.key)}
            variant="ghost"
          >
            移除
          </Button>
        </li>
      ))}
    </ul>
  );
}
