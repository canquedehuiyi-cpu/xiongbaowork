import { IconExternalLink } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  ModelItem,
  PersonaSection,
  useProfileSave,
} from "@/components/agents/agent-dialog";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { RoutinesList } from "@/components/routines/routines-list";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { agentQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";
import {
  agentPluginsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * One coworker, assembled in one screen (ticket 015).
 *
 * WHY ITS OWN SCREEN. Everything it touches already has somewhere to live — the model picker and the
 * persona in the coworker's dialog, the skills on their page, the routines on theirs — and that is
 * the problem this solves. Assembling a reviewer meant a model in one dialog, a skill on another
 * page, a routine on a third, with no view of whether the three agree about who this is. The dialog
 * stays the place to change one fact; this is the place to decide what the coworker IS, and both
 * write through the same hooks and endpoints, so neither can be a second answer to a saved value.
 *
 * Installing goes through the grant endpoint the plugin screens already use, on purpose: the grant,
 * the policy check and the audit row are one server-side write, and a second path that put a skill on
 * a Bot would be a second place to get any of the three wrong.
 */
export const Route = createFileRoute("/_authed/_app/assemble/$agentId")({
  component: AssemblePage,
});

function AssemblePage() {
  const { agentId } = Route.useParams();
  const agent = useQuery(agentQueryOptions(agentId));
  const profile = agent.data;
  const { save } = useProfileSave(agentId, profile ?? emptyProfile);

  if (agent.isPending) {
    return (
      <PageShell title="装配">
        <Skeleton className="mt-6 h-16" />
      </PageShell>
    );
  }
  if (!profile) {
    return (
      <PageShell title="装配">
        <p className="mt-6 text-destructive text-sm" role="alert">
          你不能装配这位员工。
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell
      backButton={{
        label: "员工",
        linkProps: { search: {}, to: "/agents" },
      }}
      description="它用的模型、它的性格、它能碰到什么——一起决定，从下一轮开始生效。"
      title={profile.name}
    >
      <div className="mt-4 flex items-center gap-3">
        <AbstractAvatar
          name={profile.name}
          seed={profile.avatarSeed}
          size={40}
        />
        <div className="min-w-0">
          <p className="truncate font-medium">{profile.title}</p>
          <p className="line-clamp-2 text-muted-foreground text-sm">
            {profile.roleDescription}
          </p>
        </div>
      </div>

      {!profile.canManage ? (
        <p className="mt-4 text-muted-foreground text-sm">
          这位员工归别人所有，所以这里只能看，要改请到它主人那里。
        </p>
      ) : null}

      <PageSection description="这位员工说话时由哪个模型回答。" title="模型">
        <ModelItem
          builtIn={profile.builtIn}
          canManage={profile.canManage}
          modelRef={profile.modelRef}
          onSave={(modelRef) => save({ modelRef })}
        />
      </PageSection>

      <PageSection description="它是谁，和它的职责分开维护。" title="人设">
        <PersonaSection agentId={profile.id} profile={profile} />
      </PageSection>

      <SkillsZone agentId={profile.id} canManage={profile.canManage} />
      <ConnectorZone agentId={profile.id} />

      <PageSection description="它按计划自己做的事。" title="定时任务">
        <RoutinesList agentId={profile.id} embedded />
      </PageSection>
    </PageShell>
  );
}

/**
 * Stands in for the profile while it loads, so the save hook is called on every render rather than
 * only after the row arrives.
 *
 * Nothing on screen reads it — the loading branch returns first — and an empty `id` means a save
 * built from it could only ever fail on the server, which is the right way for a write that should
 * never happen to fail.
 */
const emptyProfile = {
  id: "",
  name: "",
  title: "",
  roleDescription: "",
  avatarSeed: "",
  visibility: "private" as const,
  builtIn: false,
  endpoint: null,
  modelRef: null,
  persona: null,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: false,
  mine: false,
};

/**
 * The skills that can be put on this coworker, with a box for each.
 *
 * Only the person's own skills are offered: a deployment-owned skill is refused by the same server
 * rule that grants the others, and a box that bounces with somebody else's sentence on it is a worse
 * answer than a line saying who decides.
 */
function SkillsZone({
  agentId,
  canManage,
}: {
  agentId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const page = useQuery(pluginsPageQueryOptions());
  const granted = useQuery(agentPluginsQueryOptions(agentId));
  const me = useQuery(currentUserQueryOptions());
  const setGrant = useMutation(setPluginGrantMutationOptions(queryClient));

  const skills = page.data?.skills ?? [];
  const mine = skills.filter((skill) => skill.ownerUserId === me.data?.id);
  const deploymentOwned = skills.filter((skill) => skill.ownerUserId === null);
  const installed = new Set(
    (granted.data?.skills ?? []).map((skill) => skill.slug),
  );

  return (
    <PageSection
      description="工作需要时它会遵循的指令。勾选即把技能授予这位员工并记录这次授权；取消勾选即收回。"
      title="技能"
    >
      {page.isPending || granted.isPending ? (
        <Skeleton className="h-14" />
      ) : page.error || granted.error ? (
        <p className="text-destructive text-sm" role="alert">
          读不到技能列表。
        </p>
      ) : mine.length === 0 ? (
        <Empty className="h-[120px] border border-dashed">
          <EmptyHeader>
            <EmptyTitle className="text-muted-foreground">
              你还没有可以安装的技能
            </EmptyTitle>
            <EmptyDescription>
              技能先在技能页里写好，再在这里授予员工。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup>
          {mine.map((skill) => (
            <Item key={skill.slug} variant="muted">
              <ItemContent>
                <ItemTitle>{skill.title}</ItemTitle>
                <ItemDescription>{skill.summary}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <label
                  className="flex items-center gap-2 text-sm"
                  htmlFor={`assemble-skill-${skill.slug}`}
                >
                  <Checkbox
                    checked={installed.has(skill.slug)}
                    disabled={
                      !canManage ||
                      (setGrant.isPending &&
                        setGrant.variables?.ref === skill.slug)
                    }
                    id={`assemble-skill-${skill.slug}`}
                    onCheckedChange={(checked) =>
                      setGrant.mutate({
                        agentId,
                        granted: checked === true,
                        kind: "skill",
                        ref: skill.slug,
                      })
                    }
                  />
                  已安装
                </label>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
      {deploymentOwned.length > 0 ? (
        <p className="mt-3 text-muted-foreground text-sm">
          另有 {deploymentOwned.length} 个部署技能由管理员在插件页里授予。
        </p>
      ) : null}
      {setGrant.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {setGrant.error.message}
        </p>
      ) : null}
    </PageSection>
  );
}

/**
 * What it can reach, read rather than chosen.
 *
 * A connector's tools are granted by an administrator because the connector belongs to the
 * deployment, not to the person: a box here would be a request to hand out somebody else's
 * credentials, refused by the same server rule that shows the refusal. So this says what a run of
 * this coworker actually holds, and points at the screen that decides it.
 */
function ConnectorZone({ agentId }: { agentId: string }) {
  const granted = useQuery(agentPluginsQueryOptions(agentId));
  const tools = granted.data?.tools ?? [];
  return (
    <PageSection
      action={
        <Button
          render={(props) => <Link {...props} to="/admin/plugins" />}
          size="sm"
          variant="outline"
        >
          <IconExternalLink />
          决定授权
        </Button>
      }
      description="在插件页里授予。这里列出的就是这位员工运行时实际拥有的。"
      title="连接器"
    >
      {granted.isPending ? (
        <Skeleton className="h-14" />
      ) : tools.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          什么都没授予，所以它只能对话。
        </p>
      ) : (
        <ItemGroup>
          {tools.map((tool) => (
            <Item key={tool.ref} variant="muted">
              <ItemContent>
                <ItemTitle>{tool.toolName}</ItemTitle>
                <ItemDescription>{tool.description}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
    </PageSection>
  );
}
