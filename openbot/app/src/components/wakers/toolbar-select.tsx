import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type ToolbarOption<T extends string> = { value: T; label: string };

/**
 * One dropdown on the Waker 管理 toolbar (运行状态 / 角色 / 环境 / 排序): the shared Select, at the
 * reference's 32 CSS px toolbar height, named by `label` for assistive technology. The closed
 * trigger shows the chosen option's own words, so "全部状态" reads as the filter being off.
 */
export function ToolbarSelect<T extends string>({
  label,
  value,
  options,
  onValueChange,
}: {
  label: string;
  value: T;
  options: readonly ToolbarOption<T>[];
  onValueChange: (value: T) => void;
}) {
  return (
    <Select
      items={Object.fromEntries(
        options.map((option) => [option.value, option.label]),
      )}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next as T);
      }}
      value={value}
    >
      <SelectTrigger
        aria-label={label}
        className="min-w-[112px] text-[13px] data-[size=default]:h-[32px]"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
