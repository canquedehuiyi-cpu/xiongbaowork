import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { SkillFields } from "@/components/skills/skill-fields";
import { Button } from "@/components/ui/button";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useManagePaths } from "@/lib/manage-paths";
import { saveSkillMutationOptions } from "@/lib/plugins/mutations";
import { emptySkillForm } from "@/lib/skills/form";

/**
 * Writing a skill for the whole deployment, on a screen of its own rather than in a dialog over the
 * list, as every other screen that adds something does (`new-credential-page.tsx`).
 *
 * Saving opens the skill's own page, because a skill no Bot offers does nothing yet: choosing the
 * Bots is the step that makes it work. In the personal edition every Bot already offers a new skill
 * (the server grants it, `personal-defaults.ts`), so there the page is where to turn one off.
 */
export function NewSkillPage() {
  const paths = useManagePaths();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const saveSkill = useMutation(saveSkillMutationOptions(queryClient));
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";

  return (
    <PageShell
      backButton={{ label: "技能", linkProps: paths.skills() }}
      description={
        personal
          ? "写下你在 / 菜单里选中这个技能时员工要遵循的说明。保存后你的员工就会提供它。"
          : "写下有人在 / 菜单里选中这个技能时员工要遵循的说明。保存后再选择由哪些员工提供它。"
      }
      title="新建技能"
    >
      <SkillFields
        sections={{
          flush: true,
          cancel: (
            <Button
              render={(props) => <Link {...props} {...paths.skills()} />}
              variant="outline"
            >
              取消
            </Button>
          ),
        }}
        defaultValues={emptySkillForm}
        error={saveSkill.error}
        onSubmit={async (values) => {
          // Admin-authored skills are the deployment's; a person's own are made on Capabilities.
          await saveSkill.mutateAsync({ ...values, global: true });
          await navigate(paths.skill(values.slug.trim()));
        }}
        submitLabel="保存技能"
      />
    </PageShell>
  );
}
