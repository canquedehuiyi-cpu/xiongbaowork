import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { conversationLabel } from "@/lib/channels/label";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  createProactiveSetting,
  type ProactiveSetting,
  proactiveKeys,
  proactiveSettingsQueryOptions,
  proactiveSuggestionsQueryOptions,
  removeProactiveSetting,
  resolveSuggestion,
  runProactiveNow,
  updateProactiveSetting,
} from "@/lib/proactive";
import { queryClient } from "@/query-client";

const field = "grid gap-1 text-sm";
const select = "h-9 rounded-md border bg-background px-3 text-sm";
const intervals = [
  { minutes: 60, label: "每小时" },
  { minutes: 240, label: "每 4 小时" },
  { minutes: 720, label: "每天两次" },
  { minutes: 1440, label: "每天一次" },
];
async function refresh() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: proactiveKeys.settings }),
    queryClient.invalidateQueries({ queryKey: proactiveKeys.suggestions }),
  ]);
}

/** Next steps a Bot proposed from background research: start one as a task, or dismiss it. */
export function SuggestionsInbox() {
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "start" | "dismiss" }) =>
      resolveSuggestion(id, action),
    onSuccess: refresh,
  });
  const botName = (id: string) =>
    bots.data?.find((bot) => bot.id === id)?.name ?? "你的员工";
  return (
    <section className="grid gap-3">
      <h2 className="font-semibold">建议的下一步</h2>
      {suggestions.isPending ? (
        <p>正在读取建议…</p>
      ) : suggestions.error ? (
        <p role="alert" className="text-destructive">
          {suggestions.error.message}
        </p>
      ) : suggestions.data?.length ? (
        suggestions.data.map((suggestion) => (
          <article
            key={suggestion.id}
            className="grid gap-2 rounded-lg border p-4"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <strong>{suggestion.title}</strong>
              <span className="text-xs text-muted-foreground">
                {botName(suggestion.agentId)} ·{" "}
                {new Date(suggestion.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="text-sm whitespace-pre-wrap">{suggestion.detail}</p>
            {(suggestion.sourceApp || suggestion.sourceLink) && (
              <p className="text-xs text-muted-foreground">
                来自 {suggestion.sourceApp ?? "已连接的应用"}
                {suggestion.sourceLink && (
                  <>
                    {" · "}
                    <a
                      className="underline"
                      href={suggestion.sourceLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看记录
                    </a>
                  </>
                )}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({ id: suggestion.id, action: "start" })
                }
              >
                转成任务
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({ id: suggestion.id, action: "dismiss" })
                }
              >
                忽略
              </Button>
            </div>
          </article>
        ))
      ) : (
        <p className="text-muted-foreground">
          现在还没有建议。开了后台调研的员工会把下一步建议写在这里。
        </p>
      )}
      {act.error && (
        <p role="alert" className="text-destructive">
          {act.error.message}
        </p>
      )}
    </section>
  );
}

/** Opt a Bot in to read-only background research of the apps it can already read. */
export function ProactiveResearchSettings() {
  const settings = useQuery(proactiveSettingsQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [agentId, setAgentId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [focus, setFocus] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(240);
  const id = useId();
  const eligibleChannels = (channels.data ?? []).filter(
    (channel) => channel.active && channel.agentIds.includes(agentId),
  );
  const add = useMutation({
    mutationFn: createProactiveSetting,
    onSuccess: async () => {
      setFocus("");
      await refresh();
    },
  });
  return (
    <section className="grid gap-3">
      <h2 className="font-semibold">后台调研</h2>
      <p className="text-sm text-muted-foreground">
        你开启一位员工后，它会翻阅自己已经读得到的应用，整理成待你复核的记忆，并给出下一步建议。
        它只能读：不能发消息、不能改动任何应用，也不使用浏览器或电脑。
      </p>
      <form
        className="grid gap-3 rounded-lg border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate({ agentId, channelId, focus, intervalMinutes });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={field}>
            员工
            <select
              required
              className={select}
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                setChannelId("");
              }}
            >
              <option value="">选一位员工</option>
              {bots.data?.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            建议送达到
            <select
              required
              className={select}
              value={channelId}
              onChange={(event) => setChannelId(event.target.value)}
            >
              <option value="">选一个频道</option>
              {eligibleChannels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {conversationLabel(channel)}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            调研频率
            <select
              className={select}
              value={intervalMinutes}
              onChange={(event) =>
                setIntervalMinutes(Number(event.target.value))
              }
            >
              {intervals.map((interval) => (
                <option key={interval.minutes} value={interval.minutes}>
                  {interval.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className={field} htmlFor={`${id}-focus`}>
          想让它找什么（可留空）
          <Input
            id={`${id}-focus`}
            maxLength={1000}
            value={focus}
            onChange={(event) => setFocus(event.target.value)}
            placeholder="把派给我的待办和我该答的提问整理出来"
          />
        </label>
        <Button
          type="submit"
          className="justify-self-start"
          disabled={add.isPending || !agentId || !channelId}
        >
          开启后台调研
        </Button>
        {add.error && (
          <p role="alert" className="text-destructive">
            {add.error.message}
          </p>
        )}
      </form>
      {settings.error && (
        <p role="alert" className="text-destructive">
          {settings.error.message}
        </p>
      )}
      {settings.data?.map((setting) => (
        <SettingRow
          key={setting.id}
          setting={setting}
          botName={
            bots.data?.find((bot) => bot.id === setting.agentId)?.name ??
            setting.agentId
          }
        />
      ))}
    </section>
  );
}

function SettingRow({
  setting,
  botName,
}: {
  setting: ProactiveSetting;
  botName: string;
}) {
  const change = useMutation({
    mutationFn: (
      action:
        | { kind: "toggle" }
        | { kind: "run" }
        | { kind: "remove" }
        | { kind: "interval"; minutes: number },
    ) =>
      action.kind === "run"
        ? runProactiveNow(setting.id)
        : action.kind === "remove"
          ? removeProactiveSetting(setting.id)
          : updateProactiveSetting(
              setting.id,
              action.kind === "toggle"
                ? { enabled: !setting.enabled }
                : { intervalMinutes: action.minutes },
            ),
    onSuccess: refresh,
  });
  return (
    <article className="grid gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap justify-between gap-2">
        <strong>{botName}</strong>
        <span className="text-sm text-muted-foreground">
          {!setting.enabled
            ? "已关闭"
            : setting.lastStatus === "running"
              ? "正在调研"
              : `下次 ${new Date(setting.nextRunAt).toLocaleString("zh-CN")}`}
        </span>
      </div>
      {setting.focus && <p className="text-sm">{setting.focus}</p>}
      {setting.lastRunAt && (
        <p className="text-xs text-muted-foreground">
          上次运行 {new Date(setting.lastRunAt).toLocaleString()}
          {setting.lastStatus === "succeeded" ? "" : ` (${setting.lastStatus})`}
        </p>
      )}
      {setting.lastError && (
        <p role="alert" className="text-destructive">
          {setting.lastError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="调研频率"
          className={select}
          value={setting.intervalMinutes}
          onChange={(event) =>
            change.mutate({
              kind: "interval",
              minutes: Number(event.target.value),
            })
          }
        >
          {intervals.map((interval) => (
            <option key={interval.minutes} value={interval.minutes}>
              {interval.label}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={!setting.enabled || change.isPending}
          onClick={() => change.mutate({ kind: "run" })}
        >
          立即运行
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={change.isPending}
          onClick={() => change.mutate({ kind: "toggle" })}
        >
          {setting.enabled ? "停用" : "启用"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={change.isPending}
          onClick={() => change.mutate({ kind: "remove" })}
        >
          移除
        </Button>
      </div>
      {change.error && (
        <p role="alert" className="text-destructive">
          {change.error.message}
        </p>
      )}
    </article>
  );
}
