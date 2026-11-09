import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { DryRunChanges } from "@/components/boundaries/dry-run-changes";
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
import { ruleLabel, withoutRule } from "@/lib/boundaries/rules";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import {
  type ActionPolicy,
  actionPolicyQueryOptions,
  dryRunActionPolicy,
} from "@/lib/computers/queries";

export const Route = createFileRoute("/_authed/admin/boundaries_/$index")({
  component: RulePage,
});

const BACK = {
  label: "边界规则",
  linkProps: { to: "/admin/boundaries" as const },
};

/**
 * One rule: what it is called, what it is made of, and what it has stopped lately.
 *
 * Addressed by position because a rule has no id of its own, only its text. A position that no
 * longer holds a rule, because it was removed elsewhere, says so rather than showing a neighbour.
 */
function RulePage() {
  const { index } = Route.useParams();
  const stored = useQuery(actionPolicyQueryOptions());
  const policy = stored.data;
  const rule = policy?.deny[Number(index)];

  if (!policy) {
    return (
      <PageShell backButton={BACK} title="规则">
        {stored.error ? (
          <p className="text-destructive text-sm" role="alert">
            {stored.error.message}
          </p>
        ) : null}
      </PageShell>
    );
  }
  if (rule === undefined) {
    return (
      <PageShell backButton={BACK} title="规则">
        <p className="text-muted-foreground text-sm">
          这条规则已经不在了，可能已被删除。
        </p>
      </PageShell>
    );
  }
  return <RuleDetail policy={policy} rule={rule} />;
}

function RuleDetail({ policy, rule }: { policy: ActionPolicy; rule: string }) {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));
  const [removing, setRemoving] = useState(false);
  const label = ruleLabel(policy, rule);

  /*
   * What this rule has stopped, read as the difference it makes: the policy without it, replayed
   * over recent actions, would have allowed exactly the ones it stopped.
   */
  const reach = useQuery({
    queryKey: ["computers", "policy", "reach", rule],
    queryFn: () => dryRunActionPolicy(withoutRule(policy, rule)),
  });

  const remove = () =>
    savePolicy.mutate(withoutRule(policy, rule), {
      onSuccess: () => void navigate({ to: "/admin/boundaries" }),
    });

  return (
    <PageShell
      backButton={BACK}
      description={label.description || undefined}
      title={label.name}
    >
      {policy.mode === "dry-run" ? (
        <p className="text-amber-600 text-sm dark:text-amber-500">
          试运行已开启，这条规则只记录命中的动作，不会拦下。
        </p>
      ) : null}

      <PageSection
        description="用 CEL 写成。员工每做一个动作前都会检查它。"
        title="规则"
      >
        <PageCard className="mt-4">
          <code className="block whitespace-pre-wrap break-all font-mono text-xs">
            {rule}
          </code>
        </PageCard>
      </PageSection>

      <PageSection title="最近拦下的">
        {reach.isPending ? null : reach.error ? (
          <p className="mt-4 text-muted-foreground text-sm">
            {reach.error.message}
          </p>
        ) : reach.data.scanned === 0 ? (
          <p className="mt-4 text-muted-foreground text-sm">
            还没有记录到动作。员工开始干活后，这条规则拦下的动作会显示在这里。
          </p>
        ) : (
          <>
            <p className="mt-4 text-muted-foreground text-sm">
              {reach.data.wouldAllow === 0
                ? `最近记录的 ${reach.data.scanned} 个动作里，它一个也没拦。`
                : `最近记录的 ${reach.data.scanned} 个动作里，它拦下了 ${reach.data.wouldAllow} 个。`}
            </p>
            <DryRunChanges
              changes={reach.data.changes.filter(
                (change) => change.would === "allowed",
              )}
              total={reach.data.wouldAllow}
            />
          </>
        )}
      </PageSection>

      <PageSection
        description="从下一个动作起，员工又可以做这件事了。"
        title="删除"
      >
        <Button
          className="mt-4"
          onClick={() => setRemoving(true)}
          variant="destructive"
        >
 删除规则

        </Button>
      </PageSection>

      <Dialog onOpenChange={setRemoving} open={removing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除「{label.name}」？</DialogTitle>
            <DialogDescription>
              从下一个动作起，所有员工又可以做这件事了。
            </DialogDescription>
          </DialogHeader>
          {savePolicy.error ? (
            <p className="text-destructive text-sm" role="alert">
              {savePolicy.error.message}
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
              disabled={savePolicy.isPending}
              onClick={remove}
              size="sm"
              variant="destructive"
            >
              {savePolicy.isPending ? "正在删除…" : "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
