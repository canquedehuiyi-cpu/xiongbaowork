import { IconAlertTriangle, IconChevronLeft } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { NoPermissionWarning } from "@/components/agents/external/external-marks";
import {
  HarnessTile,
  harnessAbout,
} from "@/components/agents/external/hire-from-computer";
import { QueryError } from "@/components/layout/query-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ACP_RULE_DEFAULTS,
  type AcpHarness,
  type AcpRuleKey,
  type AcpRuleValue,
  deviceStanding,
  discoveryQueryOptions,
  type ExternalEdit,
  externalHarnessName,
  HARNESS_LABEL,
  hireExternalMutationOptions,
  RULE_ROWS,
  RULE_VALUE_LABEL,
  ruleChoices,
  updateExternalMutationOptions,
} from "@/lib/agents/external";
import { DEPARTMENT_MAX_CHARACTERS } from "@/lib/agents/form";
import { agentListQueryOptions, type ExternalRun } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { shortName } from "@/lib/brand";
import { devicesQueryOptions } from "@/lib/devices/queries";
import { cn } from "@/lib/utils";

/**
 * 招聘设置（外部员工 Task 10，设计稿第 2 屏）：名字、部门、工作文件夹（只列这台电脑共享的文件夹，传
 * `fld_…` 引用）、汇报说明；「哪些事要先问你」五项规则，默认值按规格；三条底线固定显示、不能关。
 *
 * - 用户把一项改成「直接做」（不是这一项的默认值时），那一行下面写清楚这意味着什么；「运行命令」尤其：
 *   命令行上的付款、删除、外发熊宝尽量认出来，但拦不全。「改工作文件夹里的文件」默认就是直接做，不提示。
 * - 工作文件夹和本机智能体都不默认选，第一项是「请选择…」，没选不能招。
 * - 打开时再问一次那台电脑：离线、这一家没装或接不上，就写明白并且不能招（地址可以直接打开这一页）。
 * - 招 Hermes 时写明：它有自己的智能审批，不能保证每个动作都先请求许可。
 * - 手动添加（`custom`）：选桌面端登记的本机程序（`app_…`），并要再勾一次「我知道它可能从不请求许可」
 *   才能招（规格第 4 节）。设备上报的本机程序没有标记哪些支持开放协议（`DeviceApp` 只有 ref 和名字），
 *   所以这里列的是全部登记的本机程序，由用户自己挑支持开放协议的那个。
 * - 日报那一项等日报上线再显示；「做完一件事就交付并上看板」是现有行为，只写说明，不是开关。
 *
 * 编辑态（`editing`，外部员工 Task 11：名片和员工设置里的「配置」）：同一张表，填好它现在的名字、部门、
 * 工作文件夹和五项规则，多一个「电脑」可以换到本人配对的另一台电脑（换了要重新选工作文件夹）；保存走
 * `PATCH /api/agents/external/:id`，换不了是哪一家。改规则不用电脑在线（服务器只在换电脑、换文件夹时对照
 * 电脑上报的文件夹），所以编辑态不去问电脑、电脑离线也能存；本机智能体招聘时确认过，不再要勾。
 */

/** 名字最长 40 个字，和服务器一样。 */
const NAME_MAX = 40;

/** 底线文案：比设计稿的「删除整个文件夹」更严，和现有员工一致（规格第 4 节）。 */
export const BOTTOM_LINE = "付款和下单 · 删除文件 · 对外发消息或邮件";

/** 用户把一项改成「直接做」时那一行下面的话（默认就是直接做的那一项不提示）。 */
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

/** 编辑态要的：这位外部员工现在的样子。 */
export type HireEditing = {
  agentId: string;
  name: string;
  department: string | null;
  external: ExternalRun;
};

