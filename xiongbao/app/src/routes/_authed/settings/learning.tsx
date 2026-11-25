import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { LocalLearningSection } from "@/components/settings/local-learning-section";

export const Route = createFileRoute("/_authed/settings/learning")({
  component: LearningSettingsPage,
});

export function LearningSettingsPage() {
  return (
    <PageShell
      title="学习"
      description="你的对话会教员工新技能。在这里查看它们学到了什么。"
    >
      <LocalLearningSection />
    </PageShell>
  );
}
