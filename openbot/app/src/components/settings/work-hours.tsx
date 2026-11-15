import { IconClockHour9 } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
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
  saveWorkHoursMutationOptions,
  type WorkHours,
} from "@/lib/settings/work-hours";

/*
 * 「作息」（交付闭环规格第 10 节）：在「我」→ 通知里。开工、收工时各推一次清点；作息外不推送提醒、也不催
 * 员工，攒到下一次开工清点。时区第一次由浏览器写入：打开这一段时把浏览器的时区告诉服务器，服务器只在还没
 * 存过时区时记下它，存过的（你自己选的）不改。
 *
 * 这一页在每个皮肤里都画（设置页是共用的），只用应用自己的组件和令牌。
 */

/** 这次打开页面里已经把浏览器时区告诉过服务器的人：同一个人不重复写。 */
const toldBrowserZone = new Set<string>();

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

/** 时区的中文长名，如「中国标准时间」；认不出时没有。 */
function zoneLongName(zone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: zone,
      timeZoneName: "long",
    })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value;
  } catch {
    return undefined;
  }
}

export function WorkHoursSection() {
  const preferences = useUserPreferences();
  const queryClient = useQueryClient();
  const userId = preferences.userId;
  const save = useMutation(saveWorkHoursMutationOptions(queryClient, userId));
  const tell = useMutation(saveWorkHoursMutationOptions(queryClient, userId));
  const saved = (preferences.data as PreferencesWithWorkHours | undefined)
    ?.workHours;
  const browser = browserTimeZone();

  // 第一次打开：把浏览器的时区告诉服务器（它只填空，不盖掉已存的）。
  const tellMutate = tell.mutate;
  useEffect(() => {
    if (!userId || !preferences.data || toldBrowserZone.has(userId)) return;
    toldBrowserZone.add(userId);
    tellMutate({ browserTimeZone: browser });
  }, [userId, preferences.data, browser, tellMutate]);

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
          key={saved ? JSON.stringify(saved) : "default"}
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
  const zones = useRef(zoneChoices(saved.timeZone, browser)).current;
  const zoneId = useId();
  const dirty =
    start !== saved.start ||
    end !== saved.end ||
    timeZone !== saved.timeZone ||
    weekends !== saved.weekends;
  const longName = zoneLongName(timeZone);

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
              {saved.end}，按 {saved.timeZone} 的时间。
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
              {longName ? `${longName}。` : ""}
              {timeZone === browser
                ? "和这台设备的时区一样。"
                : `这台设备在 ${browser}。`}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <select
              className="h-9 w-full min-w-0 max-w-[14rem] rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              id={zoneId}
              onChange={(event) => setTimeZone(event.target.value)}
              value={timeZone}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
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
