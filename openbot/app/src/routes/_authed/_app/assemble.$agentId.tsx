import { IconExternalLink, IconUserCircle } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  ModelItem,
  PersonaSection,
  useProfileSave,
} from "@/components/agents/agent-dialog";
import {
  PANEL_FACE,
  ProfileAlert,
  ProfileEmpty,
  ProfilePanel,
  ProfileSection,
} from "@/components/bot-profile/profile-kit";
import { PageShell } from "@/components/layout/page-shell";
import { RoutinesList } from "@/components/routines/routines-list";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { wakersBackLink } from "@/components/wakers/wakers-search";
import { type AgentProfile, agentQueryOptions } from "@/lib/agents/queries";
import { cn } from "@/lib/utils";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  knowledgeForAgentQueryOptions,
  knowledgeNotebooksQueryOptions,
  setKnowledgeBindingMutationOptions,
} from "@/lib/knowledge/queries";
import { isBrokeredProvenance } from "@/lib/plugins/brokered";
import {
  invalidatePlugins,
  setPluginGrantMutationOptions,
} from "@/lib/plugins/mutations";
import {
  agentPluginsQueryOptions,
  appKeyOf,
  installedByMeQueryOptions,
  installListingsQueryOptions,
  listedRefs,
  type PluginServer,
  type PluginSkill,
  type PluginsPage,
  type PluginTool,
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

  const back = { label: "员工", linkProps: wakersBackLink() };
  if (agent.isPending) {
    return (
      <PageShell backButton={back} title="装配" width="workbench">
        <Skeleton
          aria-label="正在读取员工"
          className="h-[92px] rounded-[16px]"
          role="status"
        />
      </PageShell>
    );
  }
  if (!profile) {
    return (
      <PageShell backButton={back} title="装配" width="workbench">
        <p
          className={cn(
            PANEL_FACE,
            "max-w-[640px] px-[16px] py-[14px] text-[13px] text-destructive",
          )}
          role="alert"
        >
          你不能装配这位员工。
        </p>
      </PageShell>
    );
  }

  /*
   * Drawn in the workbench frame (docs/design/ios-studio), in the detail page's card language: the
   * employee's face and role as a short 「角色档案」 strip, then the zones in two columns on a wide
   * screen — who it is (model, persona, routines) on the left, what it can reach (skills, tools,
   * connectors, knowledge) on the right — and one column on anything narrower.
   */
  return (
    <PageShell
      action={
        <Button
          render={(props) => (
            <Link
              params={{ agentId: profile.id }}
              to="/wakers/$agentId"
              {...props}
            />
          )}
          variant="outline"
        >
          <IconUserCircle />
          员工详情
        </Button>
      }
      backButton={back}
      crumb={`装配 · ${profile.name}`}
      description="它用的模型、它的性格、它能碰到什么——一起决定，从下一轮开始生效。"
      title={profile.name}
      width="workbench"
    >
      <div
        className={cn(
          PANEL_FACE,
          "flex min-w-0 items-center gap-[12px] rounded-[16px] px-[16px] py-[13px]",
        )}
      >
        <span className="inline-flex shrink-0 rounded-[13px] shadow-[0_0_0_1px_color-mix(in_oklab,var(--foreground)_13%,transparent)] [&_svg]:scale-[1.42]">
          <AbstractAvatar
            name={profile.name}
            portrait={{ kind: "coworker", id: profile.id }}
            seed={profile.avatarSeed}
            size={44}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold text-[15px] leading-[22px]">
            {profile.title}
          </p>
          <p className="line-clamp-2 text-[13px] text-muted-foreground leading-[1.55]">
            {profile.roleDescription}
          </p>
        </div>
      </div>

      {!profile.canManage ? (
        <p className="mt-[12px] rounded-[14px] border border-border border-dashed px-[14px] py-[11px] text-[13px] text-muted-foreground">
          这位员工归别人所有，所以这里只能看，要改请到它主人那里。
        </p>
      ) : null}

      <div className="mt-[28px] grid grid-cols-1 gap-[28px] min-[1180px]:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-[28px]">
          <ProfileSection
            description="这位员工说话时由哪个模型回答。"
            title="模型"
          >
            <div className={cn(PANEL_FACE, "mt-[10px] overflow-hidden")}>
              <ModelItem
                builtIn={profile.builtIn}
                canManage={profile.canManage}
                modelRef={profile.modelRef}
                onSave={(binding) => save(binding)}
                platformModelRef={profile.platformModelRef ?? null}
              />
            </div>
          </ProfileSection>

          <ProfileSection
            description="它是谁，和它的职责分开维护。"
            title="人设"
          >
            <div className={cn(PANEL_FACE, "mt-[10px] px-[14px] py-[12px]")}>
              <PersonaSection agentId={profile.id} profile={profile} />
            </div>
          </ProfileSection>

          <ProfileSection description="它按计划自己做的事。" title="定时任务">
            <div className="mt-[10px]">
              <RoutinesList agentId={profile.id} embedded />
            </div>
          </ProfileSection>
        </div>
        <div className="flex min-w-0 flex-col gap-[28px]">
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
        </div>
      </div>
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
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
} satisfies AgentProfile;

/**
 * The grant mutation, with every write still in flight tracked by what it names.
 *
 * `useMutation`'s own `variables` are only the LATEST call's: ticking a second box made the first
 * look settled while its request was still out, and a second press on it could send a grant and a
 * revoke that crossed. Tracked in the hook's own callbacks, which run for every call (the ones
 * passed to `mutate` run for the latest only).
 */
function useTrackedGrant() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const keyOf = (variables: { kind: string; ref: string }) =>
    `${variables.kind}:${variables.ref}`;
  const mutation = useMutation({
    ...setPluginGrantMutationOptions(queryClient),
    onMutate: (variables) => {
      setPending((current) => new Set(current).add(keyOf(variables)));
    },
    onSettled: (_data, _error, variables) => {
      setPending((current) => {
        const next = new Set(current);
        next.delete(keyOf(variables));
        return next;
      });
      return invalidatePlugins(queryClient);
    },
  });
  return {
    mutation,
    busy: (kind: "mcp" | "skill", ref: string) =>
      pending.has(keyOf({ kind, ref })),
  };
}

