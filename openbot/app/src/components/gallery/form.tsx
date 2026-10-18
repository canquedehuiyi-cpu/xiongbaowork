import { useCallback, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { Badge, GalleryFrame } from "./frame";

const Field = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/)
      .describe("Unique key returned with the answer"),
    label: z.string().trim().min(1).max(100),
    type: z.enum(["text", "email", "number", "select", "textarea"]),
    required: z.boolean().optional(),
    help: z.string().max(250).optional(),
    options: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(20)
      .optional()
      .describe("Required for select fields"),
    min: z.number().optional().describe("Minimum for a number field"),
    max: z.number().optional().describe("Maximum for a number field"),
  })
  .refine(
    (field) =>
      (field.type !== "select" || Boolean(field.options?.length)) &&
      (!field.options ||
        new Set(field.options).size === field.options.length) &&
      (field.min === undefined ||
        field.max === undefined ||
        field.min <= field.max),
    "Select fields need unique options; minimum must not exceed maximum",
  );

export const FormCardArgs = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().max(500).optional(),
    fields: z.array(Field).min(1).max(8),
    submitLabel: z.string().trim().min(1).max(40).optional(),
  })
  .refine(
    (form) =>
      new Set(form.fields.map((field) => field.id)).size === form.fields.length,
    "Field IDs must be unique",
  );

const Submitted = z.object({
  status: z.literal("submitted"),
  values: z.record(z.string(), z.union([z.string(), z.number()])),
});
type FormArgs = z.infer<typeof FormCardArgs>;
type FormAnswer = z.infer<typeof Submitted>;
type Respond = (
  answer: FormAnswer | { status: "invalid"; message: string },
) => Promise<void>;

