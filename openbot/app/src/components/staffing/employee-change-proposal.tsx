import { useQuery } from "@tanstack/react-query";
import { type AgentProfile, agentQueryOptions } from "@/lib/agents/queries";
import type { AgentRoleFields } from "@/lib/roles/queries";
import { routinesQueryOptions } from "@/lib/routines/queries";
import type {
  AppDraft,
  ModelDraft,
  Proposal,
  RoutineDraft,
} from "@/lib/staffing/queries";
import type { Persona } from "../../../../shared/persona";
import {
  ActionProblem,
  CardShell,
  DecisionButtons,
  useDecision,
} from "./card-parts";
import { READ_ONLY_ACTIONS } from "./employee-proposal";
import { BeforeAfter } from "./group-proposal";

/**
 * 改员工的提议卡片：只列要改的字段，每项「改前 → 改后」，旧值带删除线。
 *
 * 改前读的是员工此刻的资料（`GET /api/agents/:id`），不是起草时的：起草之后员工被改过，服务端会拒绝执行
 * 并说「内容已变化」，所以这里看到的改前就是确认时要被替换掉的。这张卡片不在原地编辑——改动本身就是员工
 * 拟的那几项，要改别的，请小管家重新起草。
 */
export function EmployeeChangeProposal({
  proposal,
}: {
  proposal: Proposal & { kind: "employee_change" };
}) {
  const { draft } = proposal;
  const { set } = draft;
  const decision = useDecision(proposal.id);
  const agent = useQuery(agentQueryOptions(draft.agentId));
  const routines = useQuery({
    ...routinesQueryOptions(),
    enabled: draft.routinesRemove.length > 0,
  });
  const current = agent.data as (AgentProfile & AgentRoleFields) | undefined;
  const was = (value: string | null | undefined) =>
    current === undefined ? null : (value ?? "");
  const routineName = (id: string) => {
    const routine = routines.data?.routines.find((entry) => entry.id === id);
    return routine ? routine.title || routine.schedule : "一条定时任务";
  };

  return (
    <CardShell
      caption="只列出要改的地方。你按下「确认修改」之前，什么都不会改。"
      proposalId={proposal.id}
      status="pending"
      title={`调整「${current?.name ?? set.name ?? "员工"}」`}
    >
      <div className="flex flex-col gap-3 text-sm">
        {set.name !== undefined ? (
          <BeforeAfter
            after={set.name}
            before={was(current?.name)}
            label="名字"
          />
        ) : null}
        {set.title !== undefined ? (
          <BeforeAfter
            after={set.title}
            before={was(current?.title)}
            label="头衔"
          />
        ) : null}
        {set.avatar !== undefined ? (
          <BeforeAfter
            after={
              "preset" in set.avatar
                ? `换成预设头像（${set.avatar.preset}）`
                : "换一个新头像"
            }
            before={null}
            label="头像"
          />
        ) : null}
        {set.roleDescription !== undefined ? (
          <BeforeAfter
            after={set.roleDescription}
            before={was(current?.roleDescription)}
            label="职责描述"
          />
        ) : null}
        {/* 单独的工作指令只有个人起步员工有，服务端起草时已经只给它们保留这一项；草稿里有就一定写出来，
            不等员工资料读到，免得资料还没读回时出现「卡片上看不到、确认后却会做」的空档。 */}
        {set.instructions !== undefined ? (
          <BeforeAfter
            after={set.instructions}
            before={was(current?.instructions)}
            label="补充指令"
          />
        ) : null}
        {set.persona
          ? PERSONA_PARTS.filter((part) => set.persona?.[part.key]).map(
              (part) => (
                <BeforeAfter
                  after={set.persona?.[part.key] ?? ""}
                  before={was(current?.persona?.[part.key])}
                  key={part.key}
                  label={part.label}
                />
              ),
            )
          : null}
        {set.bible !== undefined ? (
          <BeforeAfter
            after={set.bible}
            before={was(current?.bible)}
            label="工作手册"
          />
        ) : null}
        {set.model !== undefined ? (
          <BeforeAfter
            after={modelName(set.model)}
            before={
              current === undefined
                ? null
                : (current.modelRef ?? current.platformModelRef ?? "默认模型")
            }
            label="模型"
          />
        ) : null}
        {set.visibility !== undefined ? (
          <div className="flex flex-col gap-0.5">
            <BeforeAfter
              after={VISIBILITY[set.visibility]}
              before={current ? VISIBILITY[current.visibility] : null}
              label="可见范围"
              signal={set.visibility === "public"}
            />
            {set.visibility === "public" ? (
              <p className="text-signal text-xs">
                确认之后，团队里的每个人都能看到并使用它。
              </p>
            ) : null}
          </div>
        ) : null}
        {set.skills && set.skills.length > 0 ? (
          <Added label="新增技能" items={set.skills} />
        ) : null}
        {set.apps && set.apps.length > 0 ? (
          <Listed
            items={set.apps.map((entry) => appLine(entry, READ_ONLY_ACTIONS))}
            label="新增应用"
          />
        ) : null}
        {set.routines && set.routines.length > 0 ? (
          <NewRoutines routines={set.routines} />
        ) : null}
        {draft.appsRemove.length > 0 ? (
          <Listed
            items={draft.appsRemove.map((entry) => appLine(entry, "整个应用"))}
            label="收回应用"
            struck
          />
        ) : null}
        {draft.routinesRemove.length > 0 ? (
          <Removed
            items={draft.routinesRemove.map(routineName)}
            label="删除定时任务"
          />
        ) : null}
        {decision.error ? <ActionProblem error={decision.error} /> : null}
        <DecisionButtons
          busy={decision.busy}
          confirmLabel="确认修改"
          onConfirm={() => void decision.confirm(null)}
          onDiscard={() => void decision.discard()}
        />
      </div>
    </CardShell>
  );
}

