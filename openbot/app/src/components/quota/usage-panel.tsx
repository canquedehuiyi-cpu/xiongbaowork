import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { meter, quotaSummaryQueryOptions } from "@/lib/quota/queries";

/**
 * The bottom-left panel: what this workspace is on, and how close it is to the ceiling (spec K2).
 *
 * It is a summary rather than a control. The person who reads "2 of 2" here is about to be refused
 * somewhere else, and the only useful thing a panel can do at that moment is name the plan and hand
 * over the one link that changes it.
 */
export function UsagePanel() {
  const quota = useQuery(quotaSummaryQueryOptions());
  const data = quota.data;
  if (!data?.plan || !data.limits) return null;

  const rows = [
    { label: "员工", value: meter(data.usage.wakers, data.limits.wakers) },
    {
      label: "本月任务",
      value: meter(data.usage.tasks, data.limits.tasksPerMonth),
    },
    {
      label: "设备",
      value: meter(data.usage.devices, data.limits.devices),
    },
  ];

  return (
    <div className="flex flex-col gap-1.5 px-1">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-xs">{data.plan.name}</span>
        <Link
          className="text-muted-foreground text-xs underline-offset-2 hover:underline"
          to="/plans"
        >
          套餐与用量
        </Link>
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li
            className={
              row.value.full
                ? "text-amber-600 text-xs"
                : "text-muted-foreground text-xs"
            }
            key={row.label}
          >
            {row.label} {row.value.used}/
            {row.value.limit === null ? "不限" : row.value.limit}
          </li>
        ))}
      </ul>
    </div>
  );
}