export function HireSettings({
  deviceId: initialDeviceId,
  harness,
  onHired,
  onCancel,
  editing,
}: {
  deviceId: string;
  harness: AcpHarness;
  /** 招到了（编辑态：存好了），带着这位员工的 id。 */
  onHired: (agentId: string) => void;
  /** 「返回」「取消」：回到「从我的电脑招」（编辑态：回到员工设置）。 */
  onCancel?: () => void;
  /** 有它就是编辑态，表单从它填起。 */
  editing?: HireEditing;
}) {
  const queryClient = useQueryClient();
  const devices = useQuery(devicesQueryOptions());
  const me = useQuery(currentUserQueryOptions()).data?.id;
  const agents = useQuery(agentListQueryOptions());
  const hire = useMutation(hireExternalMutationOptions(queryClient));
  const update = useMutation(updateExternalMutationOptions(queryClient));
  const save = editing ? update : hire;
  const ids = useId();

  const [deviceId, setDeviceId] = useState(initialDeviceId);
  const device = devices.data?.find((row) => row.deviceId === deviceId);
  const roots = device?.roots ?? [];
  const apps = device?.apps ?? [];
  const custom = harness === "custom";
  /** 能换到的电脑：本人配对的那些。 */
  const ownDevices = (devices.data ?? []).filter(
    (row) => deviceStanding(row, me) === "mine",
  );

  const [name, setName] = useState<string | null>(editing?.name ?? null);
  const [department, setDepartment] = useState(editing?.department ?? "");
  const [workdirRef, setWorkdirRef] = useState<string | null>(
    editing?.external.workdirRef ?? null,
  );
  const [appRef, setAppRef] = useState<string | null>(
    editing?.external.appRef ?? null,
  );
  const [rules, setRules] = useState<Record<AcpRuleKey, AcpRuleValue>>(
    editing?.external.rules ?? ACP_RULE_DEFAULTS,
  );
  const [acknowledged, setAcknowledged] = useState(false);

  // 工作文件夹和本机程序必须本人选；名字没动过就用这家的名字。
  const chosenWorkdir =
    workdirRef && roots.some((root) => root.ref === workdirRef)
      ? workdirRef
      : "";
  const chosenApp =
    appRef && apps.some((app) => app.ref === appRef) ? appRef : "";
  const appName = apps.find((app) => app.ref === chosenApp)?.name;
  const label =
    harness === "custom"
      ? (appName ??
        (editing ? externalHarnessName(editing.external) : "本机智能体"))
      : HARNESS_LABEL[harness];
  const chosenName = name ?? label;

  const mine = !!device && deviceStanding(device, me) === "mine";
  const discovery = useQuery({
    ...discoveryQueryOptions(deviceId),
    enabled: !editing && mine && !!device?.online && !custom,
  });

  const back = onCancel ? (
    <button
      className="inline-flex w-fit items-center gap-0.5 text-[14px] text-muted-foreground hover:text-foreground"
      data-slot="hire-back"
      onClick={onCancel}
      type="button"
    >
      <IconChevronLeft aria-hidden="true" className="size-4" />
      返回
    </button>
  ) : null;

  if (devices.isError && !devices.data)
    return (
      <div className="flex flex-col gap-3">
        {back}
        <QueryError
          error={devices.error}
          label="读不到你的电脑"
          onRetry={() => void devices.refetch()}
          retrying={devices.isFetching}
        />
      </div>
    );
  if (devices.isPending)
    return (
      <p className="text-[13px] text-muted-foreground" role="status">
        正在读这台电脑…
      </p>
    );
  // 编辑态里原来那台电脑不在了、或者不再是本人的，可以换一台，不挡在这里。
  if (!editing && (!device || deviceStanding(device, me) !== "mine"))
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
  /** 为什么现在不能招；null 是能招。编辑态不问电脑：改规则不用电脑在线。 */
  const discovered =
    harness === "custom"
      ? undefined
      : discovery.data?.agents.find((agent) => agent.harness === harness);
  const blocker: string | null = editing
    ? null
    : !device?.online
      ? `电脑离线：打开这台电脑、让${shortName()}桌面端连上后再招。`
      : custom
        ? null
        : discovery.isError && !discovery.data
          ? null
          : !discovery.data
            ? "正在确认这台电脑上的情况…"
            : !discovery.data.online
              ? `电脑离线：打开这台电脑、让${shortName()}桌面端连上后再招。`
              : !discovered?.installed
                ? `这台电脑上还没装 ${label}，装好后再招。`
                : !discovered.acpReady
                  ? `这台电脑上的 ${label} 还接不上，回到上一页看怎么处理。`
                  : null;
  const checkFailed =
    !editing && !custom && discovery.isError && !discovery.data;
  const ready =
    !blocker &&
    !checkFailed &&
    !!device &&
    mine &&
    trimmedName.length > 0 &&
    [...trimmedName].length <= NAME_MAX &&
    [...trimmedDepartment].length <= DEPARTMENT_MAX_CHARACTERS &&
    !!chosenWorkdir &&
    (!custom || (!!chosenApp && (acknowledged || !!editing)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || save.isPending || !device) return;
    if (editing) {
      const before = editing.external;
      // 只送变了的电脑、文件夹和本机智能体：只改规则时服务器不必再对照电脑上报的文件夹。
      const input: ExternalEdit = {
        name: trimmedName,
        department: trimmedDepartment,
        ...(device.deviceId !== before.deviceId
          ? { deviceId: device.deviceId }
          : {}),
        ...(chosenWorkdir !== before.workdirRef
          ? { workdirRef: chosenWorkdir }
          : {}),
        ...(custom && chosenApp !== before.appRef ? { appRef: chosenApp } : {}),
        rules,
      };
      update.mutate(
        { agentId: editing.agentId, input },
        { onSuccess: (agent) => onHired(agent.id) },
      );
      return;
    }
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
      aria-label={editing ? `改 ${editing.name} 的配置` : `把 ${label} 招进来`}
      className="flex flex-col gap-6"
      data-slot="hire-settings"
      onSubmit={submit}
    >
      {back}
      <div className="-mt-3 flex items-center gap-4">
        <HarnessTile harness={harness} name={label} size="lg" />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="m-0 font-semibold text-[22px]">
            {editing ? `改 ${editing.name} 的配置` : `把 ${label} 招进来`}
          </h2>
          <span className="text-muted-foreground">
            {device ? `在 ${device.name} 上干活 · ` : ""}
            {subtitle}
          </span>
        </div>
      </div>

      {checkFailed ? (
        <QueryError
          error={discovery.error}
          label="读不到这台电脑上的智能体"
          onRetry={() => void discovery.refetch()}
          retrying={discovery.isFetching}
        />
      ) : blocker ? (
        <p
          className="m-0 rounded-xl border border-border bg-card p-3.5 text-[13px] text-muted-foreground"
          data-slot="hire-notice"
          role="status"
        >
          {blocker}
        </p>
      ) : null}

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
              maxLength={DEPARTMENT_MAX_CHARACTERS}
              onChange={(event) => setDepartment(event.target.value)}
              placeholder="未分组"
              value={department}
            />
            <datalist id={`${ids}-departments`}>
              {departments.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
            <span className="text-[12px] text-muted-foreground">
              不填就是未分组；最多 {DEPARTMENT_MAX_CHARACTERS} 个字。
            </span>
          </div>
          {editing ? (
            <div className="flex flex-col gap-1.5">
              <label
                className="text-[13px] text-muted-foreground"
                htmlFor={`${ids}-device`}
              >
                电脑
              </label>
              <select
                className={fieldClass}
                data-slot="hire-select"
                id={`${ids}-device`}
                onChange={(event) => {
                  setDeviceId(event.target.value);
                  // 换了电脑，文件夹和本机程序都是那台电脑上的，要重新选。
                  setWorkdirRef(null);
                  setAppRef(null);
                }}
                value={mine ? deviceId : ""}
              >
                <option disabled value="">
                  请选择…
                </option>
                {ownDevices.map((row) => (
                  <option key={row.deviceId} value={row.deviceId}>
                    {row.online ? row.name : `${row.name}（离线）`}
                  </option>
                ))}
              </select>
              <span className="text-[12px] text-muted-foreground">
                只能换到你自己配对的电脑；换了电脑要重新选工作文件夹。
              </span>
            </div>
          ) : null}
          {custom ? (
            <div className="flex flex-col gap-1.5">
              <label
                className="text-[13px] text-muted-foreground"
                htmlFor={`${ids}-app`}
              >
                本机程序
              </label>
              {apps.length > 0 ? (
                <select
                  className={fieldClass}
                  data-slot="hire-select"
                  id={`${ids}-app`}
                  onChange={(event) => setAppRef(event.target.value)}
                  value={chosenApp}
                >
                  <option disabled value="">
                    请选择…
                  </option>
                  {apps.map((app) => (
                    <option key={app.ref} value={app.ref}>
                      {app.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="m-0 text-[13px] text-muted-foreground">
                  这台电脑还没有登记本机程序。先在桌面端登记它的启动命令，再回来招。
                </p>
              )}
              <span className="text-[12px] text-muted-foreground">
                选一个支持开放协议的智能体启动程序。这里列的是桌面端登记的全部本机程序，
                {shortName()}
                分不出哪些支持开放协议；启动命令只存在这台电脑上。
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
                <option disabled value="">
                  请选择…
                </option>
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
                {rules[row.key] === "direct" &&
                ACP_RULE_DEFAULTS[row.key] !== "direct" ? (
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

      {custom && editing ? <NoPermissionWarning /> : null}
      {custom && !editing ? (
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

      {save.error ? (
        <p className="m-0 text-[13px] text-destructive" role="alert">
          {save.error.message}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-[1_1_300px] text-[13px] text-muted-foreground">
          {editing
            ? "换不了它是哪个智能体；要用别的，请重新招一位。"
            : "招进来后它会出现在通讯录、可以拉进群组；电脑关机时它的活会排队，开机后自动继续。"}
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
          disabled={!ready || save.isPending}
          type="submit"
        >
          {editing
            ? update.isPending
              ? "正在保存…"
              : "保存"
            : hire.isPending
              ? "正在招…"
              : "招进来"}
        </Button>
      </div>
    </form>
  );
}
