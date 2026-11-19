import {
  describeApproval,
  type SharedUseApproval,
} from "@/lib/plugins/shared-use";

export function sharedSectionSentence(
  effect: "read" | "write",
  shared: boolean,
): string | null {
  if (!shared) return null;
  return effect === "write"
    ? "能用这位员工的人，都能以团队账号的身份做这些。"
    : "能用这位员工的人，都能读到这个账号读得到的东西。";
}

/**
 * Who may use a shared account through one Bot: the audience the Bot has now, offered as the
 * default, and only ever NARROWED here. Named people are offered only when the Bot is published to
 * named people, because that list is what a `people` approval records.
 */
export function SharedApprovalFields({
  value,
  onChange,
}: {
  value: SharedUseApproval;
  onChange: (next: SharedUseApproval) => void;
}) {
  const named = value.audience === "people" || value.members.length > 0;
  const options: { audience: SharedUseApproval["audience"]; label: string }[] =
    [
      { audience: "owner", label: "只有它的主人" },
      ...(named
        ? [
            {
              audience: "people" as const,
              label: `指定的人：${describeApproval({ ...value, audience: "people", outsideInput: false })}`,
            },
          ]
        : []),
      { audience: "team", label: "所有人" },
    ];
  return (
    <fieldset className="space-y-2 text-sm">
      <legend className="font-medium">谁能通过这位员工使用团队账号</legend>
      {options.map((option) => (
        <label className="flex items-center gap-2" key={option.audience}>
          <input
            checked={value.audience === option.audience}
            name="shared-audience"
            onChange={() =>
              onChange({
                ...value,
                audience: option.audience,
                members: option.audience === "people" ? value.members : [],
              })
            }
            type="radio"
          />
          {option.label}
        </label>
      ))}
      <label className="flex items-center gap-2">
        <input
          checked={value.outsideInput}
          onChange={(event) =>
            onChange({ ...value, outsideInput: event.target.checked })
          }
          type="checkbox"
        />
        外部来的消息（邮件、Slack、Webhook）也可以用它
      </label>
    </fieldset>
  );
}
