import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { SkillsScreen } from "@/components/skills/skills-screen";

/**
 * 能力 › 技能：自己的 `/` 技能（写、改、删）和部署里管理员写的技能。
 *
 * 写技能和改技能是地址参数而不是路由（`?new=true`、`?edit=<slug>`），所以面板打开时列表仍在后面，表单可以
 * 分享、刷新，按后退就关上。`/skills` 与 `/resources?tab=skills` 的重定向把这两个参数照带过来。
 */
const skillsSearchSchema = z.object({
  new: z.boolean().optional(),
  /** The slug being edited. Absent means nothing is. */
  edit: z.string().optional(),
  /** 搜索框里的字。 */
  q: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/capabilities/skills")({
  validateSearch: (search: Record<string, unknown>) =>
    skillsSearchSchema.parse({
      // The default search parser reads `?edit=42` or `?q=42` as JSON, so a number comes back as text.
      ...(search.new === true || search.new === "true" ? { new: true } : {}),
      ...(typeof search.edit === "string" || typeof search.edit === "number"
        ? { edit: String(search.edit) }
        : {}),
      ...((typeof search.q === "string" && search.q) ||
      typeof search.q === "number"
        ? { q: String(search.q) }
        : {}),
    }),
  component: SkillsPage,
});

function SkillsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [query, setQuery] = useState(search.q ?? "");
  // 打开、关上面板都是一次导航，所以后退能撤销。搜索框里的字跟着走，不因为开关面板丢掉。
  const keepQuery = query ? { q: query } : {};
  return (
    <CapabilitiesShell>
      <SkillsScreen
        creating={search.new === true}
        editing={search.edit}
        onClose={() => navigate({ search: keepQuery })}
        onCompose={() => navigate({ search: { ...keepQuery, new: true } })}
        onEdit={(slug) => navigate({ search: { ...keepQuery, edit: slug } })}
        onQuery={(value) => {
          setQuery(value);
          navigate({
            search: (previous) => ({
              ...previous,
              q: value || undefined,
            }),
            replace: true,
          });
        }}
        query={query}
      />
    </CapabilitiesShell>
  );
}
