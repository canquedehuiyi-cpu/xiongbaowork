import { Link } from "@tanstack/react-router";
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
import type { Reachability } from "@/lib/delivery";
import { cn } from "@/lib/utils";

/**
 * 机器人与账号: which chat apps this deployment can reach you on, and the devices registered to you.
 *
 * Everything here is read from `GET /api/delivery`. Pairing Slack and Teams with OpenTag, and the
 * SMS provider, are deployment settings an administrator makes; this page can only say whether
 * they are in place. The services a coworker reads as you (Google Drive, Notion…) are a different
 * kind of account and keep their own page, linked at the foot.
 */
export function BotsAccountsDialog({
  open,
  onOpenChange,
  reach,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reach: Reachability | undefined;
}) {
  const rows: { name: string; ready: boolean | undefined; hint: string }[] = [
    {
      name: "Slack 机器人（经 OpenTag）",
      ready: reach?.available.slack,
      hint: "需要管理员先把本产品与 OpenTag 配对。",
    },
    {
      name: "Microsoft Teams 机器人（经 OpenTag）",
      ready: reach?.available.teams,
      hint: "与 Slack 共用同一个 OpenTag 配对。",
    },
    {
      name: "短信号码",
      ready: reach?.available.sms,
      hint: "需要管理员为这个部署配置短信服务。",
    },
    {
      name: "原生应用推送",
      ready: reach?.available.push,
      hint: "需要这个部署配置推送服务。",
    },
  ];
  const devices = reach?.devices.filter((device) => device.enabled) ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>机器人与账号</DialogTitle>
          <DialogDescription>
            员工通过这些机器人和号码在 IM
            里找到你。它们由管理员为整个部署配置，这里只显示是否可用。
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {reach ? (
            <ul className="grid gap-2" aria-label="机器人与账号">
              {rows.map((row) => (
                <li
                  className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
                  key={row.name}
                >
                  <div className="grid gap-0.5">
                    <span className="text-[13px] font-medium">{row.name}</span>
                    {!row.ready && (
                      <span className="text-[12px] text-muted-foreground">
                        {row.hint}
                      </span>
                    )}
                  </div>
                  <span
                    className={cn(
                      "shrink-0 text-[12px]",
                      row.ready ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {row.ready ? "可用" : "未配置"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">正在读取…</p>
          )}
          <p className="text-[13px] text-muted-foreground">
            {devices.length
              ? `已注册 ${devices.length} 台原生设备，可在下方“已接入聊天”里移除。`
              : "登录本产品的原生应用并开启通知，就会注册这台设备。"}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            render={(props) => <Link to="/connections" {...props} />}
          >
            管理第三方服务账号
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * An entry the reference product has and this deployment cannot serve yet.
 *
 * Said plainly, with the action drawn and disabled, rather than hidden (the person would not know
 * the entry exists) or faked (a switch that looked on but did nothing).
 */
export function UnavailableEntryDialog({
  open,
  onOpenChange,
  title,
  description,
  reason,
  action,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  reason: string;
  action: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="rounded-md border border-dashed px-3 py-2 text-[13px] text-muted-foreground">
            暂不可用：{reason}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button disabled>{action}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
