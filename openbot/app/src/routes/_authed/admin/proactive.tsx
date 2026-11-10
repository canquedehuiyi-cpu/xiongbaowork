import {
  IconBellRinging,
  IconChevronRight,
  IconGauge,
  IconRadar,
} from "@tabler/icons-react";
import {
  keepPreviousData,
  type UseQueryResult,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  setCapabilityMutationOptions,
  setEnterpriseSettingMutationOptions,
} from "@/lib/enterprise/mutations";
import {
  type BotCheckInMetrics,
  type CheckInMetrics,
  type CheckInSkipReason,
  checkInMetricsQueryOptions,
  type EnterpriseOverview,
  enterpriseOverviewQueryOptions,
} from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/proactive")({
  component: CheckInsPage,
});

type Days = CheckInMetrics["days"];

const PERIODS: Record<Days, string> = {
  7: "最近 7 天",
  30: "最近 30 天",
};

/** Why check-ins were skipped, in the order the page lists them. */
const SKIPPED_BECAUSE: Record<CheckInSkipReason, string> = {
  off_admin: "被管理员关闭",
  off_person: "被本人关闭",
  paused: "员工已暂停",
  capped: "超出每日上限",
  no_sources: "没有可读的内容",
  unreachable: "对话已不存在",
  busy: "上一次还在运行",
};

/** A count as people read it, with the thousands separated. */
const number = (count: number) => count.toLocaleString();

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** Check-ins that reached the model, whatever they found. */
const ran = (bot: BotCheckInMetrics) =>
  bot.runs.quiet + bot.runs.raised + bot.runs.failed;

const skipped = (bot: BotCheckInMetrics) =>
  Object.values(bot.runs.skipped).reduce((sum, count) => sum + count, 0);

/**
 * Admin, Check-ins: the switch and the daily limit, then how each Bot's check-ins went.
 *
 * The switch is the same "Check-ins" capability Permissions lists, at the organization's
 * scope; roles and groups are set there. The numbers are counts only: the server sends no titles
 * and no people, because what a check-in raised came from somebody's own apps.
 */
export function CheckInsPage() {
  const overview = useQuery(enterpriseOverviewQueryOptions());
  const [days, setDays] = useState<Days>(7);
  /*
   * The previous window's numbers stay up while the other loads, so switching between 7 and 30 days
   * changes the figures in place instead of emptying the section.
   */
  const metrics = useQuery({
    ...checkInMetricsQueryOptions(days),
    placeholderData: keepPreviousData,
  });

  return (
    <PageShell
      description="员工会查看大家连接的应用，有需要处理的事就告诉本人，最多每小时一次。没经过同意，员工不会动手。"
      title="主动巡检"
    >
      {overview.isPending ? null : overview.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          读不到主动巡检设置。请刷新页面。
        </p>
      ) : (
        <CheckInSettings data={overview.data} />
      )}
      <Activity days={days} metrics={metrics} onDays={setDays} />
    </PageShell>
  );
}

