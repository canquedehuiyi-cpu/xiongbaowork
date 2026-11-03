import { IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { modelLibraryQueryOptions } from "@/lib/models/queries";

/**
 * A nudge toward connecting a first model, for a tenant whose model library is empty.
 *
 * A prompt rather than a step, and dismissible, because nothing depends on it: every employee
 * already answers on the model the deployment ships with, so an empty library is a missed chance to
 * give one its own model, not a broken workspace. It never blocks the wizard's own buttons.
 *
 * Drawn only once the library has answered and answered empty. While it is loading, when it failed,
 * and the moment it holds a model, there is nothing to say, so a person who already connected one
 * (or whose read failed) is not told to do it again.
 *
 * `onConnect` is the caller's, because where "connect a model" goes depends on where this is drawn:
 * on the onboarding screen the person has to finish onboarding first, or the resources screen would
 * send them straight back.
 */
export function ModelLibraryGuide({
  onConnect,
  connecting = false,
}: {
  onConnect: () => void;
  connecting?: boolean;
}) {
  const library = useQuery(modelLibraryQueryOptions());
  const [dismissed, setDismissed] = useState(false);

  const empty =
    !library.isPending &&
    !library.error &&
    (library.data?.models ?? []).length === 0;
  if (!empty || dismissed) return null;

  return (
    <section
      aria-label="接入模型"
      className="mt-8 flex flex-row items-start gap-3 rounded-lg border border-border bg-card p-4 max-w-md w-full mx-auto"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 className="text-sm font-medium">还没有接入任何模型</h2>
        <p className="text-muted-foreground text-sm">
          员工现在用部署自带的模型回答。接入一个你自己的模型，就能给某位员工配上它。
        </p>
        <div className="mt-2">
          <Button
            disabled={connecting}
            onClick={onConnect}
            size="sm"
            variant="secondary"
          >
            {connecting ? "正在前往…" : "去能力与资源接入模型"}
          </Button>
        </div>
      </div>
      <Button
        aria-label="暂不接入"
        onClick={() => setDismissed(true)}
        size="icon-sm"
        variant="ghost"
      >
        <IconX />
      </Button>
    </section>
  );
}
