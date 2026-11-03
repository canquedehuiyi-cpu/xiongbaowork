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
import {
  knowledgeForAgentQueryOptions,
  knowledgeNotebooksQueryOptions,
  setKnowledgeBindingMutationOptions,
} from "@/lib/knowledge/queries";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";
import {
  agentPluginsQueryOptions,
  installListingsQueryOptions,
  listedRefs,
  type PluginServer,
  type PluginsPage,
  type PluginSkill,
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
 * Installing goes through the grant endpoint the plugin screens already use, on purpose (and so does
 * an owner's self-install of an entry an administrator listed, spec E3): the grant,
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
          onSave={(binding) => save(binding)}
          platformModelRef={profile.platformModelRef ?? null}
        />
      </PageSection>

      <PageSection description="它是谁，和它的职责分开维护。" title="人设">
        <PersonaSection agentId={profile.id} profile={profile} />
      </PageSection>

      <SkillsZone agentId={profile.id} canManage={profile.canManage} />
      <SelfInstallToolsZone
        agentId={profile.id}
        canManage={profile.canManage}
      />
      <ConnectorZone agentId={profile.id} />
      <KnowledgeZone
        agentId={profile.id}
        canManage={profile.canManage}
        mine={profile.mine}
      />

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
 * Two kinds of box. The person's own skills, which the owner rule lets them grant; and the
 * deployment skills an administrator has listed (上架, spec E3), which the owner of a Waker may
 * install on it and take off again themselves. A deployment skill nobody listed is still an
 * administrator's to grant, so it is counted in a sentence rather than offered as a box that would
 * bounce with somebody else's refusal on it.
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
  const listings = useQuery(installListingsQueryOptions());
  const setGrant = useMutation(setPluginGrantMutationOptions(queryClient));

  const skills = page.data?.skills ?? [];
  const mine = skills.filter((skill) => skill.ownerUserId === me.data?.id);
  const listed = listedRefs(listings.data, "skill");
  const deploymentOwned = skills.filter((skill) => skill.ownerUserId === null);
  const catalogue = deploymentOwned.filter((skill) => listed.has(skill.slug));
  const unlisted = deploymentOwned.filter((skill) => !listed.has(skill.slug));
  const installed = new Set(
    (granted.data?.skills ?? []).map((skill) => skill.slug),
  );
  const busy = (slug: string) =>
    setGrant.isPending && setGrant.variables?.ref === slug;
  const toggle = (slug: string, checked: boolean) =>
    setGrant.mutate({ agentId, granted: checked, kind: "skill", ref: slug });

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
      ) : mine.length === 0 && catalogue.length === 0 ? (
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
        <>
          {mine.length > 0 ? (
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
                        disabled={!canManage || busy(skill.slug)}
                        id={`assemble-skill-${skill.slug}`}
                        onCheckedChange={(checked) =>
                          toggle(skill.slug, checked === true)
                        }
                      />
                      已安装
                    </label>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          ) : null}
          {catalogue.length > 0 ? (
            <CatalogueSkills
              busy={busy}
              canManage={canManage}
              installed={installed}
              onToggle={toggle}
              skills={catalogue}
            />
          ) : null}
        </>
      )}
      {unlisted.length > 0 ? (
        <p className="mt-3 text-muted-foreground text-sm">
          另有 {unlisted.length} 个部署技能由管理员在插件页里授予。
        </p>
      ) : null}
      {listings.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          读不到管理员上架的目录，所以这里暂时只列出你自己的技能。
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
 * 目录技能: the deployment skills an administrator listed, one box each (spec E3).
 *
 * Named by an aria-label and never wrapped in a <label>: Base UI names a checkbox after a label it
 * finds, and "已安装" would then name every box alike.
 */
function CatalogueSkills({
  skills,
  installed,
  canManage,
  busy,
  onToggle,
}: {
  skills: PluginSkill[];
  installed: Set<string>;
  canManage: boolean;
  busy: (slug: string) => boolean;
  onToggle: (slug: string, checked: boolean) => void;
}) {
  return (
    <div className="mt-4">
      <h3 className="font-medium text-sm">目录技能</h3>
      <p className="mb-2 text-muted-foreground text-xs">
        管理员上架的部署技能。你可以自己给这位员工装上或卸下，每次都会记录。
      </p>
      <ItemGroup>
        {skills.map((skill) => (
          <Item key={skill.slug} variant="muted">
            <ItemContent>
              <ItemTitle>{skill.title}</ItemTitle>
              <ItemDescription>{skill.summary}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <div className="flex items-center gap-2 text-sm">
                <Checkbox
                  aria-label={`安装目录技能 ${skill.title}`}
                  checked={installed.has(skill.slug)}
                  disabled={!canManage || busy(skill.slug)}
                  onCheckedChange={(checked) => {
                    if (!canManage) return;
                    onToggle(skill.slug, checked === true);
                  }}
                />
                <span aria-hidden="true">已安装</span>
              </div>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </div>
  );
}

/**
 * Whether an app answers as whoever is asking, so a Waker can only use it once the person has
 * connected their own account: a catalogue `user-oauth` vendor, or a brokered app that needs an
 * account (the rule the connected-accounts page lists them by).
 */
function connectsPerPerson(server: PluginServer, page: PluginsPage): boolean {
  if (server.provenance === "composio") return server.authScheme !== "NO_AUTH";
  return page.catalogue.some(
    (entry) => entry.key === server.id && entry.auth === "user-oauth",
  );
}

/**
 * 可自助安装的工具: the tools of the apps an administrator listed (spec E3), one box per tool.
 *
 * The same grant endpoint as every other grant, so the policy check and the trail row are the
 * server's; a refusal is shown as the server worded it. An app whose credential is each person's
 * own says so, because a tool installed on a Waker still cannot reach an account nobody connected.
 */
function SelfInstallToolsZone({
  agentId,
  canManage,
}: {
  agentId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const page = useQuery(pluginsPageQueryOptions());
  const granted = useQuery(agentPluginsQueryOptions(agentId));
  const listings = useQuery(installListingsQueryOptions());
  const setGrant = useMutation(setPluginGrantMutationOptions(queryClient));

  const listedApps = [...listedRefs(listings.data, "mcp")];
  const servers = page.data?.servers ?? [];
  const heldRefs = new Set((granted.data?.tools ?? []).map((tool) => tool.ref));

  return (
    <PageSection
      description="管理员上架的应用里的工具。勾选即装到这位员工上并记录；取消勾选即卸下。"
      title="可自助安装的工具"
    >
      {page.isPending || listings.isPending || granted.isPending ? (
        <Skeleton className="h-14" />
      ) : page.error || listings.error || granted.error ? (
        <p className="text-destructive text-sm" role="alert">
          读不到可自助安装的工具。
        </p>
      ) : listedApps.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          管理员还没有上架任何应用。
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {listedApps.map((key) => {
            const server = servers.find((row) => row.id === key);
            if (!server) {
              return (
                <p className="text-muted-foreground text-sm" key={key}>
                  {key}{" "}
                  已上架，但这个部署还没有添加它，所以暂时没有可安装的工具。
                </p>
              );
            }
            return (
              <div key={key}>
                <h3 className="font-medium text-sm">{server.title}</h3>
                {page.data && connectsPerPerson(server, page.data) ? (
                  <p className="mb-2 text-muted-foreground text-xs">
                    这个应用以使用者本人的账号访问：装上之后，还要先在
                    <Link
                      className="mx-1 underline"
                      to="/settings/connected-accounts"
                    >
                      已连接的账号
                    </Link>
                    里连接你自己的账号，员工才能真正调用。
                  </p>
                ) : null}
                {server.tools.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    这个应用目前没有提供工具。
                  </p>
                ) : (
                  <ItemGroup>
                    {server.tools.map((tool) => (
                      <Item key={tool.ref} variant="muted">
                        <ItemContent>
                          <ItemTitle>{tool.name}</ItemTitle>
                          <ItemDescription>{tool.description}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <div className="flex items-center gap-2 text-sm">
                            <Checkbox
                              aria-label={`安装工具 ${server.title}/${tool.name}`}
                              checked={
                                heldRefs.has(tool.ref) ||
                                tool.grantedTo.includes(agentId)
                              }
                              disabled={
                                !canManage ||
                                (setGrant.isPending &&
                                  setGrant.variables?.ref === tool.ref)
                              }
                              onCheckedChange={(checked) => {
                                if (!canManage) return;
                                setGrant.mutate({
                                  agentId,
                                  granted: checked === true,
                                  kind: "mcp",
                                  ref: tool.ref,
                                });
                              }}
                            />
                            <span aria-hidden="true">已安装</span>
                          </div>
                        </ItemActions>
                      </Item>
                    ))}
                  </ItemGroup>
                )}
              </div>
            );
          })}
        </div>
      )}
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
 * this coworker actually holds, and points at the screen that decides it. Tools of an app an
 * administrator listed (spec E3) are ticked in 可自助安装的工具 above and show up here as well.
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
      description="管理员在插件页里授予的，加上你在上面自助安装的。这里列出的就是这位员工运行时实际拥有的。"
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

/**
 * Which of the person's knowledge bases this coworker may read (D08 RES1), one box per base.
 *
 * A knowledge base and the binding on it belong to one person, and the server grants a binding only
 * between a person's own base and their own Waker. So the boxes are live only when the viewer both
 * manages this coworker and is the one who created it; for anybody else's coworker they are drawn
 * unticked and disabled, which is also the truth — none of the viewer's bases can be bound to it.
 * The per-Waker read is not even asked for then, because the server answers it with a 403.
 */
function KnowledgeZone({
  agentId,
  canManage,
  mine,
}: {
  agentId: string;
  canManage: boolean;
  mine: boolean;
}) {
  const queryClient = useQueryClient();
  const editable = canManage && mine;
  const notebooks = useQuery(knowledgeNotebooksQueryOptions());
  const bound = useQuery({
    ...knowledgeForAgentQueryOptions(agentId),
    enabled: mine,
  });
  const setBinding = useMutation(
    setKnowledgeBindingMutationOptions(queryClient),
  );

  const rows = notebooks.data ?? [];
  const readable = new Set(
    (bound.data ?? []).map((notebook) => notebook.notebookId),
  );
  const pending = notebooks.isPending || (mine && bound.isPending);
  const failed = notebooks.error ?? (mine ? bound.error : null);

  return (
    <PageSection
      action={
        <Button
          render={(props) => <Link {...props} to="/knowledge" />}
          size="sm"
          variant="outline"
        >
          <IconExternalLink />
          管理知识库
        </Button>
      }
      description="勾选即允许这位员工只读该知识库；取消勾选即收回。"
      title="知识库"
    >
      {pending ? (
        <Skeleton className="h-14" />
      ) : failed ? (
        <p className="text-destructive text-sm" role="alert">
          读不到知识库。
        </p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          你还没有知识库，先到知识库页里建一个。
        </p>
      ) : (
        <ItemGroup>
          {rows.map((notebook) => {
            return (
              <Item key={notebook.id} variant="muted">
                <ItemContent>
                  <ItemTitle>{notebook.title}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  {/*
                   * No <label> around or for the box: Base UI names a span checkbox after any
                   * label it finds (aria-labelledby beats aria-label), and "可读取" would then
                   * name every box alike. The box is named by its aria-label alone.
                   */}
                  <div className="flex items-center gap-2 text-sm">
                    <Checkbox
                      aria-label={`允许读取 ${notebook.title}`}
                      checked={readable.has(notebook.id)}
                      disabled={
                        !editable ||
                        (setBinding.isPending &&
                          setBinding.variables?.notebookId === notebook.id)
                      }
                      onCheckedChange={(checked) => {
                        if (!editable) return;
                        setBinding.mutate({
                          agentId,
                          granted: checked === true,
                          notebookId: notebook.id,
                        });
                      }}
                    />
                    <span aria-hidden="true">可读取</span>
                  </div>
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      )}
      {!mine && rows.length > 0 ? (
        <p className="mt-3 text-muted-foreground text-sm">
          知识库只能授权给你自己的员工。
        </p>
      ) : null}
      {setBinding.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {setBinding.error.message}
        </p>
      ) : null}
    </PageSection>
  );
}