function CheckInSettings({ data }: { data: EnterpriseOverview }) {
  const setCapability = useMutation(setCapabilityMutationOptions(queryClient));
  const setSetting = useMutation(
    setEnterpriseSettingMutationOptions(queryClient),
  );
  const [limitOpen, setLimitOpen] = useState(false);
  const capability = data.capabilities.find(
    (row) => row.capability === "proactive",
  );
  const on = capability
    ? (capability.organization ?? capability.default)
    : true;
  const overrides = capability
    ? Object.keys(capability.roles).length +
      Object.keys(capability.groups).length
    : 0;
  const saving = setCapability.isPending || setSetting.isPending;
  const failure = setCapability.error ?? setSetting.error;

  return (
    <PageSection
      description={
        <>
          这些设置对所有人生效。要按角色或用户组调整谁能用主动巡检，请到
          <Link className="underline" to="/admin/permissions">
            权限
          </Link>
          页面。
        </>
      }
      title="设置"
    >
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconRadar />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>主动巡检</ItemTitle>
            <ItemDescription>
              {on
                ? "员工为所有人做主动巡检。"
                : "已关闭。员工不会为任何人做主动巡检。"}
              {overrides > 0
                ? `有 ${number(overrides)} 条按角色或用户组的例外设置，对部分人另有规定。`
                : ""}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label="主动巡检"
              checked={on}
              disabled={saving}
              onCheckedChange={(checked) =>
                setCapability.mutate({
                  scopeKind: "organization",
                  scopeId: "",
                  capability: "proactive",
                  allowed: checked,
                })
              }
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item
          render={<button onClick={() => setLimitOpen(true)} type="button" />}
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconGauge />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>每日上限</ItemTitle>
            <ItemDescription>
              {`每位员工每天为每个人最多巡检 ${number(data.settings.proactiveDailyRuns)} 次`}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
      {failure ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : null}
      <DailyLimitDialog
        initial={data.settings.proactiveDailyRuns}
        onClose={() => setLimitOpen(false)}
        onSave={(value) =>
          setSetting.mutate(
            { key: "proactiveDailyRuns", value },
            { onSuccess: () => setLimitOpen(false) },
          )
        }
        open={limitOpen}
        saving={setSetting.isPending}
      />
    </PageSection>
  );
}

function Activity({
  days,
  metrics,
  onDays,
}: {
  days: Days;
  metrics: UseQueryResult<CheckInMetrics>;
  onDays: (days: Days) => void;
}) {
  const [openBot, setOpenBot] = useState<string | undefined>();
  const bot = metrics.data?.bots.find((row) => row.agentId === openBot);

  return (
    <PageSection
      action={
        <Select
          onValueChange={(value) => onDays(Number(value) === 30 ? 30 : 7)}
          value={String(days)}
        >
          <SelectTrigger aria-label="时间范围" size="sm">
            <SelectValue>{PERIODS[days]}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            <SelectGroup>
              <SelectItem value="7">{PERIODS[7]}</SelectItem>
              <SelectItem value="30">{PERIODS[30]}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      }
      description="采纳率是大家开始处理的事项，占开始处理和隐藏的事项总数的比例。"
      title="动态"
    >
      {metrics.isPending ? null : metrics.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          读不到主动巡检动态。请刷新页面。
        </p>
      ) : (
        <>
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconBellRinging />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>已发送的提醒</ItemTitle>
                <ItemDescription>
                  {metrics.data.pings.itemsPerPing === null
                    ? "每条提醒会把所有员工给同一个人的待办事项合并成一条消息。"
                    : `平均每条含 ${metrics.data.pings.itemsPerPing.toFixed(1)} 项`}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <span className="text-sm tabular-nums">
                  {number(metrics.data.pings.sent)}
                </span>
              </ItemActions>
            </Item>
          </PageRows>
          {metrics.data.bots.length === 0 ? (
            <PageEmpty icon={IconRadar} title="还没有巡检">
              有人和员工对话之后，它就会开始巡检。
            </PageEmpty>
          ) : (
            <PageRows>
              {metrics.data.bots.map((row, index) => (
                <Fragment key={row.agentId}>
                  {index > 0 ? <Separator /> : null}
                  <BotRow bot={row} onOpen={() => setOpenBot(row.agentId)} />
                </Fragment>
              ))}
            </PageRows>
          )}
        </>
      )}
      {bot ? (
        <BotDialog
          bot={bot}
          days={days}
          onClose={() => setOpenBot(undefined)}
        />
      ) : null}
    </PageSection>
  );
}

