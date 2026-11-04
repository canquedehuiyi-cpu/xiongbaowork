import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { WakerFlowInput } from "@/lib/wakerflows";

const selectClass =
  "border-input bg-background rounded-md border px-2 py-1 text-sm";

/**
 * The inputs of one WakerFlow as a form (WF8), shared by the run panel and the automation form.
 *
 * Each input is entered the way its type says: one line, several lines, a number, one of its options,
 * or a switch. Every value is still a string (`"true"`/`"false"` for a switch), and the form that
 * holds the values is the one that checks and sends them. The label reads 「<label>（必填）」 or
 * 「<label>（选填）」, and the input's description, when it has one, is shown below it.
 */
export function FlowInputFields(props: {
  inputs: WakerFlowInput[];
  values: Record<string, string>;
  problems: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Keeps element ids unique when two forms are on one page. */
  idPrefix: string;
}) {
  const { inputs, values, problems, onChange, idPrefix } = props;
  return (
    <>
      {inputs.map((input) => {
        const id = `${idPrefix}-${input.key}`;
        const hint = input.description ? `${id}-hint` : undefined;
        const value = values[input.key] ?? "";
        const common = {
          id,
          "aria-invalid": problems[input.key] ? true : undefined,
          "aria-required": input.required,
          "aria-describedby": hint,
        } as const;
        const label = `${input.label}${input.required ? "（必填）" : "（选填）"}`;
        let control: React.ReactNode;
        switch (input.type ?? "text") {
          case "textarea":
            control = (
              <Textarea
                {...common}
                onChange={(event) => onChange(input.key, event.target.value)}
                rows={4}
                value={value}
              />
            );
            break;
          case "number":
            control = (
              <Input
                {...common}
                inputMode="decimal"
                onChange={(event) => onChange(input.key, event.target.value)}
                type="number"
                value={value}
              />
            );
            break;
          case "select":
            control = (
              <select
                {...common}
                className={selectClass}
                onChange={(event) => onChange(input.key, event.target.value)}
                value={value}
              >
                <option value="">请选择</option>
                {(input.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            );
            break;
          case "boolean":
            control = (
              <span className="flex items-center gap-2 text-sm">
                <input
                  {...common}
                  aria-checked={value === "true"}
                  checked={value === "true"}
                  onChange={(event) =>
                    onChange(input.key, event.target.checked ? "true" : "false")
                  }
                  role="switch"
                  type="checkbox"
                />
                {value === "true" ? "是" : "否"}
              </span>
            );
            break;
          default:
            control = (
              <Textarea
                {...common}
                onChange={(event) => onChange(input.key, event.target.value)}
                rows={2}
                value={value}
              />
            );
        }
        return (
          <div className="flex flex-col gap-1" key={input.key}>
            <label className="font-medium text-sm" htmlFor={id}>
              {label}
            </label>
            {control}
            {input.description ? (
              <p className="text-muted-foreground text-xs" id={hint}>
                {input.description}
              </p>
            ) : null}
            {problems[input.key] ? (
              <p className="text-destructive text-xs" role="alert">
                {problems[input.key]}
              </p>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
