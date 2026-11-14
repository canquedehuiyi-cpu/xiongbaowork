import { IconDots, IconPencil } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { DetailPanel } from "@/components/layout/detail-panel";
import {
  ResourceCard,
  textMatch,
} from "@/components/resources/capability-tabs";
import {
  CardGrid,
  NoMatch,
  QueryState,
  TabHeader,
  TabSearch,
  Tag,
} from "@/components/resources/resource-kit";
import { EditSkill } from "@/components/skills/edit-skill";
import { NewSkill } from "@/components/skills/new-skill";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { removeSkillMutationOptions } from "@/lib/plugins/mutations";
import {
  installListingsQueryOptions,
  listedRefs,
  type PluginSkill,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { useZh } from "@/lib/translations/queries";

/**
 * 能力与资源 › 技能: the whole skills screen, the one place a person writes, edits and deletes their
 * own `/` skills and sees the deployment's.
 *
 * It used to be two screens — the standalone `/skills` page with the authoring panel, and a summary
 * tab here that linked out to it. The page was archived into this tab (`/skills` now redirects
 * here, `new` and `edit` carried over), so the tab holds both: the page's command, menu and panel,
 * and the summary's search, grant counts and 可自助安装 tag.
 *
 * Writing and editing are search parameters rather than routes (`?new=true`, `?edit=<slug>`), so
 * the list stays on screen behind the panel and the form is linkable, reloadable and closed by Back.
 * The caller owns them; this draws whatever it is given.
 *
 * Only the signed-in person's own count as 我的. The server already scopes `/api/plugins` to
 * `owner_user_id is null or owner_user_id = me`, except for an administrator, who receives everyone's
 * personal skills; those are governed on the administrator's skill screen and belong in neither
 * group here. A deployment skill an administrator listed (上架, spec E3) carries 可自助安装; the
 * listings are a separate read, so failing to read them drops the tag and nothing else.
 */
export function SkillsScreen({
  query,
  onQuery,
  creating,
  editing,
  onCompose,
  onEdit,
  onClose,
}: {
  query: string;
  onQuery: (value: string) => void;
  /** `?new=true`: the authoring panel is open. It wins over `editing`, the more recent intent. */
  creating: boolean;
  /** `?edit=<slug>`: the slug being edited. */
  editing: string | undefined;
  onCompose: () => void;
  onEdit: (slug: string) => void;
  onClose: () => void;
}) {
  const zh = useZh();
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const me = useQuery(currentUserQueryOptions());
  const listings = useQuery(installListingsQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const [error, setError] = useState<string | null>(null);
  const removeSkill = useMutation({
    ...removeSkillMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: () => setError(null),
  });

  const showEdit = !creating && editing !== undefined;
  const skills = plugins.data?.skills ?? [];
  const meId = me.data?.id;
  // Only the person's own employees (summoned ones included) count as having the skill installed;
  // grants to shared preset employees or other people's employees are not theirs.
  const myAgentIds = new Set(
    (agents.data ?? []).filter((agent) => agent.mine).map((agent) => agent.id),
  );
  const visible = skills.filter((skill) =>
    textMatch(
      query,
      skill.title,
      skill.summary,
      skill.slug,
      zh(skill.title),
      zh(skill.summary),
    ),
  );
  const isMine = (skill: PluginSkill) =>
    skill.ownerUserId !== null && skill.ownerUserId === meId;
  const mine = visible.filter(isMine);
  const deployment = visible.filter((skill) => skill.ownerUserId === null);
  const listed = listedRefs(listings.data, "skill");
  const anyOwnOrDeployment = skills.some(
    (skill) => skill.ownerUserId === null || isMine(skill),
  );

  const card = (skill: PluginSkill, own: boolean) => (
    <ResourceCard
      actions={
        <>
          <span className="text-[12px] text-muted-foreground">
            {installedSentence(
              skill.grantedTo.filter((id) => myAgentIds.has(id)).length,
            )}
          </span>
          {/*
           * Only on the person's own. A deployment skill is not theirs to edit or delete, and the
           * server refuses either way; an affordance that only ever fails is a promise this screen
           * cannot keep.
           */}
          {own ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label={`${skill.title} 的操作`}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <IconDots />
                  </Button>
                }
              />
              <DropdownMenuContent>
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => onEdit(skill.slug)}>
                    编辑
                  </DropdownMenuItem>
                  {/*
                   * Immediate, with no undo: behind a menu for that reason, and the slug is named in
                   * the label so the destructive item says WHICH skill it destroys.
                   */}
                  <DropdownMenuItem
                    onClick={() => {
                      setError(null);
                      removeSkill.mutate(skill.slug);
                    }}
                    variant="destructive"
                  >
                    删除 /{skill.slug}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </>
      }
      description={
        // The command first: the title says what the skill is for, `/slug` is what a person types.
        <>
          <code className="font-mono text-foreground/80 text-xs">
            /{skill.slug}
          </code>
          {skill.summary ? ` · ${zh(skill.summary)}` : null}
        </>
      }
      key={skill.id}
      title={
        <>
          {zh(skill.title)}
          {!own && listed.has(skill.slug) ? <Tag>可自助安装</Tag> : null}
        </>
      }
    />
  );

  return (
    <DetailPanel
      detail={
        creating ? (
          <NewSkill />
        ) : editing !== undefined ? (
          <EditSkill slug={editing} />
        ) : null
      }
      onClose={onClose}
      open={creating || showEdit}
    >
      <TabHeader
        actions={
          <Button onClick={onCompose} size="sm">
            <IconPencil />
            撰写
          </Button>
        }
        description={
          <>
            技能是一条具名指令：用 <code>/</code>{" "}
            加它的名字唤起，由员工照着执行。你写的在“我的”里，只装在你拥有的员工身上；管理员写的在“部署”里，按员工授予给他们，标着可自助安装的由你在员工装配页里自己装上。
          </>
        }
        search={<TabSearch label="搜索技能" onChange={onQuery} value={query} />}
      />
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <QueryState
        label="读不到技能"
        query={{ ...plugins, isPending: plugins.isPending || me.isPending }}
      >
        {query.trim() &&
        anyOwnOrDeployment &&
        mine.length + deployment.length === 0 ? (
          <NoMatch onClear={() => onQuery("")} title="没有匹配的技能" />
        ) : (
          <>
            <SkillGroup
              empty={
                query.trim()
                  ? "没有匹配的技能。"
                  : me.error
                    ? "读不到你自己的技能。"
                    : "你还没有写过技能。"
              }
              rows={mine.map((skill) => card(skill, true))}
              title="我的"
            />
            <SkillGroup
              empty={
                query.trim()
                  ? "没有匹配的技能。"
                  : "这个部署还没有管理员写的技能。"
              }
              rows={deployment.map((skill) => card(skill, false))}
              title="部署"
            />
          </>
        )}
      </QueryState>
    </DetailPanel>
  );
}

/** 「已装到你的 N 个员工」, or 「未安装」 when none of the person's own employees holds it. */
function installedSentence(count: number): string {
  return count > 0 ? `已装到你的 ${count} 个员工` : "未安装";
}

function SkillGroup({
  empty,
  rows,
  title,
}: {
  empty: string;
  rows: ReactNode[];
  title: string;
}) {
  return (
    <div className="mt-5 flex flex-col gap-2">
      <h3 className="font-medium text-[13px]">
        {title}
        <span className="ml-1.5 text-muted-foreground tabular-nums">
          {rows.length}
        </span>
      </h3>
      {rows.length > 0 ? (
        <CardGrid label={`${title}的技能`}>{rows}</CardGrid>
      ) : (
        <p className="text-[13px] text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}
