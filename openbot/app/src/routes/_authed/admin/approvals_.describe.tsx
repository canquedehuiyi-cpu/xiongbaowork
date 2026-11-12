import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  RuleRowsEditor,
  RulesBacktest,
} from "@/components/approvals/describe-rules";
import { DescribeField } from "@/components/boundaries/describe-rule";
import { ReadingStatus } from "@/components/boundaries/rule-reading";
import { PageCard, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { saveTeamRulesMutationOptions } from "@/lib/approval-rules/mutations";
import { approvalRulesBacktestQueryOptions } from "@/lib/approval-rules/queries";
import {
  type ApprovalRuleTranslation,
  translateApprovalRules,
} from "@/lib/approval-rules/translate";
import type { ApprovalRuleInput } from "@/lib/approvals";
import { shortName } from "@/lib/brand";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/approvals_/describe")({
  component: DescribeTeamRulesPage,
});

const BACK = {
  label: "审批",
  linkProps: { to: "/admin/approvals" as const },
};

/** How long the rules rest before they are replayed, so typing is not a request per keystroke. */
const PREVIEW_DELAY_MS = 400;

/** What came back for one description, kept beside the words it came from. */
type WrittenRules = ApprovalRuleTranslation & { text: string };

const same = (
  a: readonly ApprovalRuleInput[],
  b: readonly ApprovalRuleInput[],
) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Team approval rules described in words, as a boundary is on Add rule.
 *
 * The model's rules land as fields the admin can change, beside an independent reading of them and
 * whether they check. What they would have changed is replayed over the approval gate's own history
 * as they are edited: the asks they would remove, and which of those a person had denied, and the
 * asks they would add. Only Save adds them, with the sentence they were written from.
 */
function DescribeTeamRulesPage() {
  const navigate = Route.useNavigate();
  const save = useMutation(saveTeamRulesMutationOptions(queryClient));
  const [written, setWritten] = useState<WrittenRules | null>(null);
  const [rules, setRules] = useState<ApprovalRuleInput[]>([]);

  /* The rules as they stood a moment ago, debounced as Add rule's preview is. */
  const [settled, setSettled] = useState<ApprovalRuleInput[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(rules), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [rules]);

  const preview = useQuery({
    ...approvalRulesBacktestQueryOptions(settled),
    enabled: settled.length > 0,
    // The last answer stays up while the next loads, so the list does not blink between edits.
    placeholderData: keepPreviousData,
  });
  /* The check of the rules on screen now, and not of the ones before an edit still being replayed. */
  const current =
    preview.data && !preview.isPlaceholderData && same(settled, rules)
      ? preview.data
      : null;
  const ready = Boolean(current?.check.ok) && rules.length > 0;
  const edited = written !== null && !same(rules, written.rules);

  const add = () => {
    if (!ready) return;
    save.mutate(
      {
        rules,
        ...(written
          ? { authoring: { source: "english" as const, text: written.text } }
          : {}),
      },
      { onSuccess: () => void navigate({ to: "/admin/approvals" }) },
    );
  };

  return (
    <PageShell
      backButton={BACK}
      description="说出员工在动手之前该怎么做，由你的模型写成团队规则。保存之前什么都不会改变。"
      title="用一句话描述团队规则"
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <PageCard
          footer={
            <>
              <Button
                render={(props) => <Link {...props} to="/admin/approvals" />}
                variant="outline"
              >
                取消
              </Button>
              <Button disabled={!ready || save.isPending} type="submit">
                {save.isPending ? "正在保存…" : "保存规则"}
              </Button>
            </>
          }
        >
          <FieldGroup>
            <DescribeField
              action="写成规则"
              description="用一句话说出员工该怎么做，由你的模型按这个部署的应用和员工写成规则。另一次从没见过你原话的解读会说明这些规则做什么。"
              id="team-rules-english"
              label="描述这些规则"
              placeholder="任何员工用 Gmail 发邮件之前都先问"
              write={async (described) => {
                const translation = await translateApprovalRules(described);
                save.reset();
                setWritten({ ...translation, text: described });
                setRules(translation.rules);
                return null;
              }}
            />
            {written ? (
              <ReadingStatus
                check={written.check}
                edited={
                  edited
                    ? "写好之后你改过这些规则。上面的检查和解读说的是写出来的规则，不是你改过的版本。"
                    : null
                }
                explanation={written.explanation}
                failed={
                  // No rules says so itself, with the model's reason.
                  written.rules.length === 0
                    ? ""
                    : `这些规则没通过检查，${shortName()}不会保存。`
                }
                heading="这些规则做什么"
                passed="通过检查。每条规则都对得上这个部署里的工具和员工。"
                warning={written.warning}
              />
            ) : null}
            {written && (rules.length > 0 || written.rules.length > 0) ? (
              <RuleRowsEditor
                onChange={setRules}
                problems={
                  current && !current.check.ok ? current.check.problems : []
                }
                rules={rules}
              />
            ) : null}
            {current &&
            !current.check.ok &&
            current.check.problems.length === 0 ? (
              <p className="text-destructive text-sm">{current.check.error}</p>
            ) : null}
            {rules.length > 0 && settled.length > 0 ? (
              <RulesBacktest
                asksMore={rules.some((rule) => rule.behaviour !== "allow")}
                preview={preview}
              />
            ) : null}
          </FieldGroup>
          {save.error ? (
            <p className="mt-5 text-destructive text-sm" role="alert">
              {save.error.message}
            </p>
          ) : null}
        </PageCard>
      </form>
    </PageShell>
  );
}