const PERSONA_PARTS: { key: keyof Persona; label: string }[] = [
  { key: "tone", label: "性格语气" },
  { key: "principles", label: "工作守则" },
  { key: "habits", label: "口头约束" },
];

const VISIBILITY = {
  private: "只有你能用",
  public: "公开给全团队",
} as const;

/** 一个应用与它的动作；没点名动作时说给的是什么。 */
function appLine(entry: AppDraft, whenNone: string): string {
  return `${entry.app}：${entry.actions.length > 0 ? entry.actions.join("、") : whenNone}`;
}

/** 逐项列出（应用与它的动作各占一行），收回的带删除线。 */
function Listed({
  label,
  items,
  struck = false,
}: {
  label: string;
  items: string[];
  struck?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-muted-foreground text-xs">{label}</p>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li className="break-words" key={item}>
            {struck ? <s>{item}</s> : item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 新加的定时任务：名字与时间，再整段给出每次触发要做的事——那是它会照着做的全文。 */
function NewRoutines({ routines }: { routines: RoutineDraft[] }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground text-xs">新增定时任务</p>
      <ul className="flex flex-col gap-2">
        {routines.map((routine) => {
          const when = `${routine.cron}${routine.timezone ? `，${routine.timezone}` : ""}`;
          return (
            <li
              className="flex flex-col gap-0.5"
              // 同一份草稿里不会有两条名字、时间、指令都一样的定时任务。
              key={`${routine.title ?? ""}|${routine.cron}|${routine.instruction}`}
            >
              <p className="break-words font-medium">
                {routine.title ? `${routine.title}（${when}）` : when}
              </p>
              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                {routine.instruction}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function modelName(model: ModelDraft): string {
  return "modelRef" in model ? model.modelRef : model.platformModelRef;
}

function Added({ label, items }: { label: string; items: string[] }) {
  return (
    <p className="break-words">
      <span className="text-muted-foreground">{label}：</span>
      {items.join("、")}
    </p>
  );
}

function Removed({ label, items }: { label: string; items: string[] }) {
  return (
    <p className="break-words">
      <span className="text-muted-foreground">{label}：</span>
      <s>{items.join("、")}</s>
    </p>
  );
}
