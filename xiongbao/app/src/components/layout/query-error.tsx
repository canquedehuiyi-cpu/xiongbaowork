import { Button } from "@/components/ui/button";

/** A failed read needs an answer and a way to ask again, even when cached data is still visible. */
export function QueryError({
  label,
  error,
  retrying,
  onRetry,
}: {
  label: string;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mb-4 flex items-center gap-3 text-sm" role="alert">
      <p className="text-destructive">
        {label}：{error instanceof Error ? error.message : "请稍后再试。"}
      </p>
      <Button disabled={retrying} onClick={onRetry} size="sm" variant="outline">
        {retrying ? "正在重试…" : "重试"}
      </Button>
    </div>
  );
}
