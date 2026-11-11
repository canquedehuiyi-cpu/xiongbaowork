import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { LearningReview } from "@/components/settings/learning-review";
import { LearningSharing } from "@/components/settings/learning-sharing";
import { LocalLearningSection } from "@/components/settings/local-learning-section";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

export const Route = createFileRoute("/_authed/settings/learning")({
  component: LearningSettingsPage,
});

export function LearningSettingsPage() {
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const personal = capabilities?.edition === "personal";
  return (
    <PageShell
      title="学习"
      description={
        personal
          ? "你的录制和对话会教员工新技能。在这里查看它们学到了什么。"
          : "你的每次录制都会进入你自己的学习空间，从中学到的技能会用到你使用的每位员工身上。选择还有谁的员工也可以用它们。"
      }
    >
      <LocalLearningSection />
      <LearningReview />
      <LearningSharing />
    </PageShell>
  );
}
