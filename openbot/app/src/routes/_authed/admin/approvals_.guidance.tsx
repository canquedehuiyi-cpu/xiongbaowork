import { IconShieldLock } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { GuidanceBacktestField } from "@/components/approvals/guidance-backtest";
import { ReadingStatus } from "@/components/boundaries/rule-reading";
import {
  PageCard,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
  backtestReviewerGuidance,
  checkReviewerGuidance,
  GUIDANCE_LIMIT,
  type GuidanceReading,
} from "@/lib/reviewer-guidance/check";
import {
  removeReviewerGuidanceMutationOptions,
  saveReviewerGuidanceMutationOptions,
} from "@/lib/reviewer-guidance/mutations";
import {
  guidanceBacktestPreviewQueryOptions,
  reviewerGuidanceQueryOptions,
} from "@/lib/reviewer-guidance/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/approvals_/guidance")({
  component: ReviewerGuidancePage,
});

const BACK = {
  label: "审批",
  linkProps: { to: "/admin/approvals" as const },
};

/**
 * Guidance for auto-review, in the admin's words, with the describe screen's pattern: write it, check
 * it, test it on recent decisions, then save it.
 *
 * Check hands the words to a call that sees nothing else, which says what they change and whether they
 * read as guidance at all. The replay costs one model call a request, so it runs only when the admin
 * presses for it, after being told how many. Save reads the words again on the server, and only
 * guidance that still reads as guidance is saved, on the trail, with the words.
 */
function ReviewerGuidancePage() {
  const navigate = Route.useNavigate();
  const saved = useQuery(reviewerGuidanceQueryOptions());
  const preview = useQuery(guidanceBacktestPreviewQueryOptions());
  const save = useMutation(saveReviewerGuidanceMutationOptions(queryClient));
  const remove = useMutation(
    removeReviewerGuidanceMutationOptions(queryClient),
  );
  const check = useMutation({ mutationFn: checkReviewerGuidance });
  const backtest = useMutation({ mutationFn: backtestReviewerGuidance });
  /* Null until the admin types, so the saved guidance shows once it has loaded. */
  const [draft, setDraft] = useState<string | null>(null);
  const [checked, setChecked] = useState<{
    text: string;
    reading: GuidanceReading;
  } | null>(null);

  const text = (draft ?? saved.data ?? "").trim();
  const passed =
    checked !== null && checked.text === text && checked.reading.check.ok;
  const unchanged = text === (saved.data ?? "");
  const ready = passed && !unchanged;
  const [removing, setRemoving] = useState(false);
  const back = () => void navigate({ to: "/admin/approvals" });

  const runCheck = () => {
    if (!text || check.isPending) return;
    save.reset();
    check.mutate(text, {
      onSuccess: (reading) => setChecked({ text, reading }),
    });
  };

  return (
    <PageShell
      backButton={BACK}
      description="告诉审核哪些事在你的组织里需要人来拍板，哪些是日常。它检查每个动作时都会读你的指引。保存之前什么都不会改变。"
      title="自动审核的指引"
    >
      {saved.isPending ? null : saved.error ? (
        <p className="text-destructive text-sm" role="alert">
          {saved.error.message}
        </p>
      ) : (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) save.mutate(text, { onSuccess: back });
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
                  {save.isPending ? "正在保存…" : "保存指引"}
                </Button>
              </>
            }
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="reviewer-guidance">指引</FieldLabel>
                <FieldDescription>
                  像给同事交代事情那样写。另一次只看你原话的解读会说明它们改变了什么。
                </FieldDescription>
                <Textarea
                  id="reviewer-guidance"
                  maxLength={GUIDANCE_LIMIT}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="凡是给公司以外的人发邮件的，都要有人拍板"
                  rows={4}
                  value={draft ?? saved.data ?? ""}
                />
                <p className="flex gap-1.5 text-muted-foreground text-sm">
                  <IconShieldLock className="mt-0.5 size-4 shrink-0" />
                  <span>
                    内置的安全规则永远优先：删除、对外发送、分享、公开发布每次都要先问，只能「允许一次」；付款、改凭据、改安全设置总是交给本人去做。指引改变不了这些。
                  </span>
                </p>
                <div>
                  <Button
                    disabled={!text || check.isPending}
                    onClick={runCheck}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {check.isPending ? "正在检查…" : "检查指引"}
                  </Button>
                </div>
                {check.error ? (
                  <p className="text-destructive text-sm" role="alert">
                    {check.error.message}
                  </p>
                ) : null}
              </Field>
              {checked ? (
                <ReadingStatus
                  check={checked.reading.check}
                  edited={
                    checked.text !== text
                      ? "检查之后你改过这段指引。保存前再检查一次。"
                      : null
                  }
                  explanation={checked.reading.explanation}
                  failed="熊宝不会保存这段指引。"
                  heading="它改变什么"
                  passed="读起来是指引。内置的安全规则仍然优先。"
                  warning={null}
                />
              ) : null}
              {passed ? (
                <GuidanceBacktestField
                  preview={preview.data}
                  run={backtest}
                  text={text}
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
      )}
      {saved.data ? (
        <PageSection
          description="从它检查的下一个动作起，审核回到自己原本的指示。"
          title="移除"
        >
          <Button
            className="mt-4"
            onClick={() => {
              remove.reset();
              setRemoving(true);
            }}
            variant="destructive"
          >
            移除指引
          </Button>
        </PageSection>
      ) : null}
      <Dialog onOpenChange={setRemoving} open={removing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移除这段指引？</DialogTitle>
            <DialogDescription>
              从它检查的下一个动作起，审核回到自己原本的指示。
            </DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <p className="text-destructive text-sm" role="alert">
              {remove.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setRemoving(false)}
              size="sm"
              variant="ghost"
            >
              取消
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={() => remove.mutate(undefined, { onSuccess: back })}
              size="sm"
              variant="destructive"
            >
              {remove.isPending ? "正在移除…" : "移除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
