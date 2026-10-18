import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isComposing } from "@/lib/composing";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import {
  type ActionPolicy,
  actionPolicyQueryOptions,
  type DryRunReport,
  dryRunActionPolicy,
  type PolicyMode,
} from "@/lib/computers/queries";
import { queryClient } from "@/query-client";

/**
 * CEL computer-action boundary editor. Rules are shown as the gateway evaluates them, and denied
 * actions are recorded in Audit with the matching rule.
 */

/**
 * Presets are concrete CEL rules, not a separate policy language.
 */
const PRESETS: { label: string; rule: string; cost?: string }[] = [
  {
    label: "绝不提交表单",
    // `key` is guarded by tool name so the clause short-circuits before it on actions that have no
    // keypress in them. Both tools that can press Enter are named: `computer_type` takes a `submit`
    // flag that presses it once the text is in, and a rule naming only `computer_key` left that door
    // open.
    rule: '(intent == "activate" && contains(element.name, "submit")) || ((tool.name == "computer_key" || tool.name == "computer_type") && key == "Enter")',
    cost: "也会拦住员工在别处按回车，因为在表单的任意字段里按回车都会提交。",
  },
  {
    label: "绝不在密码框里输入",
    rule: 'intent == "type" && contains(element.name, "password")',
    cost: "页面上标签不叫 password 的密码框不在覆盖范围内，规则匹配的是标签。",
  },
  {
    label: "不上社交媒体",
    rule: 'intent == "navigate" && (contains(page.host, "facebook.com") || contains(page.host, "x.com"))',
    cost: "只管列出的两个域名。从别处跳转过去的链接仍然放行。",
  },
];

export const Route = createFileRoute("/_authed/admin/boundaries")({
  component: BoundariesPage,
});