function BotRow({
  bot,
  onOpen,
}: {
  bot: BotCheckInMetrics;
  onOpen: () => void;
}) {
  return (
    <Item render={<button onClick={onOpen} type="button" />} size="sm">
      <ItemMedia>
        <AbstractAvatar name={bot.name} seed={bot.avatarSeed} size={28} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{bot.name}</ItemTitle>
        <ItemDescription>
          {[
            `${number(bot.peopleOn)} 人`,
            `巡检 ${number(ran(bot))} 次`,
            `${number(bot.items.raised)} 项`,
          ].join(" · ")}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {bot.acceptance === null ? (
          <span className="text-muted-foreground text-sm">还没有反馈</span>
        ) : (
          <span className="text-sm tabular-nums">
            已开始 {percent(bot.acceptance)}
          </span>
        )}
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

/** One Bot's whole breakdown for the window. */
function BotDialog({
  bot,
  days,
  onClose,
}: {
  bot: BotCheckInMetrics;
  days: Days;
  onClose: () => void;
}) {
  const reasons = (Object.keys(SKIPPED_BECAUSE) as CheckInSkipReason[]).filter(
    (reason) => bot.runs.skipped[reason] > 0,
  );
  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <AbstractAvatar name={bot.name} seed={bot.avatarSeed} size={32} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <DialogTitle>{bot.name}</DialogTitle>
              <DialogDescription>
                {`${PERIODS[days]}。目前有 ${bot.peopleOn} 人开着主动巡检。`}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogBody className="mt-4 gap-6 overflow-y-auto">
          <div className="grid grid-cols-3 gap-4">
            <Stat
              label="采纳率"
              value={bot.acceptance === null ? "暂无" : percent(bot.acceptance)}
            />
            <Stat label="提出的事项" value={number(bot.items.raised)} />
            <Stat label="随提醒发出" value={number(bot.pinged)} />
          </div>
          <Breakdown
            rows={[
              ["没有发现", bot.runs.quiet],
              ["有所发现", bot.runs.raised],
              ["没能完成", bot.runs.failed],
              ["查看前就跳过", skipped(bot)],
              ...reasons.map(
                (reason) =>
                  [SKIPPED_BECAUSE[reason], bot.runs.skipped[reason], true] as [
                    string,
                    number,
                    boolean,
                  ],
              ),
            ]}
            title="主动巡检"
          />
          <Breakdown
            rows={[
              ["已开始", bot.items.started],
              ["已隐藏", bot.items.hidden],
              ["员工已清除", bot.items.cleared],
              ["仍待处理", bot.items.open],
            ]}
            title="事项"
          />
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button">
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-muted-foreground text-xs">{label}</p>
      <p className="mt-0.5 font-semibold text-xl tabular-nums">{value}</p>
    </div>
  );
}

/** A heading over label and count pairs. A third `true` indents a row under the one before it. */
function Breakdown({
  rows,
  title,
}: {
  rows: (readonly [string, number] | readonly [string, number, boolean])[];
  title: string;
}) {
  return (
    <section>
      <h3 className="font-medium text-sm">{title}</h3>
      <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([label, count, nested]) => (
          <Fragment key={label}>
            <dt
              className={
                nested
                  ? "truncate pl-4 text-muted-foreground"
                  : "truncate text-muted-foreground"
              }
            >
              {label}
            </dt>
            <dd className="text-right tabular-nums">{number(count)}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

function DailyLimitDialog({
  initial,
  onClose,
  onSave,
  open,
  saving,
}: {
  initial: number;
  onClose: () => void;
  onSave: (value: number) => void;
  open: boolean;
  saving: boolean;
}) {
  const [value, setValue] = useState(String(initial));
  const parsed = Number(value);
  const valid =
    value.trim() !== "" &&
    Number.isInteger(parsed) &&
    parsed >= 1 &&
    parsed <= 1440;
  return (
    <Dialog
      onOpenChange={(next) => (next ? setValue(String(initial)) : onClose())}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>每日上限</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 gap-2">
          <Label htmlFor="check-in-daily-limit">
            每位员工每天为每个人巡检的次数
          </Label>
          <Input
            id="check-in-daily-limit"
            inputMode="numeric"
            onChange={(event) => setValue(event.target.value)}
            value={value}
          />
          <p className="text-muted-foreground text-xs">
            24 就是每小时一次。跳过的巡检不计入。
          </p>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            取消
          </Button>
          <Button
            disabled={!valid || saving}
            onClick={() => onSave(parsed)}
            size="sm"
            type="button"
          >
            {saving ? "正在保存…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
