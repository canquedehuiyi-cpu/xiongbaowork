import type { ActionPolicy, RuleLabel } from "@/lib/computers/queries";

/**
 * A rule an administrator can start from, in words first and CEL underneath.
 *
 * `cost` is what the rule also catches, or misses, that its name does not say. Each one is a real
 * edge of the rule as written, so it is shown before the rule is added rather than discovered from
 * the refusals it produces.
 */
export type RuleTemplate = RuleLabel & {
  rule: string;
  cost: string;
  /**
   * The rule's earlier text, still in force wherever it was added before it changed, and saved
   * without a name of its own then. Read so that rule keeps the template's name.
   */
  formerRules?: string[];
};

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    name: "绝不提交表单",
    description: "不让员工点提交按钮，也不让它在输入时按回车。",
    // The keypress clause is guarded by tool name so a click is only refused on a submit button.
    // Both tools that can press Enter are named: `computer_type` takes a `submit` flag that presses
    // it once the text is in, and a rule naming only `computer_key` left that door open. It asks for
    // the activation the gateway reads from the key, not `key == "Enter"`, so Shift+Enter, `\n` and
    // Space (which press a focused button) are refused as well.
    rule: '(intent == "activate" && contains(element.name, "submit")) || ((tool.name == "computer_key" || tool.name == "computer_type") && intent == "activate")',
    cost: "也会拦住员工在别处按回车或空格，因为在表单的任意字段里按回车都会提交。",
  },
  {
    name: "绝不在密码框里输入",
    description: "不让员工在标为密码的输入框里打字。",
    rule: 'intent == "type" && contains(element.name, "password")',
    cost: "页面上标签不叫 password 的密码框不在覆盖范围内，规则匹配的是标签。",
  },
  {
    name: "不上社交媒体",
    description: "不让员工打开 Facebook 或 X。",
    // Each site, or a name ending in a dot and the site. `contains(page.host, "x.com")` also stopped
    // dropbox.com and netflix.com. The dot is `[.]` because cel-js keeps backslashes as written, so
    // `\\.` would match a backslash and the rule would stop nothing.
    rule: 'intent == "navigate" && (page.host == "facebook.com" || matches(page.host, "[.]facebook[.]com$") || page.host == "x.com" || matches(page.host, "[.]x[.]com$"))',
    formerRules: [
      'intent == "navigate" && (contains(page.host, "facebook.com") || contains(page.host, "x.com"))',
    ],
    cost: "只管这两个网站。从别处跳转过去的链接仍然放行。",
  },
];

/** The template a rule came from: its current text, or one it shipped with before. */
function templateOf(rule: string): RuleTemplate | undefined {
  return RULE_TEMPLATES.find(
    (one) => one.rule === rule || one.formerRules?.includes(rule),
  );
}

/** What a rule can be written against, in the words an administrator would use. */
export const RULE_ATTRIBUTES: { name: string; meaning: string }[] = [
  {
    name: "tool.name",
    meaning: "动作本身，比如 computer_click、computer_type 或 computer_key。",
  },
  {
    name: "intent",
    meaning:
      "动作的用途：activate（触发）、type（输入）或 navigate（打开网页）。",
  },
  { name: "bot.id", meaning: "执行这个动作的员工。" },
  { name: "actor.id", meaning: "员工替谁做这件事。" },
  {
    name: "initiator.kind",
    meaning:
      "这次运行是谁发起的：person（本人）、routine（定时任务）或 handoff（交接）。定时运行以主人的身份执行，所以单看 actor.id 分辨不出来。",
  },
  { name: "page.url, page.host", meaning: "员工所在的网页。" },
  {
    name: "element.name, element.role",
    meaning: "被点击或被输入的按钮、链接或输入框。",
  },
  { name: "key", meaning: "按下的键，比如 Enter。" },
  { name: "file", meaning: "被读取或写入的文件。" },
  { name: "command", meaning: "正在执行的命令。" },
  {
    name: "mcp.server, mcp.tool, mcp.effect",
    meaning: "用于已连接应用的工具：哪个应用、哪个工具，以及是读还是写。",
  },
];

/** The name a rule is shown by: its label, a template's name if it is one, or plainly "Custom rule". */
export function ruleLabel(policy: ActionPolicy, rule: string): RuleLabel {
  const label = policy.labels?.[rule];
  if (label) return label;
  const template = templateOf(rule);
  if (template)
    return { name: template.name, description: template.description };
  return { name: "自定义规则", description: "" };
}

/**
 * The policy with one rule rewritten in place, keeping its position and taking its name with it.
 *
 * A template's rule has no stored label, only the template's own, so that one is stored under the
 * new text: edited, it no longer matches the template, and would otherwise read as "Custom rule".
 */
export function withRuleReplaced(
  policy: ActionPolicy,
  rule: string,
  next: string,
): ActionPolicy {
  const { [rule]: own, ...labels } = policy.labels ?? {};
  const template = templateOf(rule);
  const label =
    own ??
    (template
      ? { name: template.name, description: template.description }
      : undefined);
  return {
    ...policy,
    deny: policy.deny.map((one) => (one === rule ? next : one)),
    labels: label ? { ...labels, [next]: label } : labels,
  };
}

/** The policy without one rule, and without that rule's label. */
export function withoutRule(policy: ActionPolicy, rule: string): ActionPolicy {
  const { [rule]: _removed, ...labels } = policy.labels ?? {};
  return {
    ...policy,
    deny: policy.deny.filter((one) => one !== rule),
    labels,
  };
}
