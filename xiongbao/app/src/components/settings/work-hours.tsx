import { IconClockHour9 } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { browserTimeZone } from "@/lib/routines/form";
import { useUserPreferences } from "@/lib/settings/message-list";
import {
  DEFAULT_WORK_HOURS,
  isWorkStretch,
  type PreferencesWithWorkHours,
  sameClock,
  saveWorkHoursMutationOptions,
  type WorkHours,
  zoneLongName,
} from "@/lib/settings/work-hours";

/*
 * 「作息」（交付闭环规格第 10 节）：在「我」→ 通知里。开工、收工时各推一次清点；作息外不推送提醒、也不催
 * 员工，攒到下一次开工清点。时区第一次由浏览器写入（登录后的外壳里，`useTellBrowserTimeZone`），这里可以改。
 *
 * 这一页在每个皮肤里都画（设置页是共用的），只用应用自己的组件和令牌。
 */

/** 下拉里可选的时区：这个浏览器认得的全部，加上已存的和浏览器的（老浏览器给不出清单时只有这两个）。 */
function zoneChoices(saved: string, browser: string): string[] {
  let all: string[] = [];
  try {
    all =
      (
        Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
      ).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    all = [];
  }
  return [...new Set([saved, browser, ...all])].filter(Boolean);
}

/** 时区的说法：「中国标准时间」，认不出时写原名。 */
const zoneName = (zone: string) => zoneLongName(zone) ?? zone;

export function WorkHoursSection() {
  const preferences = useUserPreferences();
  const queryClient = useQueryClient();
  const userId = preferences.userId;
  const save = useMutation(saveWorkHoursMutationOptions(queryClient, userId));
  const saved = (preferences.data as PreferencesWithWorkHours | undefined)
    ?.workHours;
  const browser = browserTimeZone();

  return (
    <PageSection
      description="开工和收工时各发你一次清点：还有几件没收、几件等你验收、有没有逾期。作息外不推送提醒，也不催员工，提醒攒到下一次开工清点。没有在跟的活就不发。"
      title="作息"
    >
      {preferences.isPending ? null : preferences.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          读不到你的作息。请刷新页面。
        </p>
      ) : (
        <WorkHoursForm
          browser={browser}
          error={save.error}
          onSave={(next) => save.mutate({ workHours: next })}
          pending={save.isPending}
          saved={
            saved ?? {
              ...DEFAULT_WORK_HOURS,
              timeZone: browser,
            }
          }
          succeeded={save.isSuccess}
        />
      )}
    </PageSection>
  );
}

function WorkHoursForm({
  saved,
  browser,
  onSave,
  pending,
  succeeded,
  error,
}: {
  saved: WorkHours;
  browser: string;
  onSave: (next: Partial<WorkHours>) => void;
  pending: boolean;
  succeeded: boolean;
  error: Error | null;
}) {
  const [start, setStart] = useState(saved.start);
  const [end, setEnd] = useState(saved.end);
  const [timeZone, setTimeZone] = useState(saved.timeZone);
  const [weekends, setWeekends] = useState(saved.weekends);
  const [mistake, setMistake] = useState<string | null>(null);
  /*
   * 服务器那份变了（保存回来、或登录时记下了浏览器时区）：没动过的那几项跟着换成新的，正在改的那几项留着你
   * 填的，不重挂表单、不冲掉输入。
   */
  const [shown, setShown] = useState(saved);
  if (shown !== saved) {
    setShown(saved);
    if (start === shown.start) setStart(saved.start);
    if (end === shown.end) setEnd(saved.end);
    if (timeZone === shown.timeZone) setTimeZone(saved.timeZone);
    if (weekends === shown.weekends) setWeekends(saved.weekends);
  }
  // 下拉里写中文长名，后面带上地名（同一个长名下有很多地方，比如好几处都是「中国标准时间」）。
  const [zones] = useState(() =>
    zoneChoices(saved.timeZone, browser).map((zone) => {
      const name = zoneLongName(zone);
      return { zone, label: name ? `${name}（${zone}）` : zone };
    }),
  );
  const zoneId = useId();
  const dirty =
    start !== saved.start ||
    end !== saved.end ||
    timeZone !== saved.timeZone ||
    weekends !== saved.weekends;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!isWorkStretch(start, end)) {
      setMistake("开工时间要早于收工时间（同一天内）。");
      return;
    }
    setMistake(null);
    const next: Partial<WorkHours> = {};
    if (start !== saved.start) next.start = start;
    if (end !== saved.end) next.end = end;
    if (timeZone !== saved.timeZone) next.timeZone = timeZone;
    if (weekends !== saved.weekends) next.weekends = weekends;
    onSave(next);
  };

  return (
    <form aria-label="作息" onSubmit={submit}>
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconClockHour9 />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>开工与收工</ItemTitle>
            <ItemDescription data-testid="work-hours-now">
              现在：{saved.weekends ? "每天" : "工作日"} {saved.start}–
              {saved.end}，按{zoneName(saved.timeZone)}。
            </ItemDescription>
          </ItemContent>
          <ItemActions className="flex-wrap gap-2">
            <Input
              aria-label="开工时间"
              className="w-36"
              onChange={(event) => setStart(event.target.value)}
              required
              step={300}
              type="time"
              value={start}
            />
            <span aria-hidden="true" className="text-muted-foreground">
              –
            </span>
            <Input
              aria-label="收工时间"
              className="w-36"
              onChange={(event) => setEnd(event.target.value)}
              required
              step={300}
              type="time"
              value={end}
            />
          </ItemActions>
        </Item>
        <Item size="sm">
          <ItemContent>
            <ItemTitle>
              <label htmlFor={zoneId}>时区</label>
            </ItemTitle>
            <ItemDescription>
              {zoneName(timeZone)}。
              {sameClock(timeZone, browser)
                ? "和这台设备的时区一样。"
                : `这台设备在${zoneName(browser)}。`}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <select
              className="h-9 w-full min-w-0 max-w-[14rem] rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              id={zoneId}
              onChange={(event) => setTimeZone(event.target.value)}
              value={timeZone}
            >
              {zones.map(({ zone, label }) => (
                <option key={zone} value={zone}>
                  {label}
                </option>
              ))}
            </select>
          </ItemActions>
        </Item>
        <Item size="sm">
          <ItemContent>
            <ItemTitle>周末也发</ItemTitle>
            <ItemDescription>
              {weekends
                ? "周六、周日也按这个时间发清点、推提醒。"
                : "周六、周日不发清点，也不推提醒。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label="周末也发"
              checked={weekends}
              onCheckedChange={(next) => setWeekends(next)}
            />
          </ItemActions>
        </Item>
      </PageRows>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button disabled={!dirty || pending} size="sm" type="submit">
          {pending ? "正在保存…" : "保存作息"}
        </Button>
        {succeeded && !dirty ? (
          <span className="text-muted-foreground text-sm" role="status">
            已保存。
          </span>
        ) : null}
      </div>
      {mistake ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {mistake}
        </p>
      ) : error ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {/[\u4e00-\u9fff]/.test(error.message)
            ? error.message
            : "作息没能保存，请稍后再试。"}
        </p>
      ) : null}
    </form>
  );
}
