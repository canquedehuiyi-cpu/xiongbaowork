import { IconAlertTriangle, IconChevronLeft } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import {
  HarnessTile,
  harnessAbout,
} from "@/components/agents/external/hire-from-computer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ACP_RULE_DEFAULTS,
  type AcpHarness,
  type AcpRuleKey,
  type AcpRuleValue,
  deviceStanding,
  HARNESS_LABEL,
  hireExternalMutationOptions,
  RULE_ROWS,
  RULE_VALUE_LABEL,
  ruleChoices,
} from "@/lib/agents/external";
import { DEPARTMENT_MAX_CHARACTERS } from "@/lib/agents/form";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { shortName } from "@/lib/brand";
import { devicesQueryOptions } from "@/lib/devices/queries";
import { cn } from "@/lib/utils";

/**
 * 招聘设置（外部员工 Task 10，设计稿第 2 屏）：名字、部门、工作文件夹（只列这台电脑共享的文件夹，传
 * `fld_…` 引用）、汇报说明；「哪些事要先问你」五项规则，默认值按规格；三条底线固定显示、不能关。
 *
 * - 任何一项选「直接做」，那一行下面写清楚这意味着什么；「运行命令」尤其：命令行上的付款、删除、外发
 *   熊宝尽量认出来，但拦不全。
 * - 招 Hermes 时写明：它有自己的智能审批，不能保证每个动作都先请求许可。
 * - 手动添加（`custom`）：选桌面端登记的本机智能体（`app_…`），并要再勾一次「我知道它可能从不请求许可」
 *   才能招（规格第 4 节）。
 * - 日报那一项等日报上线再显示；「做完一件事就交付并上看板」是现有行为，只写说明，不是开关。
 */

/** 名字最长 40 个字，和服务器一样。 */
const NAME_MAX = 40;

/** 底线文案：比设计稿的「删除整个文件夹」更严，和现有员工一致（规格第 4 节）。 */
export const BOTTOM_LINE = "付款和下单 · 删除文件 · 对外发消息或邮件";

/** 选「直接做」时那一行下面的话。 */
function directWarning(key: AcpRuleKey): string {
  if (key === "runCommand")
    return `命令行上的付款、删除、外发，${shortName()}会尽量认出来，但拦不全。需要硬保证，请把这项设为「先问我」。`;
  return "这类事它做之前不再问你；删除文件、付款和下单、对外发消息仍然每次交给你。";
}

const fieldClass =
  "h-10 w-full min-w-0 rounded-[9px] border border-input bg-card px-3 text-foreground text-sm dark:bg-input/30";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-[1_1_420px] flex-col gap-4 rounded-[14px] border border-border bg-card p-[22px]"
      data-slot="hire-section"
    >
      <h3 className="m-0 font-semibold text-[16px]">{title}</h3>
      {children}
    </section>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p
      className="m-0 flex items-start gap-1.5 text-[12px] text-amber-700 leading-relaxed dark:text-amber-300"
      data-slot="hire-warning"
    >
      <IconAlertTriangle
        aria-hidden="true"
        className="mt-[2px] size-3.5 shrink-0"
      />
      <span>{children}</span>
    </p>
  );
}

