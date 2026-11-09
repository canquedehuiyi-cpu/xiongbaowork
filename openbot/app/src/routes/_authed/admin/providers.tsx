import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ModelAllowlistSection,
  ModelChoiceSection,
  ModelUsageSection,
  ProviderSection,
} from "@/components/admin/controls/model-sections";
import { PageShell } from "@/components/layout/page-shell";
import { availableModelsQueryOptions } from "@/lib/models/queries";

export const Route = createFileRoute("/_authed/admin/providers")({
  component: ProvidersPage,
});

/**
 * Admin, Providers: what serves the models built-in Bots run on, which models people may pick, and
 * what Bots ran on. Named for the provider rather than the model so a second provider has a place
 * to go.
 *
 * One person on their own machine is offered every model the credential lists, so there is nothing
 * to allow and no allowlist is shown. A team picks among the models an admin allows here.
 */
export function ProvidersPage() {
  const available = useQuery(availableModelsQueryOptions());
  const team = available.data?.exposure === "allowed";
  return (
    <PageShell
      description={
        team
          ? "查看员工的模型由哪个提供方提供，并选择大家可以挑选哪些模型。所有改动都会记入审计。"
          : "查看员工的模型由哪个提供方提供，以及它们用的是什么。"
      }
      title="模型提供方"
    >
      <ProviderSection />
      <ModelChoiceSection />
      {team ? <ModelAllowlistSection /> : null}
      <ModelUsageSection team={team} />
    </PageShell>
  );
}
