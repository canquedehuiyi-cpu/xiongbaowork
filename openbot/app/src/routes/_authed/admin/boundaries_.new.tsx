import { IconCheck, IconCode, IconShieldX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { DryRunChanges } from "@/components/boundaries/dry-run-changes";
import {
  PageCard,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  RULE_ATTRIBUTES,
  RULE_TEMPLATES,
  type RuleTemplate,
} from "@/lib/boundaries/rules";
import { isComposing } from "@/lib/composing";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import {
  actionPolicyQueryOptions,
  type DryRunReport,
  dryRunActionPolicy,
} from "@/lib/computers/queries";

export const Route = createFileRoute("/_authed/admin/boundaries_/new")({
  component: NewRulePage,
});

const BACK = {
  label: "边界规则",
  linkProps: { to: "/admin/boundaries" as const },
};

/**
 * Adding a rule: pick a template or write one, see what it would have stopped, then add it.
 *
 * A template fills the form rather than adding itself, so its name, its cost and the rule it is
 * made of are all read before it applies to every Bot.
 */
function NewRulePage() {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const stored = useQuery(actionPolicyQueryOptions());
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));
  const [chosen, setChosen] = useState<RuleTemplate | "custom" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rule, setRule] = useState("");
  const [tested, setTested] = useState<DryRunReport | null>(null);
  const [testing, setTesting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const policy = stored.data;
  const trimmed = rule.trim();
  const duplicate = Boolean(policy?.deny.includes(trimmed));
  const ready = Boolean(policy && name.trim() && trimmed && !duplicate);

  const choose = (next: RuleTemplate | "custom") => {
    setChosen(next);
    setTested(null);
    setProblem(null);
    if (next === "custom") {
      setName("");
      setDescription("");
      setRule("");
    } else {
      setName(next.name);
      setDescription(next.description);
      setRule(next.rule);
    }
  };

  /*
   * The policy in force plus this rule, replayed over recent recorded actions. Nothing is saved;
   * the reply says what the addition would have stopped, so its reach is known before it applies.
   */
  const test = async () => {
    if (!policy || !trimmed) return;
    setProblem(null);
    setTesting(true);
    try {
      setTested(
        await dryRunActionPolicy({
          ...policy,
          deny: [...policy.deny, trimmed],
        }),
      );
    } catch (thrown) {
      setProblem((thrown as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const add = () => {
    if (!policy || !ready) return;
    setProblem(null);
    savePolicy.mutate(
      {
        ...policy,
        deny: [...policy.deny, trimmed],
        labels: {
          ...policy.labels,
          [trimmed]: { name: name.trim(), description: description.trim() },
        },
      },
      {
        onError: (thrown: Error) => setProblem(thrown.message),
        onSuccess: () => void navigate({ to: "/admin/boundaries" }),
      },
    );
  };

  const options: { key: string; value: RuleTemplate | "custom" }[] = [
    ...RULE_TEMPLATES.map((template) => ({
      key: template.rule,
      value: template,
    })),
    { key: "custom", value: "custom" },
  ];

  return (
    <PageShell
      backButton={BACK}
      description="规定一个任何员工都不能做的动作。从下一个动作起，它对所有员工生效。"
      title="添加规则"
    >
      <PageSection title="从这里开始">
        <PageRows>
          {options.map((option, index) => {
            const custom = option.value === "custom";
            const template = custom ? null : (option.value as RuleTemplate);
            const selected = chosen === option.value;
            const taken = template
              ? policy?.deny.includes(template.rule)
              : false;
            return (
              <div key={option.key}>
                <Item
                  aria-pressed={selected}
                  render={<button disabled={taken} type="button" />}
                  onClick={() => choose(option.value)}
                  size="sm"
                >
                  <ItemMedia variant="icon">
                    {custom ? <IconCode /> : <IconShieldX />}
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{template ? template.name : "自己写"}</ItemTitle>
                    <ItemDescription>
                      {template
                        ? taken
                          ? "已经在你的规则里了。"
                          : template.description
                        : "用 CEL 自己描述这个动作。"}
                    </ItemDescription>
                  </ItemContent>
                  {selected ? (
                    <ItemActions>
                      <IconCheck className="size-4" />
                    </ItemActions>
                  ) : null}
                </Item>
                {index !== options.length - 1 && <Separator />}
              </div>
            );
          })}
        </PageRows>
      </PageSection>

      {chosen ? (
        <PageSection title="规则内容">
          <form
            className="mt-4"
            noValidate
            onKeyDown={(event) => {
              // Enter in a field submits the form, but not the Enter that confirms a composed
              // character: that would add a rule whose name is still half typed.
              if (event.key === "Enter" && isComposing(event))
                event.preventDefault();
            }}
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <PageCard
              footer={
                <>
                  <Button
                    render={(props) => (
                      <Link {...props} to="/admin/boundaries" />
                    )}
                    variant="outline"
                  >
                    取消
                  </Button>
                  <Button
                    disabled={!ready || savePolicy.isPending}
                    type="submit"
                  >
                    {savePolicy.isPending ? "正在添加…" : "添加规则"}
                  </Button>
                </>
              }
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="rule-name">名称</FieldLabel>
                  <Input
                    id="rule-name"
                    maxLength={80}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="绝不删除文件"
                    value={name}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="rule-description">它拦住什么</FieldLabel>
                  <FieldDescription>
                    一句话，显示在列表里的名称下面。
                  </FieldDescription>
                  <Input
                    id="rule-description"
                    maxLength={300}
                    onChange={(event) => setDescription(event.target.value)}
                    value={description}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="rule-expression">规则</FieldLabel>
                  <FieldDescription>
                    用 CEL
                    写成。无法求值的规则算作命中，所以写错了只会多拦，不会漏放。
                  </FieldDescription>
                  <Textarea
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="min-h-20 font-mono text-xs"
                    id="rule-expression"
                    onChange={(event) => {
                      setRule(event.target.value);
                      setTested(null);
                    }}
                    placeholder='tool.name == "computer_click" && contains(element.name, "delete")'
                    spellCheck={false}
                    value={rule}
                  />
                  {duplicate ? (
                    <p className="text-destructive text-sm">
                      这条规则已经在了。
                    </p>
                  ) : null}
                  {chosen !== "custom" ? (
                    <p className="text-amber-600 text-sm dark:text-amber-500">
                      {chosen.cost}
                    </p>
                  ) : null}
                  <RuleReference />
                </Field>
              </FieldGroup>

              <div className="mt-5">
                <Button
                  disabled={testing || !trimmed || !policy}
                  onClick={() => void test()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {testing ? "正在测试…" : "拿最近的动作测试"}
                </Button>
                {tested ? <TestResult report={tested} /> : null}
              </div>

              {problem ? (
                <p className="mt-5 text-destructive text-sm" role="alert">
                  {problem}
                </p>
              ) : null}
            </PageCard>
          </form>
        </PageSection>
      ) : null}
    </PageShell>
  );
}

/**
 * What a rule can check, folded away until it is wanted. It used to be the page's description, a
 * paragraph of attribute names read by everybody to find out what the screen was for.
 */
function RuleReference() {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        规则能检查哪些内容
      </summary>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        {RULE_ATTRIBUTES.map((attribute) => (
          <div className="contents" key={attribute.name}>
            <dt>
              <code className="font-mono text-xs">{attribute.name}</code>
            </dt>
            <dd className="text-muted-foreground">{attribute.meaning}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-muted-foreground">
        规则里写了动作没有的属性（比如对点击动作写
        <code className="font-mono text-xs">key</code>
        ），也算命中。先写明工具，其余条件就只在适用的地方检查：{" "}
        <code className="font-mono text-xs">
          tool.name == "computer_key" && key == "Enter"
        </code>
        .
      </p>
    </details>
  );
}

function TestResult({ report }: { report: DryRunReport }) {
  if (report.scanned === 0) {
    return (
      <p className="mt-3 text-muted-foreground text-sm" role="status">
        还没有记录到可供测试的动作。规则本身没问题；员工开始干活后，就能看到它拦下什么。
      </p>
    );
  }
  return (
    <div className="mt-3" role="status">
      <p className="text-muted-foreground text-sm">
        {report.wouldRefuse === 0
          ? `最近记录的 ${report.scanned} 个动作里，这条规则一个也不会拦。以后的动作仍可能被它拦下。`
          : `最近记录的 ${report.scanned} 个动作里，这条规则会拦下 ${report.wouldRefuse} 个。`}
      </p>
      <DryRunChanges
        changes={report.changes.filter((change) => change.would === "refused")}
        total={report.wouldRefuse}
      />
    </div>
  );
}
