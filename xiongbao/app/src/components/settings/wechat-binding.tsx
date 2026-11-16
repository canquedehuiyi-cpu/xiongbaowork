import { IconBrandWechat } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { encode } from "uqr";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  deliveryKey,
  deliveryQueryOptions,
  startWechatBindMutationOptions,
  unbindWechatMutationOptions,
  type WechatBindAttempt,
  type WechatSummary,
  wechatAttemptFinished,
  wechatAttemptQueryOptions,
} from "@/lib/delivery";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/**
 * 我 › 通知 › 微信（计划 2026-11-16-im-channels-wechat Task 9）：用手机微信扫码绑定「微信 ClawBot」，
 * 绑好后在微信里就能直接给员工派活。提醒默认不发到微信：本人在同一页「消息发到哪里」里打开微信才发，
 * 而且微信只让在对方最近来过信的一段时间里主动发（时间窗），所以收提醒前要先在「微信 ClawBot」里发一句话。
 * 一个人一个绑定，所以这一节只有一行。
 *
 * 这里没开通微信时（总览 `available.wechat` 为 false）整节不画：没有能做的事，也没有要等的人。
 *
 * 颜色先取默认皮肤的 `--wb-*` 令牌，别的皮肤没有这些令牌时取应用自己的主题令牌。
 */

/** 提示句（时间窗已关、暂停、断开）的颜色：琥珀色是「要留意」，不是出错。 */
const NOTICE = "text-[color:var(--wb-amber-fg,var(--foreground))]";

/** 服务器的话不是中文时（别的渠道共用的英文报错、网络层的报错），对话框里说这一句。 */
const UNAVAILABLE = "暂时连不上微信，请稍后再试";
/** 服务器给的报错：带中文就照说，否则用中文兜底，不把英文原样摆给用户。 */
function wechatError(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  return /[\u4e00-\u9fff]/.test(message) ? message : UNAVAILABLE;
}

const STEPS = [
  "打开微信 › 我 › 设置 › 插件 › 微信 ClawBot",
  "扫描下面的二维码",
  "在手机上确认",
];

export function WechatBindingSection() {
  const reach = useQuery(deliveryQueryOptions());
  const [binding, setBinding] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  if (reach.isPending) return null;
  if (reach.error)
    return (
      <PageSection title="微信">
        <p className="mt-4 text-destructive text-sm" role="alert">
          {wechatError(reach.error.message)}
        </p>
      </PageSection>
    );
  if (!reach.data.available.wechat) return null;
  const wechat = reach.data.wechat;
  const connected = wechat !== null && wechat.status !== "disconnected";
  return (
    <PageSection
      description="绑定后，在微信里的「微信 ClawBot」就能直接给员工派活。要在微信里收提醒，请在本页「消息发到哪里」里打开微信。"
      title="微信"
    >
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconBrandWechat />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>微信 ClawBot</ItemTitle>
            <WechatState wechat={wechat} />
          </ItemContent>
          <ItemActions>
            {connected ? (
              <Button
                onClick={() => setUnbinding(true)}
                size="sm"
                variant="outline"
              >
                解绑
              </Button>
            ) : (
              <Button onClick={() => setBinding(true)} size="sm">
                绑定微信
              </Button>
            )}
          </ItemActions>
        </Item>
      </PageRows>
      {binding ? <BindDialog onClose={() => setBinding(false)} /> : null}
      {unbinding ? <UnbindDialog onClose={() => setUnbinding(false)} /> : null}
    </PageSection>
  );
}

/** 绑定的日子，按本地日期说：「11月16日」。 */
function boundDay(boundAt: string) {
  return new Date(boundAt).toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
  });
}

/** 暂停还剩多久：「约 5 分钟后恢复」，超过一小时按小时说；不知道什么时候恢复就说「稍后自动恢复」。 */
function resumeIn(pausedUntil: string | null | undefined) {
  const until = pausedUntil ? new Date(pausedUntil).getTime() : Number.NaN;
  if (!Number.isFinite(until)) return "稍后自动恢复";
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  return minutes < 60
    ? `约 ${minutes} 分钟后恢复`
    : `约 ${Math.ceil(minutes / 60)} 小时后恢复`;
}

