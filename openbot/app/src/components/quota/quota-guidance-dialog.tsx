import { Link } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
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
  currentQuotaGuidance,
  dismissQuotaGuidance,
  guidanceFor,
  subscribeQuotaGuidance,
} from "@/lib/quota/guidance";

/**
 * The one answer to a full allowance, wherever in the app it was hit (story K4).
 *
 * Mounted once in the signed-in layout (`_authed`). The query client reports every structured 402
 * here, so a screen that only shows `error.message` inline still hands the person the plan, the
 * used/limit pair, and the two ways out: upgrade, or free a slot on the screen that holds what is being counted.
 */
export function QuotaGuidanceDialog() {
  const details = useSyncExternalStore(
    subscribeQuotaGuidance,
    currentQuotaGuidance,
    currentQuotaGuidance,
  );
  const guidance = details ? guidanceFor(details) : null;

  return (
    <Dialog
      open={guidance !== null}
      onOpenChange={(open) => {
        if (!open) dismissQuotaGuidance();
      }}
    >
      {guidance && (
        <DialogContent data-quota-metric={guidance.metric}>
          <DialogHeader>
            <DialogTitle>{guidance.title}</DialogTitle>
            <DialogDescription>{guidance.sentence}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-muted-foreground text-sm">{guidance.hint}</p>
          </DialogBody>
          <DialogFooter>
            {guidance.cleanup && (
              <Button
                variant="outline"
                render={
                  guidance.cleanup.href === "/resources" ? (
                    // The model library is its own tab of 能力与资源, not the default 插件 tab.
                    <Link
                      onClick={dismissQuotaGuidance}
                      search={{ tab: "models" }}
                      to="/resources"
                    />
                  ) : (
                    <Link
                      to={guidance.cleanup.href}
                      onClick={dismissQuotaGuidance}
                    />
                  )
                }
              >
                {guidance.cleanup.label}
              </Button>
            )}
            <Button
              render={
                <Link
                  to={guidance.upgradeHref}
                  onClick={dismissQuotaGuidance}
                />
              }
            >
              升级套餐
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
