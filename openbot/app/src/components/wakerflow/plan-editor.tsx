import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RequestError } from "@/lib/client";
import {
  planProblems,
  saveWakerFlow,
  WAKERFLOW_CONFLICT_MESSAGE,
  type WakerFlow,
  type WakerFlowPlan,
} from "@/lib/wakerflows";

type Step = WakerFlowPlan["steps"][number];

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

  const names = new Map(props.coworkers.map((agent) => [agent.id, agent.name]));
  const memberName = (agentId: string) =>
    names.get(agentId) ??
    plan.members.find((member) => member.agentId === agentId)?.role ??
    agentId;

  function edit(next: WakerFlowPlan) {
    setPlan(next);
    setSaved(false);
    // Once a Save was refused, the inline messages follow the edits so a fixed field clears.
    if (Object.keys(problems).length > 0) setProblems(planProblems(next));
  }
  const setStep = (index: number, patch: Partial<Step>) =>
    edit({
      ...plan,
      steps: plan.steps.map((step, at) =>
        at === index ? { ...step, ...patch } : step,
      ),
    });

  async function save() {
    const found = planProblems(plan);
    setProblems(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try {
      const flow = await saveWakerFlow(props.flowId, {
        revision: props.revision,
        plan,
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
            <FieldError message={problems[`members.${index}.agentId`]} />
            <FieldError message={problems[`members.${index}.role`]} />
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
        {plan.steps.map((step, index) => {
          // What this step may read: the declared inputs, then every earlier step's output.
          const offered = [
            ...plan.inputs.map((input) => input.key),
            ...plan.steps.slice(0, index).map((earlier) => earlier.outputKey),
          ].filter((key, at, all) => key && all.indexOf(key) === at);
          // A reference that is no longer on offer stays visible so it can be removed.
          const stale = step.inputKeys.filter((key) => !offered.includes(key));
          return (
            <div
              className="flex flex-col gap-2 rounded-lg border border-border p-3"
              key={step.id}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground text-sm">
                  第 {index + 1} 步
                </span>
                <select
                  aria-label={`第 ${index + 1} 步的员工`}
                  className={selectClass}
                  value={step.agentId}
                  onChange={(event) =>
                    setStep(index, { agentId: event.target.value })
                  }
                >
                  <option value="">选择员工</option>
                  {plan.members
                    .filter((member) => member.agentId)
                    .map((member) => (
                      <option key={member.agentId} value={member.agentId}>
                        {memberName(member.agentId)}
                      </option>
                    ))}
                  {step.agentId &&
                  !plan.members.some(
                    (member) => member.agentId === step.agentId,
                  ) ? (
                    <option value={step.agentId}>不在计划中的员工</option>
                  ) : null}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    edit({
                      ...plan,
                      steps: plan.steps.filter((_, at) => at !== index),
                    })
                  }
                >
                  删除这步
                </Button>
              </div>
              <FieldError message={problems[`steps.${index}.agentId`]} />
              <Textarea
                aria-label={`第 ${index + 1} 步要做什么`}
                value={step.instruction}
                onChange={(event) =>
                  setStep(index, { instruction: event.target.value })
                }
              />
              <FieldError message={problems[`steps.${index}.instruction`]} />
              <fieldset className="flex flex-wrap items-center gap-3">
                <legend className="text-muted-foreground text-xs">
                  这一步读取
                </legend>
                {offered.length === 0 && stale.length === 0 ? (
                  <span className="text-muted-foreground text-xs">
                    没有可读取的输入或前面步骤的输出。
                  </span>
                ) : null}
                {[...offered, ...stale].map((key) => (
                  <label
                    className={
                      stale.includes(key)
                        ? "flex items-center gap-1 text-destructive text-sm"
                        : "flex items-center gap-1 text-sm"
                    }
                    key={key}
                  >
                    <input
                      aria-label={`第 ${index + 1} 步读取 ${key}`}
                      checked={step.inputKeys.includes(key)}
                      type="checkbox"
                      onChange={(event) =>
                        setStep(index, {
                          inputKeys: event.target.checked
                            ? [...step.inputKeys, key]
                            : step.inputKeys.filter((entry) => entry !== key),
                        })
                      }
                    />
                    {key}
                  </label>
                ))}
              </fieldset>
              <FieldError message={problems[`steps.${index}.inputKeys`]} />
              <Input
                aria-label={`第 ${index + 1} 步的输出名称`}
                className="w-48"
                placeholder="例如 agenda"
                value={step.outputKey}
                onChange={(event) =>
                  setStep(index, { outputKey: event.target.value })
                }
              />
              <FieldError message={problems[`steps.${index}.outputKey`]} />
              <FieldError message={problems[`steps.${index}.id`]} />
            </div>
          );
        })}
        <FieldError message={problems.steps} />
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              edit({
                ...plan,
                steps: [
                  ...plan.steps,
                  {
                    id: nextStepId(plan.steps),
                    agentId: plan.members[0]?.agentId ?? "",
                    instruction: "",
                    inputKeys: [],
                    outputKey: "",
                  },
                ],
              })
            }
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
