import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { SkillFields } from "@/components/skills/skill-fields";
import { saveSkillMutationOptions } from "@/lib/plugins/mutations";
import { emptySkillForm } from "@/lib/skills/form";

/**
 * Writing a skill, in the detail panel beside the list.
 *
 * The panel rather than a page of its own, so the skills you already have stay on screen while you
 * write the next one — the usual reason to open this is to make a variant of one that exists.
 */
export function NewSkill() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const createSkill = useMutation(saveSkillMutationOptions(queryClient));

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">新建技能</h1>
        <p className="mt-1 text-sm text-muted-foreground">
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
          用 <code>/</code>调用的具名指令。它会交给你自己的员工，别人看不到。
=======
          An instruction you start with <code>/</code>. Only you see it, and it
          works on Bots you own.
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
        </p>
      </header>

      <SkillFields
        defaultValues={emptySkillForm}
        error={createSkill.error}
        onSubmit={async (values) => {
          await createSkill.mutateAsync(values);
          // Panel closed rather than swapped for a detail view: there is nothing more to say about a
          // skill than the form just said, and the new row is already behind it in the list.
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
          await navigate({ search: { tab: "skills" }, to: "/resources" });
=======
          await navigate({ search: {}, to: "/capabilities/skills" });
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
        }}
        submitLabel="保存技能"
      />
    </div>
  );
}