export function HireSettings({
  deviceId,
  harness,
  onHired,
  onCancel,
}: {
  deviceId: string;
  harness: AcpHarness;
  onHired: (agentId: string) => void;
  /** 「返回」「取消」：回到「从我的电脑招」。 */
  onCancel?: () => void;
}) {
  const queryClient = useQueryClient();
  const devices = useQuery(devicesQueryOptions());
  const me = useQuery(currentUserQueryOptions()).data?.id;
  const agents = useQuery(agentListQueryOptions());
  const hire = useMutation(hireExternalMutationOptions(queryClient));
  const ids = useId();

  const device = devices.data?.find((row) => row.deviceId === deviceId);
  const roots = device?.roots ?? [];
  const apps = device?.apps ?? [];
  const custom = harness === "custom";

  const [name, setName] = useState<string | null>(null);
  const [department, setDepartment] = useState("");
  const [workdirRef, setWorkdirRef] = useState<string | null>(null);
  const [appRef, setAppRef] = useState<string | null>(null);
  const [rules, setRules] =
    useState<Record<AcpRuleKey, AcpRuleValue>>(ACP_RULE_DEFAULTS);
  const [acknowledged, setAcknowledged] = useState(false);

  // 没动过的就用默认：第一个共享文件夹、第一个登记的本机智能体、这家的名字。
  const chosenWorkdir = workdirRef ?? roots[0]?.ref ?? "";
  const chosenApp = appRef ?? apps[0]?.ref ?? "";
  const appName = apps.find((app) => app.ref === chosenApp)?.name;
  const label =
    harness === "custom" ? (appName ?? "本机智能体") : HARNESS_LABEL[harness];
  const chosenName = name ?? label;

  const back = onCancel ? (
    <button
      className="inline-flex w-fit items-center gap-0.5 text-[14px] text-muted-foreground hover:text-foreground"
      onClick={onCancel}
      type="button"
    >
      <IconChevronLeft aria-hidden="true" className="size-4" />
      返回
    </button>
  ) : null;

  if (devices.isPending)
    return (
      <p className="text-[13px] text-muted-foreground" role="status">
        正在读这台电脑…
      </p>
    );
  if (!device || deviceStanding(device, me) !== "mine")
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p className="m-0 text-[13px] text-muted-foreground" role="alert">
          {!device
            ? "找不到这台电脑。"
            : device.pairedByUserId == null
              ? "这台电脑还没认主人，在桌面端重新登录一次即可认领。"
              : "只能在你自己配对的电脑上招。"}
        </p>
      </div>
    );

  const departments = [
    ...new Set(
      (agents.data ?? [])
        .map((agent) => agent.department?.trim())
        .filter((value): value is string => !!value),
    ),
  ];
  const trimmedName = chosenName.trim();
  const trimmedDepartment = department.trim();
  const ready =
    trimmedName.length > 0 &&
    [...trimmedName].length <= NAME_MAX &&
    [...trimmedDepartment].length <= DEPARTMENT_MAX_CHARACTERS &&
    !!chosenWorkdir &&
    (!custom || (!!chosenApp && acknowledged));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || hire.isPending) return;
    hire.mutate(
      {
        deviceId: device.deviceId,
        harness,
        name: trimmedName,
        ...(trimmedDepartment ? { department: trimmedDepartment } : {}),
        workdirRef: chosenWorkdir,
        ...(custom
          ? { appRef: chosenApp, acknowledgeNoPermission: acknowledged }
          : {}),
        rules,
      },
      { onSuccess: (agent) => onHired(agent.id) },
    );
  };

  const subtitle =
    harness === "custom"
      ? "用它自己的配置干活"
      : harness === "hermes"
        ? "用它自己配置的模型"
        : harnessAbout(harness).plan.replace("干活", "");

  return (
    <form
      aria-label={`把 ${label} 招进来`}
      className="flex flex-col gap-6"
      data-slot="hire-settings"
      onSubmit={submit}
    >
      {back}
      <div className="-mt-3 flex items-center gap-4">
        <HarnessTile harness={harness} name={label} size="lg" />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="m-0 font-semibold text-[22px]">把 {label} 招进来</h2>
          <span className="text-muted-foreground">
            在 {device.name} 上干活 · {subtitle}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <Section title="基本信息">
          <div className="flex flex-col gap-1.5">
            <label
              className="text-[13px] text-muted-foreground"
              htmlFor={`${ids}-name`}
            >
              名字
            </label>
            <Input
              className="h-10"
              id={`${ids}-name`}
              maxLength={NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              value={chosenName}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              className="text-[13px] text-muted-foreground"
              htmlFor={`${ids}-department`}
            >
              部门
            </label>
            <Input
              className="h-10"
              id={`${ids}-department`}
              list={`${ids}-departments`}
              onChange={(event) => setDepartment(event.target.value)}
              placeholder="未分组"
              value={department}
            />
            <datalist id={`${ids}-departments`}>
              {departments.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </div>
          {custom ? (
            <div className="flex flex-col gap-1.5">
              <label
                className="text-[13px] text-muted-foreground"
                htmlFor={`${ids}-app`}
              >
                本机智能体
              </label>
              {apps.length > 0 ? (
                <select
                  className={fieldClass}
                  data-slot="hire-select"
                  id={`${ids}-app`}
                  onChange={(event) => setAppRef(event.target.value)}
                  value={chosenApp}
                >
                  {apps.map((app) => (
                    <option key={app.ref} value={app.ref}>
                      {app.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="m-0 text-[13px] text-muted-foreground">
                  这台电脑还没有登记本机智能体。在桌面端填好它的启动命令登记后，再回来招。
                </p>
              )}
              <span className="text-[12px] text-muted-foreground">
                启动命令只存在这台电脑上，在桌面端填写和修改。
              </span>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <label
              className="text-[13px] text-muted-foreground"
              htmlFor={`${ids}-workdir`}
            >
              工作文件夹（它只在这里面干活）
            </label>
            {roots.length > 0 ? (
              <select
                className={fieldClass}
                data-slot="hire-select"
                id={`${ids}-workdir`}
                onChange={(event) => setWorkdirRef(event.target.value)}
                value={chosenWorkdir}
              >
                {roots.map((root) => (
                  <option key={root.ref} value={root.ref}>
                    {root.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="m-0 text-[13px] text-muted-foreground">
                这台电脑还没有共享文件夹。请先在桌面端添加一个，再回来招。
              </p>
            )}
            <span className="text-[12px] text-muted-foreground">
              只列出这台电脑在桌面端共享的文件夹；要用新文件夹，请先在桌面端添加。
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] text-muted-foreground">汇报</span>
            <p className="m-0 text-[14px]">
              做完一件事就在对话里交付，并上任务看板。
            </p>
          </div>
        </Section>

        <Section title="哪些事要先问你">
          <p className="m-0 text-[13px] text-muted-foreground leading-relaxed">
            {label} 做这些事之前会先请求许可，{shortName()}
            把请求发到「等你确认」，同时推到你的手机。
          </p>
          {harness === "hermes" ? (
            <Warning>
              Hermes
              有自己的智能审批，它认为风险低的动作可能不先请求许可就做了，
              {shortName()}不能保证它每个动作都先问你。
            </Warning>
          ) : null}
          <ul className="m-0 flex list-none flex-col p-0">
            {RULE_ROWS.map((row, index) => (
              <li
                className={cn(
                  "flex flex-col gap-1.5 py-2.5",
                  index < RULE_ROWS.length - 1 && "border-border border-b",
                )}
                data-slot="hire-rule"
                key={row.key}
              >
                <div className="flex items-center gap-3">
                  <span className="flex-1">{row.label}</span>
                  <select
                    aria-label={row.label}
                    className="h-8 rounded-[9px] border border-input bg-card px-2.5 text-foreground dark:bg-input/30"
                    data-slot="hire-select"
                    onChange={(event) =>
                      setRules((current) => ({
                        ...current,
                        [row.key]: event.target.value as AcpRuleValue,
                      }))
                    }
                    value={rules[row.key]}
                  >
                    {ruleChoices(row.key).map((value) => (
                      <option key={value} value={value}>
                        {RULE_VALUE_LABEL[value]}
                      </option>
                    ))}
                  </select>
                </div>
                {rules[row.key] === "direct" ? (
                  <Warning>{directWarning(row.key)}</Warning>
                ) : null}
              </li>
            ))}
          </ul>
          <div
            className="flex flex-col gap-2 rounded-xl bg-destructive/10 p-3.5"
            data-slot="hire-bottom-line"
          >
            <b className="text-destructive">底线：每次都交给你本人，不能关</b>
            <span className="text-[13px] leading-relaxed">{BOTTOM_LINE}</span>
          </div>
        </Section>
      </div>

      {custom ? (
        <label
          className="flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-[13px] leading-relaxed"
          data-slot="hire-confirm"
        >
          <input
            checked={acknowledged}
            className="mt-[3px] size-4 shrink-0 accent-primary"
            onChange={(event) => setAcknowledged(event.target.checked)}
            type="checkbox"
          />
          <span>
            我知道：这个智能体可能从不请求许可，{shortName()}
            拦不住它的动作。仍然招它进来。
          </span>
        </label>
      ) : null}

      {hire.error ? (
        <p className="m-0 text-[13px] text-destructive" role="alert">
          {hire.error.message}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-[1_1_300px] text-[13px] text-muted-foreground">
          招进来后它会出现在通讯录、可以拉进群组；电脑关机时它的活会排队，开机后自动继续。
        </span>
        {onCancel ? (
          <Button
            className="h-10 px-[18px]"
            onClick={onCancel}
            variant="outline"
          >
            取消
          </Button>
        ) : null}
        <Button
          className="h-10 px-[22px] font-semibold"
          data-hire-primary=""
          disabled={!ready || hire.isPending}
          type="submit"
        >
          {hire.isPending ? "正在招…" : "招进来"}
        </Button>
      </div>
    </form>
  );
}