/**
 * 这一行的第二行：绑没绑、什么时候绑的，再加一句要留意的事。断开优先于暂停，暂停优先于时间窗：
 * 断开了暂停和时间窗都无从谈起，暂停时时间窗开着也发不出去。
 *
 * 有最近一次在微信里说话的时间就说「最近一次消息 X 前」，还没有就说绑定的日子；暂停时有恢复时间就说
 * 「约 X 分钟后恢复」，没有就说「稍后自动恢复」。
 */
function WechatState({ wechat }: { wechat: WechatSummary | null }) {
  if (!wechat)
    return (
      <ItemDescription className="line-clamp-none">
        还没绑定。用手机微信扫一次码就能绑好。
      </ItemDescription>
    );
  const notice =
    wechat.status === "disconnected"
      ? "微信已断开，请重新绑定"
      : wechat.paused
        ? `微信让我们歇一会儿，${resumeIn(wechat.pausedUntil)}`
        : !wechat.windowOpen
          ? wechat.lastInboundAt
            ? "超过 10 小时没在微信里说话，提醒会先发到手机；在「微信 ClawBot」里发一句话就恢复"
            : "收提醒前，先在「微信 ClawBot」里发一句话"
          : null;
  return (
    <ItemDescription className="line-clamp-none">
      {wechat.status === "disconnected" ? null : (
        <span className="block">
          已绑定 ·{" "}
          {wechat.lastInboundAt
            ? `最近一次消息 ${relativeTime(wechat.lastInboundAt)}`
            : `${boundDay(wechat.boundAt)}绑定`}
        </span>
      )}
      {notice ? <span className={cn("block", NOTICE)}>{notice}</span> : null}
    </ItemDescription>
  );
}

/**
 * 扫码对话框：一打开就要一张二维码，每 2 秒问一次走到哪了。绑好了就关掉，这一行会改说「已绑定」；
 * 过期、被别的账号绑了、没绑上时停在原地，可以「换一张」。
 */
function BindDialog({ onClose }: { onClose: () => void }) {
  const start = useMutation(startWechatBindMutationOptions());
  const attemptId = start.data?.attemptId;
  const attempt = useQuery({
    ...wechatAttemptQueryOptions(attemptId ?? ""),
    enabled: Boolean(attemptId),
  });
  const status = attempt.data?.status;
  const { mutate: requestCode } = start;

  // 打开就要一张码，只要一次（严格模式会把挂载跑两遍）：「换一张」走按钮，不靠这里。
  const requested = useRef(false);
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    requestCode();
  }, [requestCode]);

  useEffect(() => {
    if (status !== "bound") return;
    void queryClient.invalidateQueries({ queryKey: deliveryKey });
    onClose();
  }, [status, onClose]);

  const finished = status !== undefined && wechatAttemptFinished(status);
  const error = start.error ?? attempt.error;
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>绑定微信</DialogTitle>
          <DialogDescription>
            二维码 {start.data?.expiresInMinutes ?? 10} 分钟内有效。
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          <ol className="flex flex-col gap-2">
            {STEPS.map((step, index) => (
              <li className="flex items-baseline gap-2.5" key={step}>
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--wb-card2,var(--muted))] text-[color:var(--wb-fg2,var(--muted-foreground))] text-xs tabular-nums">
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <div className="flex flex-col items-center gap-3 py-2">
            <QrFrame
              dimmed={status === "scaned" || finished}
              source={start.isPending ? undefined : start.data?.imageContent}
            />
            <AttemptLine
              attempt={attempt.data}
              error={wechatError(error?.message)}
              onRetry={() => start.mutate()}
              retrying={start.isPending}
            />
          </div>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="outline">
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 地址（http、https）或 data 图片就先当图片画；别的当二维码内容。 */
function isImageSource(source: string) {
  return /^(https?:\/\/|data:image\/)/i.test(source);
}

/**
 * 把内容编码成二维码的深色模块，一条路径画完。空内容或编码不了（太长）时是 null。
 * `border: 2` 再加外框的内边距，四周留出约四个模块宽的白边，手机才认得出。
 */
function qrModules(content: string) {
  if (!content) return null;
  try {
    const { data, size } = encode(content, { ecc: "M", border: 2 });
    let path = "";
    data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) path += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { path, size };
  } catch {
    return null;
  }
}

