import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import {
  type ErrorComponentProps,
  Link,
  useRouter,
} from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

/**
 * What a page shows when it throws while loading or drawing (the router's default error page), in
 * the workbench's language: a quiet panel, the one red mark on the icon, what happened in a sentence
 * a person can act on, and the two ways forward — try again, or go back to the workbench.
 *
 * The error's own message is shown only when it is a sentence meant for a person (the API client's
 * messages are); a stack or a bare `TypeError` stays in the console.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const message =
    error instanceof Error && /[㐀-鿿]/.test(error.message)
      ? error.message
      : "页面没有加载成功。可以重试一次；如果仍然不行，请稍后再来。";
  return (
    <div
      className="flex min-h-[60vh] w-full items-center justify-center p-6"
      role="alert"
    >
      <div className="flex w-full max-w-[440px] flex-col items-center gap-[6px] rounded-[18px] border border-border bg-card px-6 py-8 text-center shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]">
        <span className="mb-[6px] flex size-[45px] items-center justify-center rounded-[14px] border border-border bg-accent text-signal">
          <IconAlertTriangle aria-hidden="true" className="size-[22px]" />
        </span>
        <h1 className="font-bold text-[17px] tracking-[-0.02em]">出了点问题</h1>
        <p className="text-pretty text-[12px] text-muted-foreground leading-[1.6]">
          {message}
        </p>
        <div className="mt-[10px] flex flex-wrap items-center justify-center gap-[7px]">
          <Button
            onClick={() => {
              reset();
              void router.invalidate();
            }}
          >
            <IconRefresh />
            重试
          </Button>
          <Button render={<Link to="/" />} variant="outline">
            回到工作台
          </Button>
        </div>
      </div>
    </div>
  );
}
