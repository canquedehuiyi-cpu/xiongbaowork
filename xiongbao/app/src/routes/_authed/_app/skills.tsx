import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacySkillsTarget } from "@/lib/agents/legacy-routes";

/**
 * `/skills` 现在是能力 › 技能（M5b，与上游一致）。对话里提议的技能会链到这里，那些消息还留在历史里，所以保留成
 * 重定向；`/skills?new=true` 仍打开写技能的面板，`/skills?edit=<slug>` 仍打开那条技能。
 */
export const Route = createFileRoute("/_authed/_app/skills")({
  validateSearch: (search: Record<string, unknown>) => {
    // A numeric slug arrives as a number: the default search parser reads `?edit=42` as JSON.
    const edit =
      typeof search.edit === "number" ? String(search.edit) : search.edit;
    return {
      ...(search.new === true || search.new === "true"
        ? { new: true as const }
        : {}),
      ...(typeof edit === "string" && edit ? { edit } : {}),
    } as { new?: true; edit?: string };
  },
  beforeLoad: ({ search }) => {
    throw redirect(legacySkillsTarget(search));
  },
});