/**
 * 二维码。白底深色码，暗色主题下也一样：扫码要的是深色码配浅色底。扫过了或结束了就压暗，状态句在下面说为什么。
 *
 * 服务器给的 `imageContent` 可能是图片地址，也可能是二维码本身的内容（还没在真机上确认）。像图片的先当图片
 * 画；不像图片的、或图片加载失败的（链接本身也可能就是要编码的内容），在浏览器里把同一段内容编码成二维码。
 * 内容为空或编码不了，才说画不出来，请换一张。
 */
function QrFrame({
  source,
  dimmed,
}: {
  source: string | undefined;
  dimmed: boolean;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const asImage = source && isImageSource(source) && broken !== source;
  const modules = source === undefined || asImage ? null : qrModules(source);
  return (
    <div
      className={cn(
        "flex size-52 items-center justify-center overflow-hidden rounded-xl border border-[color:var(--wb-line,var(--border))] bg-white p-3 transition-opacity",
        dimmed && "opacity-25",
      )}
    >
      {source === undefined ? null : asImage ? (
        <img
          alt="绑定微信的二维码"
          className="h-full w-full object-contain"
          height={184}
          onError={() => setBroken(source)}
          src={source}
          width={184}
        />
      ) : modules ? (
        <svg
          aria-label="绑定微信的二维码"
          className="h-full w-full"
          role="img"
          shapeRendering="crispEdges"
          viewBox={`0 0 ${modules.size} ${modules.size}`}
        >
          <rect fill="#fff" height={modules.size} width={modules.size} />
          <path d={modules.path} fill="#000" />
        </svg>
      ) : (
        <p className="px-2 text-center text-neutral-600 text-sm">
          二维码显示不出来，请换一张
        </p>
      )}
    </div>
  );
}

/** 二维码下面的一句话，随轮询变：等扫、已扫码、过期（可换一张）、被别的账号绑了、没绑上。 */
function AttemptLine({
  attempt,
  error,
  onRetry,
  retrying,
}: {
  attempt: WechatBindAttempt | undefined;
  error: string | undefined;
  onRetry: () => void;
  retrying: boolean;
}) {
  const retry = (
    <Button disabled={retrying} onClick={onRetry} size="sm" variant="outline">
      换一张
    </Button>
  );
  if (error)
    return (
      <div className="flex flex-col items-center gap-2">
        <p className="text-center text-destructive text-sm" role="alert">
          {error}
        </p>
        {retry}
      </div>
    );
  const status = attempt?.status;
  if (status === "scaned")
    return (
      <p className="font-medium text-sm" role="status">
        已扫码，请在手机上确认
      </p>
    );
  if (status === "bound")
    return (
      <p className="font-medium text-sm" role="status">
        已绑定
      </p>
    );
  if (status === "expired" || status === "taken" || status === "failed")
    return (
      <div className="flex flex-col items-center gap-2">
        <p className={cn("text-center text-sm", NOTICE)} role="status">
          {status === "expired"
            ? "二维码已过期"
            : (attempt?.message ?? "没绑上，请换一张二维码再试")}
        </p>
        {retry}
      </div>
    );
  return (
    <p
      className="text-[color:var(--wb-muted,var(--muted-foreground))] text-sm"
      role="status"
    >
      等你扫码
    </p>
  );
}

/** 解绑的二次确认。 */
function UnbindDialog({ onClose }: { onClose: () => void }) {
  const unbind = useMutation(unbindWechatMutationOptions(queryClient));
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>解绑微信</DialogTitle>
          <DialogDescription>
            解绑后不能再在微信里给员工派活，微信里也不会再收到提醒，确定吗？
          </DialogDescription>
        </DialogHeader>
        {unbind.error ? (
          <DialogBody className="mt-4">
            <p className="text-destructive text-sm" role="alert">
              {wechatError(unbind.error.message)}
            </p>
          </DialogBody>
        ) : null}
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="outline">
            取消
          </Button>
          <Button
            disabled={unbind.isPending}
            onClick={() => unbind.mutate(undefined, { onSuccess: onClose })}
            size="sm"
            variant="destructive"
          >
            解绑
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
