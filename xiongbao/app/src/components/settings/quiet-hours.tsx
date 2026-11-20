import { IconMoon } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
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
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  type QuietHoursSetting,
  quietHoursQueryOptions,
  saveQuietHoursMutationOptions,
} from "@/lib/settings/quiet-hours";
import { zoneLongName } from "@/lib/settings/work-hours";

/**
 * 「安静时段」：这段时间里员工不主动找你，也不给你推送，攒到结束再做、再发。开关立即生效，起止时间点保存。
 * 时区用作息里的那个，在上面的「作息」里改。
 */
export function QuietHoursSection() {
  const queryClient = useQueryClient();
  const userId = useQuery(currentUserQueryOptions()).data?.id;
  const quiet = useQuery(quietHoursQueryOptions(userId));
  const save = useMutation(saveQuietHoursMutationOptions(queryClient, userId));
  return (
    <PageSection
      description="这段时间里员工不会主动找你，也不会给你推送，攒到结束再做、再发。你自己设好的例行任务照常运行。"
      title="安静时段"
    >
      {quiet.isPending ? null : quiet.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          读不到你的安静时段。请刷新页面。
        </p>
      ) : (
        <QuietHoursForm
          error={save.error}
          onSave={(patch) => save.mutate(patch)}
          pending={save.isPending}
          saved={quiet.data}
          succeeded={save.isSuccess}
        />
      )}
    </PageSection>
  );
}

function QuietHoursForm({
  saved,
  onSave,
  pending,
  succeeded,
  error,
}: {
  saved: QuietHoursSetting;
  onSave: (patch: Partial<QuietHoursSetting>) => void;
  pending: boolean;
  succeeded: boolean;
  error: Error | null;
}) {
  const [start, setStart] = useState(saved.start);
  const [end, setEnd] = useState(saved.end);
  const [mistake, setMistake] = useState<string | null>(null);
  // 服务器那份变了：没动过的那项跟着换，正在改的留着你填的。
  const [shown, setShown] = useState(saved);
  if (shown !== saved) {
    setShown(saved);
    if (start === shown.start) setStart(saved.start);
    if (end === shown.end) setEnd(saved.end);
  }
  const dirty = start !== saved.start || end !== saved.end;
  const zone = saved.timeZone
    ? (zoneLongName(saved.timeZone) ?? saved.timeZone)
    : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (start === end) {
      setMistake("开始和结束不能是同一时刻。不想要安静时段，就把开关关掉。");
      return;
    }
    setMistake(null);
    const patch: Partial<QuietHoursSetting> = {};
    if (start !== saved.start) patch.start = start;
    if (end !== saved.end) patch.end = end;
    onSave(patch);
  };

  return (
    <form aria-label="安静时段" onSubmit={submit}>
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconMoon />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>开启安静时段</ItemTitle>
            <ItemDescription>
              {saved.enabled
                ? "现在开着：员工在这段时间里不主动找你。"
                : "现在关着：员工随时可能主动找你。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label="开启安静时段"
              checked={saved.enabled}
              disabled={pending}
              onCheckedChange={(next) => onSave({ enabled: next })}
            />
          </ItemActions>
        </Item>
        <Item size="sm">
          <ItemContent>
            <ItemTitle>起止时间</ItemTitle>
            <ItemDescription data-testid="quiet-hours-now">
              {zone
                ? `每天 ${saved.start} 到次日 ${saved.end}，按${zone}。`
                : `每天 ${saved.start} 到次日 ${saved.end}。`}
            </ItemDescription>
          </ItemContent>
          <ItemActions className="flex-wrap gap-2">
            <Input
              aria-label="安静时段开始"
              className="w-36"
              disabled={!saved.enabled}
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
              aria-label="安静时段结束"
              className="w-36"
              disabled={!saved.enabled}
              onChange={(event) => setEnd(event.target.value)}
              required
              step={300}
              type="time"
              value={end}
            />
          </ItemActions>
        </Item>
      </PageRows>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          disabled={!dirty || pending || !saved.enabled}
          size="sm"
          type="submit"
        >
          {pending ? "正在保存…" : "保存安静时段"}
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
          {/[一-鿿]/.test(error.message)
            ? error.message
            : "安静时段没能保存，请稍后再试。"}
        </p>
      ) : null}
    </form>
  );
}