function BoundariesPage() {
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState("");

  const [tested, setTested] = useState<{
    rule: string;
    report: DryRunReport;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const stored = useQuery(actionPolicyQueryOptions());
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));

  /*
   * The saved policy wins while a save is in flight and after it lands: the server normalises what
   * it stores, so what came back is the policy, not what was sent.
   */
  const policy = savePolicy.data ?? stored.data ?? null;
  const saving = savePolicy.isPending;

  const save = (next: ActionPolicy) => {
    setSaved(false);
    setProblem(null);
    savePolicy.mutate(next, {
      onError: (thrown: Error) => setProblem(thrown.message),
      onSuccess: () => setSaved(true),
    });
  };

  /*
   * A read that failed says so. This screen used to set "The boundary could not be read." itself;
   * since the read became a query, that sentence (or the server's own) is the query's error, and
   * without this the page sat on its title with nothing under it for as long as it was open.
   */
  const unreadable = problem ?? stored.error?.message ?? null;
  if (unreadable && !policy) {
    return (
      <PageShell title="边界规则">
        <p className="mt-4 text-destructive text-sm" role="alert">
          {unreadable}
        </p>
      </PageShell>
    );
  }

  /* Nothing until the policy is known: a rule list that guesses is worse than a blank. */
  if (!policy) {
    return <PageShell title="边界规则">{null}</PageShell>;
  }

  const addRule = (rule: string) => {
    const trimmed = rule.trim();
    if (!trimmed || policy.deny.includes(trimmed)) return;
    void save({ ...policy, deny: [...policy.deny, trimmed] });
    setDraft("");
    setTested(null);
  };

  /*
   * The rule as it would be in force — the current policy plus this draft — replayed over recent
   * recorded actions. Nothing is saved and nothing is decided; the reply names the actions the
   * addition would have decided differently, so the rule's real reach is known before it starts
   * refusing anybody.
   */
  const testRule = async (rule: string) => {
    const trimmed = rule.trim();
    if (!trimmed) return;
    setProblem(null);
    setTesting(true);
    try {
      const report = await dryRunActionPolicy({
        ...policy,
        deny: [...policy.deny, trimmed],
      });
      setTested({ rule: trimmed, report });
    } catch (thrown) {
      setProblem((thrown as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <PageShell
      description={
        <>
          每位员工用自己的电脑时能做什么、不能做什么。每个动作发生前都会检查规则，被拒绝的动作会记录在
          <Link className="underline" to="/admin/audit">
            审计
          </Link>
          里，并注明是哪条规则拒绝的。
        </>
      }
      title="边界规则"
    >
      <PageSection
        description="“拦下动作”会阻止它；“记录并放行”会写下同样一行记录但让动作通过——这样可以先在真实流量上试一条规则，再让它真正拒绝任何人。"
        title="规则命中时"
      >
        <div className="mt-2 flex gap-2">
          {(["enforce", "dry-run"] as PolicyMode[]).map((mode) => (
            <Button
              key={mode}
              aria-pressed={policy.mode === mode}
              className={policy.mode === mode ? "bg-foreground/5" : undefined}
              disabled={saving}
              onClick={() => void save({ ...policy, mode })}
              size="sm"
              variant="outline"
            >
              {mode === "enforce" ? "拦下动作" : "记录并放行"}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {policy.mode === "enforce"
            ? "员工会被拦下，并被告知是哪条规则拒绝了它。"
            : "什么都不会被拦下。规则命中的每个动作都会按“本应被拒绝”记录下来——这是规则正式启用前的试运行方式。"}
        </p>
      </PageSection>

      <PageSection
        description={
          <>
            先检查这里，一旦命中就结束：下面的规则不再参与，员工会被告知是哪条规则拒绝了它。规则用
            CEL 编写，可以用到 <code>tool.name</code>、<code>intent</code>、
            <code>bot.id</code>、<code>actor.id</code>、<code>page.url</code>、
            <code>page.host</code>，被操作的元素、按下的 <code>key</code>
            、涉及的文件、执行的
            <code>command</code>，以及调用别人的工具时的 <code>mcp.server</code>
            、<code>mcp.tool</code> 和 <code>mcp.effect</code>。
            <code>initiator.kind</code>
            说明这次运行由谁发起——<code>person</code>、<code>routine</code> 或
            <code>handoff</code>——这一点 <code>actor.id</code>
            做不到，因为定时运行带着主人的权限、却无人在场。无法求值的规则按命中处理，所以写错的禁止规则会拒绝，而不是悄悄放行它本想禁止的事。
          </>
        }
        title="它绝不能"
      >
        {policy.deny.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            没有规则。每个动作都会放行并记录。
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-md border border-border">
            {policy.deny.map((rule) => (
              <li
                className="flex items-center justify-between gap-4 px-3 py-2"
                key={rule}
              >
                <code className="min-w-0 break-all font-mono text-xs">
                  {rule}
                </code>
                <Button
                  disabled={saving}
                  onClick={() =>
                    void save({
                      ...policy,
                      deny: policy.deny.filter((one) => one !== rule),
                    })
                  }
                  size="sm"
                  variant="ghost"
                >
                  移除
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex gap-2">
          <Input
            aria-label="一条用 CEL 写的规则"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 font-mono text-xs"
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
              setTested(null);
            }}
            onKeyDown={(event) => {
              // Not the Enter that confirms a composed character, which would put a half-typed
              // rule into the policy in force.
              if (event.key === "Enter" && !isComposing(event)) addRule(draft);
            }}
            placeholder='tool.name == "computer_click" && contains(element.name, "submit")'
            value={draft}
          />
          <Button
            disabled={testing || draft.trim().length === 0}
            onClick={() => void testRule(draft)}
            size="sm"
            variant="outline"
          >
            {testing ? "正在测试…" : "先测试"}
          </Button>
          <Button
            disabled={saving || draft.trim().length === 0}
            onClick={() => addRule(draft)}
            size="sm"
          >
            添加规则
          </Button>
        </div>

        {tested ? <DryRunResult report={tested.report} /> : null}

        <ul className="mt-3 space-y-2">
          {PRESETS.map((preset) => (
            <li className="flex items-start gap-3" key={preset.rule}>
              <Button
                className="shrink-0"
                disabled={saving || policy.deny.includes(preset.rule)}
                onClick={() => addRule(preset.rule)}
                size="sm"
                variant="outline"
              >
                {preset.label}
              </Button>
              {preset.cost ? (
                <span className="pt-1 text-xs text-muted-foreground">
                  {preset.cost}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </PageSection>

      <PageSection
        description="兜底规则，作用于禁止列表没拦住的一切。它不是摆设：这里为空就表示什么都不允许，所以清空它的部署会拒绝所有动作，而不是放行所有动作。"
        title="除此之外它可以"
      >
        <ul className="mt-2 space-y-1">
          {policy.allow.map((rule) => (
            <li className="font-mono text-xs text-muted-foreground" key={rule}>
              {rule === "true" ? "true，即上面没拒绝的都可以" : rule}
            </li>
          ))}
        </ul>
      </PageSection>

      <p className="mt-8 text-muted-foreground text-xs">
        {problem ? (
          <span className="text-destructive" role="alert">
            {problem}
          </span>
        ) : saved ? (
          "已保存。从任何员工的下一个动作开始生效。"
        ) : (
          "改动从任何员工的下一个动作开始生效，并会保留：重启后仍按这里的规则执行。"
        )}
      </p>
    </PageShell>
  );
}

/**
 * What the tested rule would have done to actions already on the trail.
 *
 * Says the number over everything scanned first, because the list below it is capped and a reader
 * who stops at the rows should not believe the rows are the whole answer.
 */
function DryRunResult({ report }: { report: DryRunReport }) {
  if (report.scanned === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground" role="status">
        还没有可供测试的电脑操作记录。规则本身有效；它会命中什么，要等员工有了操作才知道。
      </p>
    );
  }

  return (
    <div className="mt-2" role="status">
      <p className="text-xs text-muted-foreground">
        {report.wouldRefuse === 0
          ? `用最近 ${report.scanned} 条操作记录测试：这条规则一条都不会拒绝。以后的动作仍可能命中它。`
          : `用最近 ${report.scanned} 条操作记录测试：这条规则会拒绝其中 ${report.wouldRefuse} 条。`}
      </p>
      {report.changes.length > 0 ? (
        <ul className="mt-2 divide-y divide-border rounded-md border border-border">
          {report.changes.map((change) => (
            <li className="px-3 py-2" key={change.id}>
              <p className="text-xs">
                <span className="font-medium">
                  {change.would === "refused" ? "将会拒绝" : "现在会放行"}
                </span>{" "}
                <code className="font-mono">{change.action}</code>
                {change.element?.name ? (
                  <> 作用于“{change.element.name}”</>
                ) : null}
                {change.command ? (
                  <>
                    {" "}
                    执行 <code className="font-mono">{change.command}</code>
                  </>
                ) : null}
                {change.file ? <> 涉及文件 {change.file}</> : null}
              </p>
              <p className="mt-0.5 text-muted-foreground text-xs">
                {change.bot}
                {change.page ? <> · {change.page}</> : null} ·{" "}
                {new Date(change.createdAt).toLocaleString("zh-CN")}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {report.wouldRefuse > report.changes.length ? (
        <p className="mt-1 text-muted-foreground text-xs">
          只显示前 {report.changes.length} 条；上面的数字涵盖了全部扫描结果。
        </p>
      ) : null}
    </div>
  );
}
