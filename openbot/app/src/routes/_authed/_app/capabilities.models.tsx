import { createFileRoute } from "@tanstack/react-router";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { ModelsTab } from "@/components/resources/model-zones";

/** 能力 › 模型库：员工用的模型库，以及平台提供的体验模型（只读）。 */
export const Route = createFileRoute("/_authed/_app/capabilities/models")({
  component: ModelsPage,
});

function ModelsPage() {
  return (
    <CapabilitiesShell>
      <ModelsTab />
    </CapabilitiesShell>
  );
}