function isRespond(value: unknown): value is Respond {
  return typeof value === "function";
}
function readAnswer(result: unknown): FormAnswer | null {
  try {
    const parsed = Submitted.safeParse(
      typeof result === "string" ? JSON.parse(result) : result,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Decision render props remain wrapped, just like askApproval and askChoice. */
export function FormCard(props: Record<string, unknown>) {
  const parsed = FormCardArgs.safeParse(props.args);
  if (props.status === "inProgress") {
    return (
      <GalleryFrame title="正在准备表单…">
        <p className="text-sm text-muted-foreground">员工正在整理问题。</p>
      </GalleryFrame>
    );
  }
  if (!parsed.success) {
    return (
      <InvalidForm
        complete={props.status === "complete"}
        respond={isRespond(props.respond) ? props.respond : undefined}
      />
    );
  }
  return (
    <FormEntry
      args={parsed.data}
      complete={props.status === "complete"}
      result={readAnswer(props.result)}
      respond={isRespond(props.respond) ? props.respond : undefined}
    />
  );
}

/** A malformed tool call must release the suspended run so the Bot can repair its questions. */
function InvalidForm({
  complete,
  respond,
}: {
  complete: boolean;
  respond?: Respond;
}) {
  const attempted = useRef(false);
  const [failed, setFailed] = useState(false);
  const [returned, setReturned] = useState(complete);
  const returnToBot = useCallback(async () => {
    if (!respond || attempted.current || complete) return;
    attempted.current = true;
    setFailed(false);
    try {
      await respond({
        status: "invalid",
        message:
          "The form could not be displayed because its questions were invalid. Send a corrected form with unique field IDs, valid types, and options for each select field.",
      });
      setReturned(true);
    } catch {
      attempted.current = false;
      setFailed(true);
    }
  }, [respond, complete]);
  useEffect(() => {
    void returnToBot();
  }, [returnToBot]);
  return (
    <GalleryFrame title="表单不可用">
      <p role="alert" className="text-sm text-muted-foreground">
        {returned
          ? "表单里有无效的问题。员工可以重新发一份改好的表单。"
          : "表单里有无效的问题，没法显示。"}
      </p>
      {failed && (
        <Button className="mt-3" size="sm" onClick={() => void returnToBot()}>
          返回员工
        </Button>
      )}
    </GalleryFrame>
  );
}

function FormEntry({
  args,
  complete,
  result,
  respond,
}: {
  args: FormArgs;
  complete: boolean;
  result: FormAnswer | null;
  respond?: Respond;
}) {
  const prefix = useId();
  const [values, setValues] = useState(new Map<string, string>());
  const [errors, setErrors] = useState(new Map<string, string>());
  const [failure, setFailure] = useState(false);
  const [sending, setSending] = useState(false);
  const [submitted, setSubmitted] = useState<FormAnswer | null>(null);
  const sendingRef = useRef(false);
  const answer = result ?? submitted;
  const finished = complete || answer !== null;

  async function submit(form: HTMLFormElement) {
    if (!respond || sendingRef.current || finished) return;
    const problems = new Map<string, string>();
    const entries: [string, string | number][] = [];
    for (const field of args.fields) {
      const control = form.elements.namedItem(field.id);
      if (control instanceof HTMLInputElement && control.validity.badInput) {
        problems.set(field.id, "请输入有效的数字。");
        continue;
      }
      const value = (values.get(field.id) ?? "").trim();
      if (!value) {
        if (field.required) problems.set(field.id, `${field.label}为必填项。`);
        continue;
      }
      if (value.length > 2000) problems.set(field.id, "请不要超过 2000 字。");
      else if (field.type === "email" && !z.email().safeParse(value).success)
        problems.set(field.id, "请输入有效的邮箱地址。");
      else if (field.type === "select" && !field.options?.includes(value))
        problems.set(field.id, "请从列出的选项里选一个。");
      else if (field.type === "number") {
        const number = Number(value);
        if (!Number.isFinite(number))
          problems.set(field.id, "请输入有效的数字。");
        else if (field.min !== undefined && number < field.min)
          problems.set(field.id, `请输入不小于 ${field.min} 的数。`);
        else if (field.max !== undefined && number > field.max)
          problems.set(field.id, `请输入不大于 ${field.max} 的数。`);
      }
      entries.push([field.id, field.type === "number" ? Number(value) : value]);
    }
    setErrors(problems);
    if (problems.size) {
      const firstId = problems.keys().next().value;
      const control = firstId ? form.elements.namedItem(firstId) : null;
      if (control instanceof HTMLElement) control.focus();
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setFailure(false);
    const response: FormAnswer = {
      status: "submitted",
      values: Object.fromEntries(entries),
    };
    try {
      await respond(response);
      setSubmitted(response);
    } catch {
      sendingRef.current = false;
      setFailure(true);
    } finally {
      setSending(false);
    }
  }

  return (
    <GalleryFrame
      title={args.title}
      caption={args.description}
      action={
        <Badge tone={finished ? "positive" : "caution"}>
          {finished ? "已提交" : "等你填写"}
        </Badge>
      }
    >
      {finished ? (
        <div role="status">
          {answer ? (
            <dl className="space-y-3">
              {args.fields.map((field) => (
                <div
                  key={field.id}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 text-sm"
                >
                  <dt className="text-muted-foreground">{field.label}</dt>
                  <dd className="whitespace-pre-wrap break-words font-medium">
                    {Object.hasOwn(answer.values, field.id)
                      ? answer.values[field.id]
                      : "未填写"}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              这份表单已经填完了，但保存的回答读不到。
            </p>
          )}
        </div>
      ) : (
        <form
          noValidate
          aria-label={args.title}
          onSubmit={(event) => {
            event.preventDefault();
            void submit(event.currentTarget);
          }}
          className="space-y-4"
        >
          <p className="text-xs text-muted-foreground">
            带 * 的为必填项。你的回答会交给员工。
          </p>
          {args.fields.map((field) => {
            const id = `${prefix}-${field.id}`;
            const error = errors.get(field.id);
            const shared = {
              id,
              name: field.id,
              required: field.required,
              disabled: sending || !respond,
              value: values.get(field.id) ?? "",
              "aria-invalid": Boolean(error),
              "aria-describedby":
                [field.help ? `${id}-help` : "", error ? `${id}-error` : ""]
                  .filter(Boolean)
                  .join(" ") || undefined,
            };
            const change = (value: string) => {
              setValues((current) => new Map(current).set(field.id, value));
              setErrors((current) => {
                const next = new Map(current);
                next.delete(field.id);
                return next;
              });
            };
            return (
              <div key={field.id} className="space-y-1.5">
                <label htmlFor={id} className="block text-sm font-medium">
                  {field.label}
                  {field.required ? (
                    <span
                      aria-hidden="true"
                      className="ml-1 text-muted-foreground"
                    >
                      *
                    </span>
                  ) : null}
                </label>
                {field.type === "textarea" ? (
                  <Textarea
                    {...shared}
                    maxLength={2000}
                    rows={3}
                    onChange={(event) => change(event.target.value)}
                  />
                ) : field.type === "select" ? (
                  <select
                    {...shared}
                    className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
                    onChange={(event) => change(event.target.value)}
                  >
                    <option value="">选择一项</option>
                    {field.options?.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    {...shared}
                    type={field.type}
                    min={field.min}
                    max={field.max}
                    step={field.type === "number" ? "any" : undefined}
                    maxLength={2000}
                    onChange={(event) => change(event.target.value)}
                  />
                )}
                {field.help && (
                  <p
                    id={`${id}-help`}
                    className="text-xs text-muted-foreground"
                  >
                    {field.help}
                  </p>
                )}
                {error && (
                  <p
                    id={`${id}-error`}
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {error}
                  </p>
                )}
              </div>
            );
          })}
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              回答没能发送，请重试。
            </p>
          )}
          <div className="flex justify-end border-t border-border pt-3">
            <Button type="submit" size="sm" disabled={sending || !respond}>
              {sending ? "正在发送…" : (args.submitLabel ?? "提交回答")}
            </Button>
          </div>
        </form>
      )}
    </GalleryFrame>
  );
}

export const GALLERY: GalleryComponent[] = [
  {
    name: "askForm",
    title: "Form",
    kind: "decision",
    description:
      "Ask the person to fill in a short form and WAIT for their answers. Use when several related details are needed together. Provide up to eight labeled text, email, number, select, or textarea fields with unique IDs. Mark required fields and give options for selects. Never request passwords or secrets. The result has status submitted and values keyed by field ID; numbers are returned as numbers and blank optional fields are omitted.",
    parameters: FormCardArgs,
    Component: FormCard,
    preview: {
      status: "executing",
      args: {
        title: "规划你的下一个项目",
        description: "填几项信息，好准备一份有用的初稿。",
        fields: [
          { id: "team", label: "团队名称", type: "text", required: true },
          { id: "email", label: "工作邮箱", type: "email", required: true },
          {
            id: "priority",
            label: "优先级",
            type: "select",
            options: ["本周", "本月", "还在探索"],
          },
          { id: "seats", label: "参与人数", type: "number", min: 1 },
          {
            id: "notes",
            label: "理想的结果是什么样的？",
            type: "textarea",
          },
        ],
        submitLabel: "生成我的简报",
      },
      respond: async () => {},
    },
  },
];
