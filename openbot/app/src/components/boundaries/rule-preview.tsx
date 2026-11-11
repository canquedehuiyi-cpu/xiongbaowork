import type { UseQueryResult } from "@tanstack/react-query";
import { DryRunChanges } from "@/components/boundaries/dry-run-changes";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import type { DryRunReport } from "@/lib/computers/queries";

/**
 * What the rule would have stopped, worked out as it is written: a Bot's computer actions and its
 * app calls, in one list. A rule that can't be evaluated says why here, under the rule, and nothing
 * is replayed. The first answer arrives into an empty space, with no placeholder before it.
 *
 * Shared by Add rule and a rule's own page, which both replay the rule in the editor on its own.
 */
export function RulePreview({
  preview,
}: {
  preview: UseQueryResult<DryRunReport>;
}) {
  if (preview.isPending) return null;
  return (
    <Field aria-labelledby="rule-preview" aria-live="polite">
      <FieldLabel id="rule-preview">拿最近的动作试一试</FieldLabel>
      {preview.error ? (
        <p className="text-destructive text-sm" role="alert">
          {preview.error.message}
        </p>
      ) : preview.data.scanned === 0 ? (
        <FieldDescription>
          还没有记录到可以拿来测试的动作。员工开始干活后，就能看到这条规则会拦下什么。
        </FieldDescription>
      ) : (
        <div>
          <FieldDescription>
            {preview.data.wouldRefuse === 0
              ? `最近记录的 ${preview.data.scanned} 个动作里，这条规则一个也不会拦。以后的动作它仍可能拦下。`
              : `最近记录的 ${preview.data.scanned} 个动作里，这条规则会拦下 ${preview.data.wouldRefuse} 个。`}
          </FieldDescription>
          <DryRunChanges
            changes={preview.data.changes.filter(
              (change) => change.would === "refused",
            )}
            total={preview.data.wouldRefuse}
            verdict="会拦下"
          />
        </div>
      )}
    </Field>
  );
}
