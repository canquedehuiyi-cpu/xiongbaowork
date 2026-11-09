import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
import { newId } from "@/lib/new-id";
import {
  createWakerFlowShare,
  listWakerFlowShares,
  revokeWakerFlowShare,
  SHARE_DEFAULT_DAYS,
  SHARE_DEFAULT_USES,
  SHARE_MAX_DAYS,
  SHARE_MAX_USES,
  SHARE_STATUS_LABEL,
  shareImportPath,
  type WakerFlow,
  wakerFlowKeys,
} from "@/lib/wakerflows";
import { CARD_FACE } from "./flow-ui";

const when = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const whole = (raw: string, max: number) => {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= max ? value : null;
};

/**
 * Sharing a saved WakerFlow by link (WF9, spec §3.3): make a link with an expiry and a use limit,
 * copy it, see what is left of each link, and revoke one.
 *
 * What a link carries is a copy of the plan's definition with the coworkers taken out; whoever
 * imports it picks their own coworkers for each role. The link itself is shown once, right after it
 * is made: the server keeps only its hash, so closing the dialog loses it for good.
 */
export function ShareDialog(props: { flow: WakerFlow }) {
  const { flow } = props;
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(String(SHARE_DEFAULT_DAYS));
  const [uses, setUses] = useState(String(SHARE_DEFAULT_USES));
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  /** Held in state only: it must not outlive this dialog. */
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const shares = useQuery({
    queryKey: wakerFlowKeys.shares(flow.id),
    queryFn: () => listWakerFlowShares(flow.id),
    enabled: open,
  });

  const expiresInDays = whole(days, SHARE_MAX_DAYS);
  const maxUses = whole(uses, SHARE_MAX_USES);

  function close(next: boolean) {
    setOpen(next);
    if (!next) {
      setLink(null);
      setCopied(false);
      setFailure(null);
    }
  }

  async function create() {
    if (expiresInDays === null || maxUses === null) return;
    setCreating(true);
    setFailure(null);
    try {
      const made = await createWakerFlowShare(flow.id, {
        id: newId(),
        expiresInDays,
        maxUses,
      });
      if (made.token)
        setLink(`${window.location.origin}${shareImportPath(made.token)}`);
      await queryClient.invalidateQueries({
        queryKey: wakerFlowKeys.shares(flow.id),
      });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "没能创建分享链接。");
    } finally {
      setCreating(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setFailure("没能复制，请手动选中链接复制。");
    }
  }

  async function revoke(shareId: string) {
    setRevoking(shareId);
    setFailure(null);
    try {
      await revokeWakerFlowShare(flow.id, shareId);
      await queryClient.invalidateQueries({
        queryKey: wakerFlowKeys.shares(flow.id),
      });
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "没能撤销这个分享链接。",
      );
    } finally {
      setRevoking(null);
    }
  }

  return (
    <>
      <Button onClick={() => close(true)} size="sm" variant="outline">
        分享
      </Button>
      <Dialog onOpenChange={close} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>分享「{flow.name}」</DialogTitle>
            <DialogDescription>
              链接只包含流程的定义，不包含员工、模型和运行记录；导入的人为每个角色选择自己的员工，导入后与这里再无关联。
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {link ? (
              <div className="grid gap-2 rounded-[13px] border border-signal/40 bg-signal-soft p-3">
                <p className="font-semibold text-[13px]">
                  现在就复制这个链接。关闭后无法再次查看。
                </p>
                <code className="block break-all rounded-[9px] border border-border bg-background p-2 font-mono text-[12px]">
                  {link}
                </code>
                <div className="flex flex-row gap-2">
                  <Button onClick={copy} size="sm" variant="outline">
                    {copied ? "已复制" : "复制链接"}
                  </Button>
                  <Button onClick={() => setLink(null)} size="sm">
                    完成
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid gap-3">
                <div className="grid gap-1">
                  <label
                    className="font-medium text-[13px]"
                    htmlFor={`share-days-${flow.id}`}
                  >
                    有效期（天，最长 {SHARE_MAX_DAYS} 天）
                  </label>
                  <Input
                    id={`share-days-${flow.id}`}
                    inputMode="numeric"
                    onChange={(event) => setDays(event.target.value)}
                    value={days}
                  />
                </div>
                <div className="grid gap-1">
                  <label
                    className="font-medium text-[13px]"
                    htmlFor={`share-uses-${flow.id}`}
                  >
                    可导入次数（最多 {SHARE_MAX_USES} 次）
                  </label>
                  <Input
                    id={`share-uses-${flow.id}`}
                    inputMode="numeric"
                    onChange={(event) => setUses(event.target.value)}
                    value={uses}
                  />
                </div>
                {expiresInDays === null || maxUses === null ? (
                  <p className="text-[12px] text-signal-ink">
                    有效期需在 1 到 {SHARE_MAX_DAYS} 天之间，可导入次数需在 1 到{" "}
                    {SHARE_MAX_USES} 次之间。
                  </p>
                ) : null}
                <Button
                  disabled={
                    creating || expiresInDays === null || maxUses === null
                  }
                  onClick={create}
                  size="sm"
                >
                  {creating ? "正在创建…" : "创建链接"}
                </Button>
              </div>
            )}
            {failure ? (
              <p className="mt-3 text-signal-ink" role="alert">
                {failure}
              </p>
            ) : null}
            <h3 className="mt-[18px] font-semibold text-[13px]">
              已创建的链接
            </h3>
            {(shares.data ?? []).length === 0 ? (
              <p className="mt-1 text-[13px] text-muted-foreground">
                还没有分享链接。
              </p>
            ) : (
              <ul
                aria-label="分享链接"
                className={`${CARD_FACE} mt-[7px] flex flex-col divide-y divide-border overflow-hidden`}
              >
                {(shares.data ?? []).map((share) => (
                  <li
                    className="flex flex-row items-center justify-between gap-2 px-3 py-[9px] text-[13px]"
                    key={share.id}
                  >
                    <div className="min-w-0">
                      <p
                        className={
                          share.status === "active"
                            ? undefined
                            : "text-muted-foreground"
                        }
                      >
                        {SHARE_STATUS_LABEL[share.status]} · 已导入 {share.uses}
                        /{share.maxUses} 次 · 剩余 {share.remainingUses} 次
                      </p>
                      <p className="text-[11.5px] text-faint tabular-nums">
                        {when(share.createdAt)} 创建 · {when(share.expiresAt)}{" "}
                        到期
                      </p>
                    </div>
                    {share.status === "active" ? (
                      <Button
                        disabled={revoking !== null}
                        onClick={() => revoke(share.id)}
                        size="sm"
                        variant="ghost"
                      >
                        {revoking === share.id ? "正在撤销…" : "撤销"}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => close(false)} size="sm" variant="outline">
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
