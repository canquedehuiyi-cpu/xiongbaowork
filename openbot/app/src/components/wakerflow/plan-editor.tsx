import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Flowchart } from "@/components/wakerflow/flowchart";
import { RequestError } from "@/lib/client";
import {
  INPUT_TYPE_LABEL,
  jumpChoices,
  planForSave,
  planProblems,
  STEP_KIND_LABEL,
  saveWakerFlow,
  stepAgentId,
  stepKind,
  stepOfKind,
  stepOutputKey,
  WAKERFLOW_CONFLICT_MESSAGE,
  WAKERFLOW_END,
  WAKERFLOW_INPUT_TYPES,
  WAKERFLOW_MAX_BRANCHES,
  WAKERFLOW_STEP_KINDS,
  type WakerFlow,
  type WakerFlowInput,
  type WakerFlowInputType,
  type WakerFlowPlan,
  type WakerFlowStep,
  type WakerFlowStepKind,
  wakerFlowsQueryOptions,
} from "@/lib/wakerflows";

type Step = WakerFlowStep;

const selectClass =
  "border-input bg-background rounded-md border px-2 py-1 text-sm";

/** A step id the plan does not use yet, in the server's key shape. */
function nextStepId(steps: Step[]): string {
  const used = new Set(steps.map((step) => step.id));
  let index = steps.length + 1;
  while (used.has(`step_${index}`)) index += 1;
  return `step_${index}`;
}

function FieldError({ message }: { message: string | undefined }) {
  return message ? (
    <p className="text-destructive text-xs" role="alert">
      {message}
    </p>
  ) : null;
}

