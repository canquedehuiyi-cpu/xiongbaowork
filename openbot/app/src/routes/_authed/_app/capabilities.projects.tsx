import { createFileRoute } from "@tanstack/react-router";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { ProjectsSection } from "@/components/resources/projects-section";

/** 能力 › 公开项目：员工可以在设备上共用的项目。 */
export const Route = createFileRoute("/_authed/_app/capabilities/projects")({
  component: ProjectsPage,
});

function ProjectsPage() {
  return (
    <CapabilitiesShell>
      <ProjectsSection />
    </CapabilitiesShell>
  );
}
