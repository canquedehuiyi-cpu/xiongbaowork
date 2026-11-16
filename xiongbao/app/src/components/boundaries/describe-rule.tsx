import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { isComposing } from "@/lib/composing";
import {
  type PolicyTranslation,
  translatePolicyRule,
} from "@/lib/computers/policy-translate";

/** What came back for one description, kept beside the words it came from. */
export type WrittenRule = PolicyTranslation & { text: string };

/**
 * A sentence in, and a button that hands it to the deployment's model: the field a boundary and a
 * team approval rule are both described in.
 *
 * `write` does the asking and answers with a sentence to show under the field when the answer can't
 * be used, or null when it was handed on. A failure it throws is shown the same way, in its message.
 * Enter writes; it never reaches a form around the field, whose Enter saves.
 */
export function DescribeField({
  id,
  label,
  description,
  placeholder,
  action,
  write,
}: {
  id: string;
  label: string;
  description: string;
  placeholder: string;
  /** The button: "Write rule". It reads "Writing…" while the model answers. */
  action: string;
  write: (text: string) => Promise<string | null>;
}) {
  const [text, setText] = useState("");
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const described = text.trim();

  const ask = async () => {
    if (!described || writing) return;
    setProblem(null);
    setWriting(true);
    try {
      setProblem(await write(described));
    } catch (thrown) {
      setProblem((thrown as Error).message);
    } finally {
      setWriting(false);
    }
  };

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <FieldDescription>{description}</FieldDescription>
      <Textarea
        className="min-h-10"
        id={id}
        maxLength={1000}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter writes the rule. It must never reach the form around it, whose Enter saves.
          if (event.key !== "Enter" || event.shiftKey || isComposing(event))
            return;
          event.preventDefault();
          event.stopPropagation();
          void ask();
        }}
        placeholder={placeholder}
        rows={2}
        value={text}
      />
      <div>
        <Button
          disabled={!described || writing}
          onClick={() => void ask()}
          size="sm"
          type="button"
          variant="outline"
        >
          {writing ? "正在写…" : action}
        </Button>
      </div>
      {problem ? (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
    </Field>
  );
}

/**
 * "Describe the rule": a sentence in, a rule out, written by the deployment's own model.
 *
 * It fills nothing in by itself. `onWritten` hands the rule to the screen, which puts it in the CEL
 * field where the admin reads it, edits it if they want, and saves it themselves. A description that
 * only grants permission comes back as an allow rule, which these screens cannot add, so it is
 * answered here and never handed on.
 */
export function DescribeRule({
  onWritten,
}: {
  onWritten: (written: WrittenRule) => void;
}) {
  return (
    <DescribeField
      action="写成规则"
      description="用一句话说出哪件事员工都不能做，由你的模型写成规则。另一次从没见过你原话的解读会说明这条规则做什么。"
      id="rule-description-english"
      label="描述这条规则"
      placeholder="员工不能访问社交媒体网站"
      write={async (described) => {
        const translation = await translatePolicyRule(described);
        if (translation.effect === "allow")
          return "这句话说的是员工可以做什么。这里的规则用来拦下动作，请描述哪件事员工都不能做。";
        onWritten({ ...translation, text: described });
        return null;
      }}
    />
  );
}