/** The default value of one input, entered the way its type is entered. Empty means none. */
function DefaultEditor(props: {
  index: number;
  input: WakerFlowInput;
  onChange: (value: string | undefined) => void;
}) {
  const { input } = props;
  const label = `第 ${props.index + 1} 个输入的默认值`;
  const value = input.default ?? "";
  const set = (next: string) => props.onChange(next === "" ? undefined : next);
  if (input.type === "boolean" || input.type === "select") {
    const choices =
      input.type === "boolean"
        ? [
            { value: "true", label: "是" },
            { value: "false", label: "否" },
          ]
        : (input.options ?? [])
            .map((option) => option.trim())
            .filter(Boolean)
            .map((option) => ({ value: option, label: option }));
    return (
      <select
        aria-label={label}
        className={selectClass}
        value={value}
        onChange={(event) => set(event.target.value)}
      >
        <option value="">无默认值</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <Input
      aria-label={label}
      className="w-48"
      inputMode={input.type === "number" ? "decimal" : undefined}
      placeholder="默认值（选填）"
      value={value}
      onChange={(event) => set(event.target.value)}
    />
  );
}

/**
 * The editable plan of one WakerFlow (spec D10, story WF3).
 *
 * What is edited here is the execution contract itself: the coworkers and their roles, the inputs a
 * run asks for, and the steps in order — who does each, what it reads, and the name of what it
 * produces. A step can only read a declared input or an earlier step's output, the same rule the
 * server enforces on Save, so the picker offers exactly those; a reference that stopped being valid
 * (its input was removed) stays visible and blocks Save until it is unticked.
 *
 * Save is fenced by the revision the editor was opened at. Losing that race is not an error to retry:
 * someone else's edit is newer, so the editor offers to reload rather than overwrite it.
 */
export function PlanEditor(props: {
  flowId: string;
  revision: number;
  plan: WakerFlowPlan;
  /** The coworkers that may be put into the plan, by id. */
  coworkers: { id: string; name: string }[];
  onSaved: (flow: WakerFlow) => void;
  onReload: () => void;
}) {
  const [plan, setPlan] = useState<WakerFlowPlan>(props.plan);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  // WF7: which step's form the flowchart points at; the first step until another is chosen.
  const [selected, setSelected] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<WakerFlowStepKind>("worker");
  const selectedId = selected ?? plan.steps[0]?.id;

  const names = new Map(props.coworkers.map((agent) => [agent.id, agent.name]));
  const memberName = (agentId: string) =>
    names.get(agentId) ??
    plan.members.find((member) => member.agentId === agentId)?.role ??
    agentId;

  function edit(next: WakerFlowPlan) {
    setPlan(next);
    setSaved(false);
    // Once a Save was refused, the inline messages follow the edits so a fixed field clears.
    if (Object.keys(problems).length > 0)
      setProblems(planProblems(planForSave(next)));
  }
  const setInput = (index: number, patch: Partial<WakerFlowInput>) =>
    edit({
      ...plan,
      inputs: plan.inputs.map((row, at) =>
        at === index ? { ...row, ...patch } : row,
      ),
    });
  const setStepAt = (index: number, next: Step) =>
    edit({
      ...plan,
      steps: plan.steps.map((step, at) => (at === index ? next : step)),
    });
  const stepTitle = (step: Step) => {
    switch (step.kind) {
      case "decision":
        return (
          step.branches.map((branch) => branch.label).join(" / ") || "条件判断"
        );
      case "flow":
        return "嵌套子流程";
      case "action":
        return step.tool || "调用工具";
      case "confirm":
        return step.question.split("\n")[0] || "（还没写要确认什么）";
      default:
        return step.instruction.split("\n")[0] || "（还没写要做什么）";
    }
  };

  async function save() {
    const sent = planForSave(plan);
    const found = planProblems(sent);
    setProblems(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try {
      const flow = await saveWakerFlow(props.flowId, {
        revision: props.revision,
        plan: sent,
      });
      setSaved(true);
      props.onSaved(flow);
    } catch (error) {
      if (error instanceof RequestError && error.status === 409)
        setConflict(true);
      else
        setFailure(
          error instanceof RequestError
            ? error.message
            : "网络连接中断，计划没有保存。可以再保存一次。",
        );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2" aria-label="流程概况">
        <Input
          aria-label="流程名称"
          value={plan.name}
          onChange={(event) => edit({ ...plan, name: event.target.value })}
        />
        <FieldError message={problems.name} />
        <Textarea
          aria-label="流程说明"
          value={plan.description}
          onChange={(event) =>
            edit({ ...plan, description: event.target.value })
          }
        />
        <FieldError message={problems.description} />
      </section>

      <section className="flex flex-col gap-2" aria-label="参与的员工">
        <h3 className="font-medium text-sm">参与的员工</h3>
        {plan.members.map((member, index) => (
          <div
            className="flex flex-col gap-1"
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until an agent is chosen
            key={index}
          >
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label={`第 ${index + 1} 位员工`}
                className={selectClass}
                value={member.agentId}
                onChange={(event) =>
                  edit({
                    ...plan,
                    members: plan.members.map((row, at) =>
                      at === index
                        ? { ...row, agentId: event.target.value }
                        : row,
                    ),
                  })
                }
              >
                <option value="">选择员工</option>
                {props.coworkers.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
                {member.agentId && !names.has(member.agentId) ? (
                  <option value={member.agentId}>不在你的员工列表中</option>
                ) : null}
              </select>
              <Input
                aria-label={`第 ${index + 1} 位员工的角色`}
                className="w-56"
                placeholder="在流程中的角色"
                value={member.role}
                onChange={(event) =>
                  edit({
                    ...plan,
                    members: plan.members.map((row, at) =>
                      at === index ? { ...row, role: event.target.value } : row,
                    ),
                  })
                }
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  edit({
                    ...plan,
                    members: plan.members.filter((_, at) => at !== index),
                  })
                }
              >
                移除员工
              </Button>
            </div>
            <Textarea
              aria-label={`第 ${index + 1} 位员工的提示词`}
              maxLength={4000}
              placeholder="这位员工在这个流程里负责什么、怎么做（选填），会写在它每一步的开头"
              rows={2}
              value={member.prompt ?? ""}
              onChange={(event) =>
                edit({
                  ...plan,
                  members: plan.members.map((row, at) =>
                    at === index ? { ...row, prompt: event.target.value } : row,
                  ),
                })
              }
            />
            <FieldError message={problems[`members.${index}.agentId`]} />
            <FieldError message={problems[`members.${index}.role`]} />
            <FieldError message={problems[`members.${index}.prompt`]} />
          </div>
        ))}
        <FieldError message={problems.members} />
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              edit({
                ...plan,
                members: [...plan.members, { agentId: "", role: "" }],
              })
            }
          >
            添加员工
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2" aria-label="流程输入">
        <h3 className="font-medium text-sm">流程输入</h3>
        {plan.inputs.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            这个流程运行时不需要额外输入。
          </p>
        ) : null}
        {plan.inputs.map((input, index) => (
          <div
            className="flex flex-col gap-1"
            // biome-ignore lint/suspicious/noArrayIndexKey: the key field itself is what is being edited
            key={index}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`第 ${index + 1} 个输入的名称`}
                className="w-40"
                placeholder="例如 topic"
                value={input.key}
                onChange={(event) =>
                  edit({
                    ...plan,
                    inputs: plan.inputs.map((row, at) =>
                      at === index ? { ...row, key: event.target.value } : row,
                    ),
                  })
                }
              />
              <Input
                aria-label={`第 ${index + 1} 个输入的显示名称`}
                className="w-48"
                placeholder="例如 会议主题"
                value={input.label}
                onChange={(event) =>
                  edit({
                    ...plan,
                    inputs: plan.inputs.map((row, at) =>
                      at === index
                        ? { ...row, label: event.target.value }
                        : row,
                    ),
                  })
                }
              />
              <label className="flex items-center gap-1 text-sm">
                <input
                  checked={input.required}
                  type="checkbox"
                  onChange={(event) =>
                    edit({
                      ...plan,
                      inputs: plan.inputs.map((row, at) =>
                        at === index
                          ? { ...row, required: event.target.checked }
                          : row,
                      ),
                    })
                  }
                />
                必填
              </label>
              <select
                aria-label={`第 ${index + 1} 个输入的类型`}
                className={selectClass}
                value={input.type ?? "text"}
                onChange={(event) => {
                  const type = event.target.value as WakerFlowInputType;
                  // A default or options that belonged to the old type would only be refused.
                  setInput(index, {
                    type,
                    default: undefined,
                    options: type === "select" ? [] : undefined,
                  });
                }}
              >
                {WAKERFLOW_INPUT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {INPUT_TYPE_LABEL[type]}
                  </option>
                ))}
              </select>
              <Button
                aria-label={`删除输入 ${input.key || index + 1}`}
                size="sm"
                variant="outline"
                onClick={() =>
                  edit({
                    ...plan,
                    inputs: plan.inputs.filter((_, at) => at !== index),
                  })
                }
              >
                删除
              </Button>
            </div>
            <FieldError message={problems[`inputs.${index}.key`]} />
            <FieldError message={problems[`inputs.${index}.label`]} />
            <div className="flex flex-wrap items-start gap-2">
              <Input
                aria-label={`第 ${index + 1} 个输入的说明`}
                className="w-64"
                maxLength={200}
                placeholder="说明（选填），运行时显示在输入框下方"
                value={input.description ?? ""}
                onChange={(event) =>
                  setInput(index, { description: event.target.value })
                }
              />
              <DefaultEditor
                index={index}
                input={input}
                onChange={(value) => setInput(index, { default: value })}
              />
            </div>
            {input.type === "select" ? (
              <Textarea
                aria-label={`第 ${index + 1} 个输入的选项`}
                className="w-64"
                placeholder="每行一个选项，最多 20 个"
                rows={3}
                value={(input.options ?? []).join("\n")}
                onChange={(event) =>
                  setInput(index, { options: event.target.value.split("\n") })
                }
              />
            ) : null}
            <FieldError message={problems[`inputs.${index}.description`]} />
            <FieldError message={problems[`inputs.${index}.options`]} />
            <FieldError message={problems[`inputs.${index}.default`]} />
          </div>
        ))}
        <FieldError message={problems.inputs} />
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              edit({
                ...plan,
                inputs: [
                  ...plan.inputs,
                  { key: "", label: "", required: true },
                ],
              })
            }
          >
            添加输入
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-label="执行步骤">
        <h3 className="font-medium text-sm">执行步骤</h3>
        <p className="text-muted-foreground text-xs">
          点流程图里的节点，在右侧编辑这一步。跳转只能指向后面的步骤或结束流程。
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="min-w-0">
            <Flowchart
              detail={(step) => {
                const agent = stepAgentId(step as Step);
                return agent ? memberName(agent) : undefined;
              }}
              label="计划流程图"
              onSelect={(id) => {
                setSelected(id);
                document
                  .getElementById(`step-form-${id}`)
                  ?.scrollIntoView?.({ block: "nearest" });
              }}
              selectedId={selectedId}
              steps={plan.steps}
              title={(step) => stepTitle(step as Step)}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            {plan.steps.map((step, index) => (
              <StepForm
                index={index}
                key={step.id}
                memberName={memberName}
                onChange={(next) => setStepAt(index, next)}
                onRemove={() =>
                  edit({
                    ...plan,
                    steps: plan.steps.filter((_, at) => at !== index),
                  })
                }
                onSelect={() => setSelected(step.id)}
                plan={plan}
                problems={problems}
                selected={selectedId === step.id}
                selfFlowId={props.flowId}
              />
            ))}
          </div>
        </div>
        <FieldError message={problems.steps} />
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="新步骤的类型"
            className={selectClass}
            value={newKind}
            onChange={(event) =>
              setNewKind(event.target.value as WakerFlowStepKind)
            }
          >
            {WAKERFLOW_STEP_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {STEP_KIND_LABEL[kind]}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const id = nextStepId(plan.steps);
              edit({
                ...plan,
                steps: [
                  ...plan.steps,
                  stepOfKind(
                    newKind,
                    id,
                    plan.members[0]?.agentId ?? "",
                    undefined,
                  ),
                ],
              });
              setSelected(id);
            }}
          >
            添加步骤
          </Button>
        </div>
      </section>

      {conflict ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive p-3"
          role="alert"
        >
          <p className="text-destructive text-sm">
            {WAKERFLOW_CONFLICT_MESSAGE}
          </p>
          <Button size="sm" variant="outline" onClick={props.onReload}>
            重新加载
          </Button>
        </div>
      ) : null}
      {failure ? (
        <p className="text-destructive text-sm" role="alert">
          {failure}
        </p>
      ) : null}
      {Object.keys(problems).length > 0 ? (
        <p className="text-destructive text-sm" role="alert">
          计划还有需要修改的地方，改好后再保存。
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button disabled={saving || conflict} onClick={() => void save()}>
          {saving ? "正在保存…" : "保存计划"}
        </Button>
        {saved ? (
          <span className="text-muted-foreground text-sm" role="status">
            已保存。
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The keys a step may read: the declared inputs, then every earlier step's output. */
function offeredKeys(plan: WakerFlowPlan, index: number): string[] {
  return [
    ...plan.inputs.map((input) => input.key),
    ...plan.steps
      .slice(0, index)
      .map((earlier) => stepOutputKey(earlier) ?? ""),
  ].filter((key, at, all) => key && all.indexOf(key) === at);
}

/** Where a step goes when it ends: the next step, or (only) a later step, or the end (P-A, D8). */
function JumpSelect(props: {
  label: string;
  steps: Step[];
  index: number;
  value: string | undefined;
  /** Whether "the next step" is a choice (a decision's branches always name a target). */
  allowDefault: boolean;
  onChange: (value: string | undefined) => void;
}) {
  const choices = jumpChoices(props.steps, props.index);
  return (
    <select
      aria-label={props.label}
      className={selectClass}
      value={props.value ?? ""}
      onChange={(event) =>
        props.onChange(
          event.target.value === "" ? undefined : event.target.value,
        )
      }
    >
      {props.allowDefault ? <option value="">下一步（按顺序）</option> : null}
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}

/** The read checkboxes of a worker, decision or action step. */
function ReadKeys(props: {
  index: number;
  offered: string[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  // A reference that is no longer on offer stays visible so it can be removed.
  const stale = props.value.filter((key) => !props.offered.includes(key));
  return (
    <fieldset className="flex flex-wrap items-center gap-3">
      <legend className="text-muted-foreground text-xs">这一步读取</legend>
      {props.offered.length === 0 && stale.length === 0 ? (
        <span className="text-muted-foreground text-xs">
          没有可读取的输入或前面步骤的输出。
        </span>
      ) : null}
      {[...props.offered, ...stale].map((key) => (
        <label
          className={
            stale.includes(key)
              ? "flex items-center gap-1 text-destructive text-sm"
              : "flex items-center gap-1 text-sm"
          }
          key={key}
        >
          <input
            aria-label={`第 ${props.index + 1} 步读取 ${key}`}
            checked={props.value.includes(key)}
            type="checkbox"
            onChange={(event) =>
              props.onChange(
                event.target.checked
                  ? [...props.value, key]
                  : props.value.filter((entry) => entry !== key),
              )
            }
          />
          {key}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * One step's form (WF7): its kind, then the fields of that kind. Every step's form stays on the page;
 * choosing a node in the flowchart marks and scrolls to it.
 */
function StepForm(props: {
  index: number;
  plan: WakerFlowPlan;
  problems: Record<string, string>;
  memberName: (agentId: string) => string;
  selected: boolean;
  selfFlowId: string;
  onChange: (step: Step) => void;
  onRemove: () => void;
  onSelect: () => void;
}) {
  const { index, plan, problems } = props;
  // biome-ignore lint/style/noNonNullAssertion: the parent renders one form per existing step
  const step = plan.steps[index]!;
  const n = index + 1;
  const at = (field: string) => problems[`steps.${index}.${field}`];
  const offered = offeredKeys(plan, index);
  const kind = stepKind(step);

  const agentSelect = (agentId: string, onChange: (value: string) => void) => (
    <select
      aria-label={`第 ${n} 步的员工`}
      className={selectClass}
      value={agentId}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">选择员工</option>
      {plan.members
        .filter((member) => member.agentId)
        .map((member) => (
          <option key={member.agentId} value={member.agentId}>
            {props.memberName(member.agentId)}
          </option>
        ))}
      {agentId && !plan.members.some((member) => member.agentId === agentId) ? (
        <option value={agentId}>不在计划中的员工</option>
      ) : null}
    </select>
  );
  const outputField = (value: string, onChange: (value: string) => void) => (
    <>
      <Input
        aria-label={`第 ${n} 步的输出名称`}
        className="w-48"
        placeholder="例如 agenda"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError message={at("outputKey")} />
    </>
  );
  const nextField = (value: string | undefined) => (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      完成后
      <JumpSelect
        allowDefault
        index={index}
        label={`第 ${n} 步完成后`}
        onChange={(next) => {
          const { next: _old, ...rest } = step as Step & { next?: string };
          props.onChange(
            (next === undefined ? rest : { ...rest, next }) as Step,
          );
        }}
        steps={plan.steps}
        value={value}
      />
      <FieldError message={at("next")} />
    </div>
  );

  let fields: ReactNode = null;
  if (step.kind === "decision") {
    fields = (
      <>
        <ReadKeys
          index={index}
          offered={offered}
          value={step.inputKeys}
          onChange={(inputKeys) => props.onChange({ ...step, inputKeys })}
        />
        <FieldError message={at("inputKeys")} />
        <p className="text-muted-foreground text-xs">
          条件用 CEL 书写，只能读取上面勾选的项：流程输入写成
          inputs.名称，前面步骤的输出写成 outputs.名称。可用
          ==、&&、||、size()、contains(a, b)、startsWith(a, b)、matches(a,
          正则)、int()、double()。按顺序取第一个成立的分支。
        </p>
        {step.branches.map((branch, at2) => (
          <div
            className="flex flex-col gap-1 rounded-md border border-border p-2"
            // biome-ignore lint/suspicious/noArrayIndexKey: branches have no identity but their place
            key={at2}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`第 ${n} 步第 ${at2 + 1} 个分支的名称`}
                className="w-32"
                placeholder="分支名称"
                value={branch.label}
                onChange={(event) =>
                  props.onChange({
                    ...step,
                    branches: step.branches.map((row, k) =>
                      k === at2 ? { ...row, label: event.target.value } : row,
                    ),
                  })
                }
              />
              <div className="flex items-center gap-2 text-sm">
                跳到
                <JumpSelect
                  allowDefault={false}
                  index={index}
                  label={`第 ${n} 步第 ${at2 + 1} 个分支跳到`}
                  onChange={(next) =>
                    props.onChange({
                      ...step,
                      branches: step.branches.map((row, k) =>
                        k === at2
                          ? { ...row, next: next ?? WAKERFLOW_END }
                          : row,
                      ),
                    })
                  }
                  steps={plan.steps}
                  value={branch.next}
                />
              </div>
              <Button
                aria-label={`删除第 ${n} 步第 ${at2 + 1} 个分支`}
                disabled={step.branches.length <= 1}
                size="sm"
                variant="outline"
                onClick={() =>
                  props.onChange({
                    ...step,
                    branches: step.branches.filter((_, k) => k !== at2),
                  })
                }
              >
                删除分支
              </Button>
            </div>
            <Input
              aria-label={`第 ${n} 步第 ${at2 + 1} 个分支的条件`}
              className="font-mono"
              placeholder='例如 inputs.topic == "周报"'
              value={branch.when}
              onChange={(event) =>
                props.onChange({
                  ...step,
                  branches: step.branches.map((row, k) =>
                    k === at2 ? { ...row, when: event.target.value } : row,
                  ),
                })
              }
            />
            <FieldError message={at(`branches.${at2}.label`)} />
            <FieldError message={at(`branches.${at2}.when`)} />
            <FieldError message={at(`branches.${at2}.next`)} />
          </div>
        ))}
        <FieldError message={at("branches")} />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={step.branches.length >= WAKERFLOW_MAX_BRANCHES}
            size="sm"
            variant="outline"
            onClick={() =>
              props.onChange({
                ...step,
                branches: [
                  ...step.branches,
                  {
                    label: `分支${step.branches.length + 1}`,
                    when: "",
                    next: step.otherwise,
                  },
                ],
              })
            }
          >
            添加分支
          </Button>
          <div className="flex items-center gap-2 text-sm">
            都不满足时
            <JumpSelect
              allowDefault={false}
              index={index}
              label={`第 ${n} 步都不满足时`}
              onChange={(next) =>
                props.onChange({ ...step, otherwise: next ?? WAKERFLOW_END })
              }
              steps={plan.steps}
              value={step.otherwise}
            />
          </div>
        </div>
        <FieldError message={at("otherwise")} />
      </>
    );
  } else if (step.kind === "flow") {
    fields = (
      <NestedFlowFields
        index={index}
        offered={offered}
        onChange={props.onChange}
        problems={problems}
        selfFlowId={props.selfFlowId}
        step={step}
        steps={plan.steps}
      />
    );
  } else if (step.kind === "action") {
    const args = Object.entries(step.args);
    fields = (
      <>
        <div className="flex flex-wrap items-center gap-2">
          {agentSelect(step.agentId, (agentId) =>
            props.onChange({ ...step, agentId }),
          )}
          <Input
            aria-label={`第 ${n} 步调用的工具`}
            className="w-64 font-mono"
            placeholder="服务/工具名，例如 crm/create_note"
            value={step.tool}
            onChange={(event) =>
              props.onChange({ ...step, tool: event.target.value.trim() })
            }
          />
        </div>
        <p className="text-muted-foreground text-xs">
          只能调用已授权给这位员工的 MCP
          工具；不经过模型，按下面的参数调用一次。参数里写
          {"{{名称}}"} 会换成勾选的输入或前面步骤的输出。
        </p>
        <FieldError message={at("agentId")} />
        <FieldError message={at("tool")} />
        <ReadKeys
          index={index}
          offered={offered}
          value={step.inputKeys}
          onChange={(inputKeys) => props.onChange({ ...step, inputKeys })}
        />
        <FieldError message={at("inputKeys")} />
        {args.map(([name, value], k) => (
          <div
            className="flex flex-wrap items-center gap-2"
            // biome-ignore lint/suspicious/noArrayIndexKey: the name itself is what is being edited
            key={k}
          >
            <Input
              aria-label={`第 ${n} 步第 ${k + 1} 个参数名`}
              className="w-36 font-mono"
              value={name}
              onChange={(event) =>
                props.onChange({
                  ...step,
                  args: Object.fromEntries(
                    args.map(([key, text], j) =>
                      j === k ? [event.target.value, text] : [key, text],
                    ),
                  ),
                })
              }
            />
            <Input
              aria-label={`第 ${n} 步参数 ${name} 的值`}
              className="w-64"
              value={value}
              onChange={(event) =>
                props.onChange({
                  ...step,
                  args: { ...step.args, [name]: event.target.value },
                })
              }
            />
            <Button
              aria-label={`删除第 ${n} 步参数 ${name}`}
              size="sm"
              variant="outline"
              onClick={() => {
                const { [name]: _gone, ...rest } = step.args;
                props.onChange({ ...step, args: rest });
              }}
            >
              删除
            </Button>
          </div>
        ))}
        <FieldError message={at("args")} />
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              let k = args.length + 1;
              while (`arg_${k}` in step.args) k += 1;
              props.onChange({
                ...step,
                args: { ...step.args, [`arg_${k}`]: "" },
              });
            }}
          >
            添加参数
          </Button>
        </div>
        {outputField(step.outputKey, (outputKey) =>
          props.onChange({ ...step, outputKey }),
        )}
        {nextField(step.next)}
      </>
    );
  } else if (step.kind === "confirm") {
    fields = (
      <>
        <Textarea
          aria-label={`第 ${n} 步要确认的问题`}
          placeholder="例如：草稿如下，可以发布吗？{{draft}}"
          value={step.question}
          onChange={(event) =>
            props.onChange({ ...step, question: event.target.value })
          }
        />
        <p className="text-muted-foreground text-xs">
          运行到这一步会停下来问你，不经过员工和模型。你的回答就是这一步的产出，后面的步骤会读到它；也可以跳过，后面的步骤会看到它没有产出。问题里写
          {"{{名称}}"} 会换成勾选的输入或前面步骤的输出。
        </p>
        <FieldError message={at("question")} />
        <ReadKeys
          index={index}
          offered={offered}
          value={step.inputKeys}
          onChange={(inputKeys) => props.onChange({ ...step, inputKeys })}
        />
        <FieldError message={at("inputKeys")} />
        {outputField(step.outputKey, (outputKey) =>
          props.onChange({ ...step, outputKey }),
        )}
        {nextField(step.next)}
      </>
    );
  } else {
    const worker = step;
    fields = (
      <>
        {agentSelect(worker.agentId, (agentId) =>
          props.onChange({ ...worker, agentId }),
        )}
        <FieldError message={at("agentId")} />
        <Textarea
          aria-label={`第 ${n} 步要做什么`}
          value={worker.instruction}
          onChange={(event) =>
            props.onChange({ ...worker, instruction: event.target.value })
          }
        />
        <FieldError message={at("instruction")} />
        <ReadKeys
          index={index}
          offered={offered}
          value={worker.inputKeys}
          onChange={(inputKeys) => props.onChange({ ...worker, inputKeys })}
        />
        <FieldError message={at("inputKeys")} />
        {outputField(worker.outputKey, (outputKey) =>
          props.onChange({ ...worker, outputKey }),
        )}
        {nextField(worker.next)}
      </>
    );
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a click marks the step's node; every control inside is reachable by keyboard
    <div
      className={`flex flex-col gap-2 rounded-lg border p-3 ${
        props.selected ? "border-ring ring-1 ring-ring" : "border-border"
      }`}
      data-selected={props.selected}
      id={`step-form-${step.id}`}
      onClick={props.onSelect}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-sm">第 {n} 步</span>
        <select
          aria-label={`第 ${n} 步的类型`}
          className={selectClass}
          value={kind}
          onChange={(event) => {
            const next = event.target.value as WakerFlowStepKind;
            if (next === kind) return;
            props.onChange(
              stepOfKind(
                next,
                step.id,
                stepAgentId(step) ?? plan.members[0]?.agentId ?? "",
                plan.steps[index + 1]?.id,
              ),
            );
          }}
        >
          {WAKERFLOW_STEP_KINDS.map((option) => (
            <option key={option} value={option}>
              {STEP_KIND_LABEL[option]}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" onClick={props.onRemove}>
          删除这步
        </Button>
      </div>
      <FieldError message={at("kind")} />
      {fields}
      <FieldError message={at("id")} />
      <FieldError message={problems[`steps.${index}`]} />
    </div>
  );
}

/**
 * A nested Flow's fields (WF7, spec §3.4): which saved Flow, at the revision chosen (D5), which of
 * this plan's keys fill its inputs, and which of its outputs this step produces. A newer saved
 * version of the child is pointed out, and only a person updates the step to it.
 */
function NestedFlowFields(props: {
  index: number;
  step: Extract<Step, { kind: "flow" }>;
  steps: Step[];
  offered: string[];
  problems: Record<string, string>;
  selfFlowId: string;
  onChange: (step: Step) => void;
}) {
  const { index, step, steps, offered, onChange, selfFlowId } = props;
  const n = index + 1;
  const at = (field: string) => props.problems[`steps.${index}.${field}`];
  const flows = useQuery(wakerFlowsQueryOptions());
  const candidates = (flows.data ?? []).filter(
    (flow) => flow.id !== selfFlowId && flow.status === "ready" && flow.plan,
  );
  const child = (flows.data ?? []).find(
    (flow) => flow.id === step.targetFlowId,
  );
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`第 ${n} 步的子流程`}
          className={selectClass}
          value={step.targetFlowId}
          onChange={(event) => {
            const picked = candidates.find(
              (flow) => flow.id === event.target.value,
            );
            onChange({
              ...step,
              targetFlowId: event.target.value,
              // D5: the version saved now is the one that runs, until a person updates it.
              targetRevision: picked?.revision ?? 1,
              inputMap: {},
              resultKey: undefined,
            });
          }}
        >
          <option value="">选择子流程</option>
          {candidates.map((flow) => (
            <option key={flow.id} value={flow.id}>
              {flow.name}
            </option>
          ))}
          {step.targetFlowId && !child ? (
            <option value={step.targetFlowId}>不可用的子流程</option>
          ) : null}
        </select>
        {step.targetFlowId ? (
          <span className="text-muted-foreground text-xs">
            固定在第 {step.targetRevision} 版
          </span>
        ) : null}
        {child ? (
          <a
            className="text-xs underline"
            href={`/wakerflows/${encodeURIComponent(child.id)}`}
          >
            打开子流程
          </a>
        ) : null}
      </div>
      {child && child.revision > step.targetRevision ? (
        <div className="flex flex-wrap items-center gap-2" role="status">
          <span className="text-xs">
            子流程有新版本（第 {child.revision} 版），这一步仍按第{" "}
            {step.targetRevision} 版运行。
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onChange({ ...step, targetRevision: child.revision })
            }
          >
            更新到第 {child.revision} 版
          </Button>
        </div>
      ) : null}
      <FieldError message={at("targetFlowId")} />
      {child?.plan
        ? child.plan.inputs.map((input) => (
            <label
              className="flex flex-wrap items-center gap-2 text-sm"
              key={input.key}
            >
              子流程输入「{input.label}」取自
              <select
                aria-label={`第 ${n} 步子流程输入 ${input.key}`}
                className={selectClass}
                value={step.inputMap[input.key] ?? ""}
                onChange={(event) => {
                  const { [input.key]: _old, ...rest } = step.inputMap;
                  onChange({
                    ...step,
                    inputMap: event.target.value
                      ? { ...rest, [input.key]: event.target.value }
                      : rest,
                  });
                }}
              >
                <option value="">不传</option>
                {offered.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            </label>
          ))
        : null}
      <FieldError message={at("inputMap")} />
      <Input
        aria-label={`第 ${n} 步的输出名称`}
        className="w-48"
        placeholder="例如 summary"
        value={step.outputKey}
        onChange={(event) =>
          onChange({ ...step, outputKey: event.target.value })
        }
      />
      <FieldError message={at("outputKey")} />
      {child?.plan ? (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          输出取子流程的
          <select
            aria-label={`第 ${n} 步取子流程的哪个产出`}
            className={selectClass}
            value={step.resultKey ?? ""}
            onChange={(event) =>
              onChange({
                ...step,
                resultKey: event.target.value || undefined,
              })
            }
          >
            <option value="">最后完成的一步的产出</option>
            {child.plan.steps
              .map((childStep) => stepOutputKey(childStep))
              .filter((key): key is string => Boolean(key))
              .map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        完成后
        <JumpSelect
          allowDefault
          index={index}
          label={`第 ${n} 步完成后`}
          onChange={(next) => {
            const { next: _old, ...rest } = step;
            onChange(next === undefined ? rest : { ...rest, next });
          }}
          steps={steps}
          value={step.next}
        />
        <FieldError message={at("next")} />
      </div>
    </>
  );
}
