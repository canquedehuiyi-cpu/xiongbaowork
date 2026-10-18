import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  mintPairCodeMutationOptions,
  removeDeviceMutationOptions,
  reviewDeviceActionMutationOptions,
} from "@/lib/devices/mutations";
import {
  deviceActionsQueryOptions,
  devicesQueryOptions,
  type DeviceActionReview,
} from "@/lib/devices/queries";
import { relativeTime } from "@/lib/relative-time";

/** How a runner is told where to dial, in the form the person can paste. */
function runnerCommand(server: string, code: string): string {
  return `bun runner/src/index.ts --server ${server} --pair ${code}`;
}

export function MyDevices() {
  const queryClient = useQueryClient();
  const devices = useQuery(devicesQueryOptions());
  const mint = useMutation(mintPairCodeMutationOptions());
  const remove = useMutation(removeDeviceMutationOptions(queryClient));
  const [reviewing, setReviewing] = useState<string | null>(null);

  /*
   * The code lives in component state and nowhere else.
   *
   * It is a credential that admits a machine, and it is good for one pairing; caching it would let it
   * outlive the screen it was minted on and be served again by a cache hit. Leaving this screen, or
   * reloading it, drops it — which is the same lifetime the code has on the server.
   */
  const [pairing, setPairing] = useState<{
    code: string;
    expiresAt: string;
  } | null>(null);

  const error = devices.error ?? mint.error ?? remove.error;

  return (
    <PageSection
      description="员工在上面干活的那些机器。每台都主动向外连接这个部署、自己不监听任何端口，所以既不用开入站端口，也就能在防火墙和网络地址转换后面正常工作。"
      title="我的设备"
    >
      <div className="mt-4 flex flex-col gap-3">
        {pairing ? (
          <div className="grid gap-2 rounded-lg border border-border bg-card p-3">
            <p className="font-medium text-sm">
              把下面这段在那台机器上输入一次，过期前有效。
            </p>
            <code className="block break-all rounded bg-foreground/5 p-2 font-mono text-xs">
              {runnerCommand(window.location.origin, pairing.code)}
            </code>
            <p className="text-muted-foreground text-xs">
              配对码在{relativeTime(pairing.expiresAt)}
              之前有效，只能用于一台机器。之后运行器会保存自己的设备令牌，不再需要配对码。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => setPairing(null)}
                size="sm"
                variant="outline"
              >
                完成
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={mint.isPending}
              onClick={() => mint.mutate(undefined, { onSuccess: setPairing })}
              size="sm"
              variant="outline"
            >
              {mint.isPending ? "正在生成配对码…" : "配对一台设备"}
            </Button>
            {devices.data?.length ? (
              <p className="text-muted-foreground text-xs">
                新机器用新的配对码；旧机器重新配对会覆盖原来的记录。
              </p>
            ) : null}
          </div>
        )}

        {devices.isPending ? null : devices.data?.length ? (
          <div className="flex flex-col gap-2">
            {devices.data.map((device) => (
              <Item key={device.id} size="sm" variant="outline">
                <ItemContent>
                  <ItemTitle>
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={
                          device.online
                            ? "size-2 rounded-full bg-emerald-500"
                            : "size-2 rounded-full bg-muted-foreground/40"
                        }
                      />
                      {device.name}
                    </span>
                  </ItemTitle>
                  <ItemDescription>
                    <span>
                      {device.online
                        ? "在线"
                        : device.lastSeenAt
                          ? `最后在线 ${relativeTime(device.lastSeenAt)}`
                          : "从未上线"}
                    </span>
                    {device.platform ? <span>· {device.platform}</span> : null}
                    {device.queued ? (
                      <span>· {device.queued} 项等待执行</span>
                    ) : null}
                    {device.uncertain ? (
                      <span className="text-destructive">
                        · {device.uncertain}{" "}
                        项结果不明，已暂停自动执行，请在设备上核查
                      </span>
                    ) : null}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setReviewing(reviewing === device.id ? null : device.id)
                    }
                  >
                    {device.uncertain ? "核查并恢复" : "核查记录"}
                  </Button>
                  <Button
                    aria-label={`移除 ${device.name}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(device.id)}
                    size="sm"
                    variant="outline"
                  >
                    移除
                  </Button>
                </ItemActions>
                {reviewing === device.id ? (
                  <DeviceReviews id={device.id} />
                ) : null}
              </Item>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            还没有设备。员工只能跑在你在这里配对过的机器上。
          </p>
        )}

        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error.message}
          </p>
        ) : null}
      </div>
    </PageSection>
  );
}

function DeviceReviews({ id }: { id: string }) {
  const actions = useQuery(deviceActionsQueryOptions(id));
  return (
    <div className="w-full space-y-3 rounded-md border p-3">
      <p className="text-sm">
        请先在设备上检查文件、命令或网页的实际结果，并停止仍在运行的相关命令。全部不明动作核查后才恢复后续自动执行；原动作不会重放。
      </p>
      {actions.isPending ? <p role="status">正在加载核查记录…</p> : null}
      {actions.error ? <p role="alert">{actions.error.message}</p> : null}
      {actions.data?.length === 0 ? (
        <p>没有待核查或已核查的不明动作。</p>
      ) : null}
      {actions.data?.map((action) => (
        <ReviewAction key={action.key} id={id} action={action} />
      ))}
    </div>
  );
}

function ReviewAction({
  id,
  action,
}: {
  id: string;
  action: DeviceActionReview;
}) {
  const queryClient = useQueryClient();
  const review = useMutation(
    reviewDeviceActionMutationOptions(queryClient, id),
  );
  const [resolution, setResolution] = useState<
    "checked_executed" | "checked_not_executed"
  >("checked_executed");
  const [note, setNote] = useState("");
  const [checked, setChecked] = useState(false);
  const labels: Record<string, string> = {
    exec: "运行命令",
    "files.write": "写入文件",
    "files.read": "读取文件",
    navigate: "打开网页",
    click: "网页点击",
    type: "网页输入",
  };
  return (
    <div className="space-y-2 rounded border p-3 text-sm">
      <p className="font-medium">
        {labels[action.action] ?? "设备动作"} · {relativeTime(action.createdAt)}
      </p>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
        {JSON.stringify(action.payload, null, 2)}
      </pre>
      {action.review ? (
        <p>
          已核查：
          {action.review.resolution === "checked_executed"
            ? "已发生或部分发生"
            : "确认未发生"}
          。{action.review.note}
        </p>
      ) : (
        <>
          <label className="block">
            设备上的实际结果
            <select
              aria-label="设备上的实际结果"
              value={resolution}
              onChange={(event) =>
                setResolution(event.target.value as typeof resolution)
              }
              className="ml-2 rounded border p-1"
            >
              <option value="checked_executed">已发生或部分发生</option>
              <option value="checked_not_executed">确认未发生</option>
            </select>
          </label>
          <label className="block">
            核查说明
            <textarea
              aria-label="核查说明"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
              className="mt-1 block w-full rounded border p-2"
              placeholder="记录检查了哪些文件或操作，以及实际结果"
            />
          </label>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
            />
            我已在设备上核查结果并停止相关命令，确认可以继续后续动作
          </label>
          <Button
            size="sm"
            disabled={!checked || !note.trim() || review.isPending}
            onClick={() =>
              review.mutate({
                key: action.key,
                resolution,
                note: note.trim(),
                confirmedChecked: true,
              })
            }
          >
            {review.isPending ? "正在保存…" : "保存核查结果"}
          </Button>
          {review.error ? <p role="alert">{review.error.message}</p> : null}
          {review.data ? (
            <p role="status">
              {review.data.paused
                ? `仍有 ${review.data.uncertain} 项需核查，设备继续暂停。`
                : "核查已保存，后续动作可以继续；原动作不会重放。"}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