/**
 * The skills that can be put on this coworker, with a box for each.
 *
 * Two kinds of box. The person's own skills, which the owner rule lets them grant; and the
 * deployment skills an administrator has listed (上架, spec E3), which the owner of a Waker may
 * install on it and take off again themselves. A deployment skill nobody listed is still an
 * administrator's to grant, so it is counted in a sentence rather than offered as a box that would
 * bounce with somebody else's refusal on it — except one this person installed while it was listed:
 * that stays theirs to take off after it is unlisted (下架), so it keeps its box, for removing only.
 */
function SkillsZone({
  agentId,
  canManage,
}: {
  agentId: string;
  canManage: boolean;
}) {
  const page = useQuery(pluginsPageQueryOptions());
  const granted = useQuery(agentPluginsQueryOptions(agentId));
  const me = useQuery(currentUserQueryOptions());
  const listings = useQuery(installListingsQueryOptions());
  const byMe = useQuery(installedByMeQueryOptions(agentId));
  const { mutation: setGrant, busy: busyRef } = useTrackedGrant();

  const skills = page.data?.skills ?? [];
  const mine = skills.filter((skill) => skill.ownerUserId === me.data?.id);
  const listed = listedRefs(listings.data, "skill");
  const installed = new Set(
    (granted.data?.skills ?? []).map((skill) => skill.slug),
  );
  const installedByMe = new Set(byMe.data?.skills ?? []);
  const deploymentOwned = skills.filter((skill) => skill.ownerUserId === null);
  const catalogue = deploymentOwned.filter(
    (skill) =>
      listed.has(skill.slug) ||
      (installed.has(skill.slug) && installedByMe.has(skill.slug)),
  );
  const unlisted = deploymentOwned.filter(
    (skill) => !catalogue.includes(skill),
  );
  const busy = (slug: string) => busyRef("skill", slug);
  const toggle = (slug: string, checked: boolean) =>
    setGrant.mutate({ agentId, granted: checked, kind: "skill", ref: slug });

  return (
    <ProfileSection
      description="工作需要时它会遵循的指令。勾选即把技能授予这位员工并记录这次授权；取消勾选即收回。"
      title="技能"
    >
      {page.isPending || granted.isPending ? (
        <Skeleton className="mt-[10px] h-[54px] rounded-[14px]" />
      ) : page.error || granted.error ? (
        <ProfileAlert>读不到技能列表。</ProfileAlert>
      ) : mine.length === 0 && catalogue.length === 0 ? (
        <ProfileEmpty>
          <span className="block font-medium text-foreground/80">
            你还没有可以安装的技能
          </span>
          <span className="mt-[2px] block">
            技能先在技能页里写好，再在这里授予员工。
          </span>
        </ProfileEmpty>
      ) : (
        <>
          {mine.length > 0 ? (
            <ProfilePanel>
              {mine.map((skill) => (
                <Item key={skill.slug} size="sm">
                  <ItemContent>
                    <ItemTitle>{skill.title}</ItemTitle>
                    <ItemDescription>{skill.summary}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <label
                      className="flex items-center gap-[7px] text-[12.5px] text-muted-foreground"
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
            </ProfilePanel>
          ) : null}
          {catalogue.length > 0 ? (
            <CatalogueSkills
              busy={busy}
              canManage={canManage}
              installed={installed}
              listed={listed}
              onToggle={toggle}
              skills={catalogue}
            />
          ) : null}
        </>
      )}
      {unlisted.length > 0 ? (
        <p className="mt-[8px] text-[12.5px] text-muted-foreground">
          另有 {unlisted.length} 个部署技能由管理员在插件页里授予。
        </p>
      ) : null}
      {listings.error ? (
        <p className="mt-[8px] text-[13px] text-destructive" role="alert">
          读不到管理员上架的目录，所以这里暂时只列出你自己的技能。
        </p>
      ) : null}
      {setGrant.error ? (
        <p className="mt-[8px] text-[13px] text-destructive" role="alert">
          {setGrant.error.message}
        </p>
      ) : null}
    </ProfileSection>
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
  listed,
  canManage,
  busy,
  onToggle,
}: {
  skills: PluginSkill[];
  installed: Set<string>;
  listed: Set<string>;
  canManage: boolean;
  busy: (slug: string) => boolean;
  onToggle: (slug: string, checked: boolean) => void;
}) {
  return (
    <div className="mt-[16px]">
      <h3 className="font-semibold text-[13px] text-foreground/90">目录技能</h3>
      <p className="mt-[2px] text-[12px] text-muted-foreground">
        管理员上架的部署技能。你可以自己给这位员工装上或卸下，每次都会记录。
      </p>
      <ProfilePanel>
        {skills.map((skill) => (
          <Item key={skill.slug} size="sm">
            <ItemContent>
              <ItemTitle>{skill.title}</ItemTitle>
              <ItemDescription>
                {listed.has(skill.slug)
                  ? skill.summary
                  : "已下架：你之前装上的仍在，可以卸下，但不能再装。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <div className="flex items-center gap-[7px] text-[12.5px] text-muted-foreground">
                <Checkbox
                  aria-label={`安装目录技能 ${skill.title}`}
                  checked={installed.has(skill.slug)}
                  disabled={
                    !canManage ||
                    busy(skill.slug) ||
                    // Unlisted: taking it off is all that is left, so an empty box is not a choice.
                    (!listed.has(skill.slug) && !installed.has(skill.slug))
                  }
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
      </ProfilePanel>
    </div>
  );
}

/**
 * Whether an app answers as whoever is asking, so a Waker can only use it once the person has
 * connected their own account: a catalogue `user-oauth` vendor, or a brokered app that needs an
 * account (the rule the connected-accounts page lists them by).
 */
export function connectsPerPerson(
  server: PluginServer,
  page: PluginsPage,
): boolean {
  if (isBrokeredProvenance(server.provenance))
    return server.authScheme !== "NO_AUTH";
  // The catalogue key, not the row id: a curated connector is the team's row `team:<key>`.
  const key = appKeyOf(server);
  return page.catalogue.some(
    (entry) => entry.key === key && entry.auth === "user-oauth",
  );
}

/**
 * 可自助安装的工具: the tools of the apps an administrator listed (spec E3), one box per tool.
 *
 * The same grant endpoint as every other grant, so the policy check and the trail row are the
 * server's; a refusal is shown as the server worded it. An app whose credential is each person's
 * own says so, because a tool installed on a Waker still cannot reach an account nobody connected.
 *
 * An app unlisted (下架) after this person installed some of its tools keeps those tools here, for
 * taking off only: the server still lets the person who installed a grant remove it, and the page
 * would otherwise lose the one control that does. What an administrator granted is not shown here.
 *
 * Apps are matched by catalogue key (`appKeyOf`), which is what a listing names, not by row id.
 */
function SelfInstallToolsZone({
  agentId,
  canManage,
}: {
  agentId: string;
  canManage: boolean;
}) {
  const page = useQuery(pluginsPageQueryOptions());
  const granted = useQuery(agentPluginsQueryOptions(agentId));
  const listings = useQuery(installListingsQueryOptions());
  const byMe = useQuery(installedByMeQueryOptions(agentId));
  const { mutation: setGrant, busy } = useTrackedGrant();

  const listed = listedRefs(listings.data, "mcp");
  const servers = page.data?.servers ?? [];
  const heldRefs = new Set((granted.data?.tools ?? []).map((tool) => tool.ref));
  const mineRefs = new Set(byMe.data?.tools ?? []);
  const isHeld = (tool: PluginTool) =>
    heldRefs.has(tool.ref) || tool.grantedTo.includes(agentId);
  // Listed apps first, then any unlisted app this person still has one of their own installs on.
  const unlistedWithMine = [
    ...new Set(
      [...mineRefs]
        .map((ref) => ref.split("/")[0] ?? "")
        .filter((key) => key && !listed.has(key)),
    ),
  ].filter((key) =>
    servers.some(
      (server) =>
        appKeyOf(server) === key &&
        server.tools.some((tool) => mineRefs.has(tool.ref) && isHeld(tool)),
    ),
  );
  const apps = [...listed, ...unlistedWithMine];

  return (
    <ProfileSection
      description="管理员上架的应用里的工具。勾选即装到这位员工上并记录；取消勾选即卸下。"
      title="可自助安装的工具"
    >
      {page.isPending || listings.isPending || granted.isPending ? (
        <Skeleton className="mt-[10px] h-[54px] rounded-[14px]" />
      ) : page.error || listings.error || granted.error ? (
        <ProfileAlert>读不到可自助安装的工具。</ProfileAlert>
      ) : apps.length === 0 ? (
        <ProfileEmpty>管理员还没有上架任何应用。</ProfileEmpty>
      ) : (
        <div className="mt-[10px] flex flex-col gap-[16px]">
          {apps.map((key) => {
            const server = servers.find((row) => appKeyOf(row) === key);
            if (!server) {
              return (
                <p className="text-[13px] text-muted-foreground" key={key}>
                  {key}{" "}
                  已上架，但这个部署还没有添加它，所以暂时没有可安装的工具。
                </p>
              );
            }
            const appListed = listed.has(key);
            const tools = appListed
              ? server.tools
              : server.tools.filter(
                  (tool) => mineRefs.has(tool.ref) && isHeld(tool),
                );
            return (
              <div key={key}>
                <h3 className="font-semibold text-[13px] text-foreground/90">
                  {server.title}
                </h3>
                {appListed ? null : (
                  <p className="mt-[2px] text-[12px] text-muted-foreground">
                    已下架：你之前装上的工具仍在，可以在这里卸下，但不能再装新的。
                  </p>
                )}
                {appListed &&
                page.data &&
                connectsPerPerson(server, page.data) ? (
                  <p className="mt-[2px] text-[12px] text-muted-foreground">
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
                {tools.length === 0 ? (
                  <ProfileEmpty>这个应用目前没有提供工具。</ProfileEmpty>
                ) : (
                  <ProfilePanel>
                    {tools.map((tool) => (
                      <Item key={tool.ref} size="sm">
                        <ItemContent>
                          <ItemTitle>{tool.name}</ItemTitle>
                          <ItemDescription>{tool.description}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <div className="flex items-center gap-[7px] text-[12.5px] text-muted-foreground">
                            <Checkbox
                              aria-label={`安装工具 ${server.title}/${tool.name}`}
                              checked={isHeld(tool)}
                              disabled={
                                !canManage ||
                                busy("mcp", tool.ref) ||
                                (!appListed && !isHeld(tool))
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
                  </ProfilePanel>
                )}
              </div>
            );
          })}
        </div>
      )}
      {setGrant.error ? (
        <p className="mt-[8px] text-[13px] text-destructive" role="alert">
          {setGrant.error.message}
        </p>
      ) : null}
    </ProfileSection>
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
    <ProfileSection
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
        <Skeleton className="mt-[10px] h-[54px] rounded-[14px]" />
      ) : tools.length === 0 ? (
        <ProfileEmpty>什么都没授予，所以它只能对话。</ProfileEmpty>
      ) : (
        <ProfilePanel>
          {tools.map((tool) => (
            <Item key={tool.ref} size="sm">
              <ItemContent>
                <ItemTitle>{tool.toolName}</ItemTitle>
                <ItemDescription>{tool.description}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ProfilePanel>
      )}
    </ProfileSection>
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
    <ProfileSection
      action={
        <Button
          render={(props) => (
            <Link {...props} search={{ tab: "knowledge" }} to="/resources" />
          )}
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
        <Skeleton className="mt-[10px] h-[54px] rounded-[14px]" />
      ) : failed ? (
        <ProfileAlert>读不到知识库。</ProfileAlert>
      ) : rows.length === 0 ? (
        <ProfileEmpty>你还没有知识库，先到知识库页里建一个。</ProfileEmpty>
      ) : (
        <ProfilePanel>
          {rows.map((notebook) => {
            return (
              <Item key={notebook.id} size="sm">
                <ItemContent>
                  <ItemTitle>{notebook.title}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  {/*
                   * No <label> around or for the box: Base UI names a span checkbox after any
                   * label it finds (aria-labelledby beats aria-label), and "可读取" would then
                   * name every box alike. The box is named by its aria-label alone.
                   */}
                  <div className="flex items-center gap-[7px] text-[12.5px] text-muted-foreground">
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
        </ProfilePanel>
      )}
      {!mine && rows.length > 0 ? (
        <p className="mt-[8px] text-[12.5px] text-muted-foreground">
          知识库只能授权给你自己的员工。
        </p>
      ) : null}
      {setBinding.error ? (
        <p className="mt-[8px] text-[13px] text-destructive" role="alert">
          {setBinding.error.message}
        </p>
      ) : null}
    </ProfileSection>
  );
}
