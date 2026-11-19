import { IconChevronRight, IconFileText, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useBotNames } from "@/lib/agents/bot-names";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  crewMembers,
  crewSummary,
  grantToMembers,
} from "@/lib/plugins/crew-grant";
import {
  removeSkillMutationOptions,
  setListingMutationOptions,
  setPluginGrantMutationOptions,
} from "@/lib/plugins/mutations";
import {
  installListingsQueryOptions,
  listedRefs,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import {
  type WakerGroup,
  wakerGroupsQueryOptions,
} from "@/lib/waker-groups/queries";

/**
 * The deployment's skills: named instructions a person invokes with `/` and a Bot follows.
 *
 * Its own screen rather than a tab on Plugins, because a skill is not a connector. It adds no
 * capability at all — it can only ask a Bot to use tools that Bot was already granted, and every one
 * of those calls is still decided, policy-checked and audited. That is why anybody may write one for
 * themselves on their own Skills page, while adding an MCP server stays an administrator's decision.
 * Sitting in a list of vendors made it look like a third kind of thing a Bot could reach.
 *
 * Kept as the fork's one list (crews, listings, a chip per coworker) rather than upstream's
 * `components/manage/skills-page.tsx`. Each row's name opens the skill's own page (upstream's
 * `admin/skills_.$slug.tsx`: a switch per coworker, editing its words and tools, deleting it), and
 * writing one is upstream's page of its own (`admin/skills_.new.tsx`), which picks its tools too.
 */
export const Route = createFileRoute("/_authed/admin/skills")({
  component: RouteComponent,
});

function RouteComponent() {
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  const nameFor = useBotNames();
  /*
   * The workspace's crews, as a way to say WHICH coworkers get a deployment skill (spec E2). A crew
   * never holds the skill itself: a press writes one grant per member, as `crew-grant.ts` explains.
   */
  const crews = useQuery(wakerGroupsQueryOptions());

  const [error, setError] = useState<string | null>(null);
  /** The last group press's sentence, on the row of the skill it was about. */
  const [batch, setBatch] = useState<{
    slug: string;
    text: string;
    failed: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const report = { onError: (thrown: Error) => setError(thrown.message) };
  const removeSkill = useMutation({
    ...removeSkillMutationOptions(queryClient),
    ...report,
  });
  const setGrant = useMutation({
    ...setPluginGrantMutationOptions(queryClient),
    ...report,
  });
  /*
   * Spec E3: which deployment skills owners may install on their own Wakers. Only a deployment
   * skill (no owner) gets the switch: the server refuses to list somebody's own skill.
   */
  const listings = useQuery(installListingsQueryOptions());
  const setListing = useMutation({
    ...setListingMutationOptions(queryClient),
    ...report,
  });
  const listedSkills = listedRefs(listings.data, "skill");

  const bots = (agents ?? []).map((agent: { id: string }) => ({
    id: agent.id,
    name: nameFor(agent.id),
  }));
  const skills = plugins.data?.skills ?? [];
  const known = new Set(bots.map((bot) => bot.id));

  async function grantToCrew(
    slug: string,
    crew: WakerGroup,
    agentIds: string[],
  ) {
    setBatch(null);
    setBusy(true);
    try {
      const outcome = await grantToMembers({
        queryClient,
        kind: "skill",
        refs: [slug],
        agentIds,
      });
      setBatch({
        slug,
        ...crewSummary(outcome, { label: crew.name, what: `/${slug}` }),
      });
    } catch (thrown) {
      setError((thrown as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell
      action={
        <Button
          render={(props) => <Link to="/admin/skills/new" {...props} />}
          size="lg"
        >
          <IconPlus />
          写一个技能
        </Button>
      }
      description="这里任何人都能用斜杠调用的具名指令。技能不会增加能力：它只能请员工使用它已经拥有的东西，而且每一次调用照样要经过决定并留下记录。"
      title="技能"
    >
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <PageSection
        description="为整个部署写的。个人在自己的技能页里写自己的。打开「上架」后，员工的主人可以在装配页里自己给员工装上或卸下这个技能。"
        title="已安装"
      >
        {/* A read that failed says so; `isPending` goes false on it too, and it is not "none". */}
        {plugins.isPending ? null : !plugins.data ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            读不到技能。
          </p>
        ) : skills.length === 0 ? (
          <PageEmpty>还没有技能。</PageEmpty>
        ) : (
          <PageRows>
            {listings.error &&
            skills.some((skill) => skill.ownerUserId === null) ? (
              <p className="text-destructive text-sm" role="alert">
                读不到上架目录，所以上架开关暂时不能切换。
              </p>
            ) : null}
            {skills.map((skill, index) => (
              <React.Fragment key={skill.slug}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconFileText className="size-4" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      <Link
                        className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                        params={{ slug: skill.slug }}
                        to="/admin/skills/$slug"
                      >
                        <code className="font-mono text-foreground/80 text-xs">
                          /{skill.slug}
                        </code>{" "}
                        {skill.title}
                        <IconChevronRight
                          aria-hidden="true"
                          className="size-3.5 text-muted-foreground"
                        />
                      </Link>
                    </ItemTitle>
                    <ItemDescription>{skill.summary}</ItemDescription>
                    {/* A set, so it wraps onto its own line rather than crowding the title. */}
                    <ItemFooter className="flex-col items-start">
                      <div className="flex flex-wrap gap-2">
                        {bots.map((bot) => {
                          const held = skill.grantedTo.includes(bot.id);
                          return (
                            <Button
                              key={bot.id}
                              onClick={() =>
                                setGrant.mutate({
                                  agentId: bot.id,
                                  granted: !held,
                                  kind: "skill",
                                  ref: skill.slug,
                                })
                              }
                              size="sm"
                              type="button"
                              variant={held ? "default" : "outline"}
                            >
                              {bot.name}
                            </Button>
                          );
                        })}
                      </div>
                      {(crews.data ?? []).length === 0 ? null : (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-muted-foreground text-xs">
                            或者交给一个群组：
                          </span>
                          {(crews.data ?? []).map((crew) => {
                            /* The chip's number is the writes it will make: members not holding it yet. */
                            const missing = crewMembers(
                              crew,
                              (agentId) =>
                                known.has(agentId) &&
                                !skill.grantedTo.includes(agentId),
                            );
                            return (
                              <Button
                                aria-label={`把 /${skill.slug} 交给${crew.name}`}
                                disabled={busy || missing.length === 0}
                                key={crew.id}
                                onClick={() =>
                                  void grantToCrew(skill.slug, crew, missing)
                                }
                                size="sm"
                                type="button"
                                variant="outline"
                              >
                                {crew.name} · {missing.length}
                              </Button>
                            );
                          })}
                        </div>
                      )}
                      {batch && batch.slug === skill.slug ? (
                        <p
                          className={
                            batch.failed
                              ? "text-destructive text-xs"
                              : "text-muted-foreground text-xs"
                          }
                          role={batch.failed ? "alert" : "status"}
                        >
                          {batch.text}
                        </p>
                      ) : null}
                    </ItemFooter>
                  </ItemContent>
                  <ItemActions>
                    {skill.ownerUserId === null ? (
                      <div className="flex items-center gap-2 text-sm">
                        <Switch
                          aria-label={`上架 /${skill.slug}`}
                          checked={listedSkills.has(skill.slug)}
                          disabled={
                            !listings.data ||
                            (setListing.isPending &&
                              setListing.variables?.ref === skill.slug)
                          }
                          onCheckedChange={(next) => {
                            setError(null);
                            setListing.mutate({
                              kind: "skill",
                              listed: next,
                              ref: skill.slug,
                            });
                          }}
                        />
                        <span aria-hidden="true">上架</span>
                      </div>
                    ) : null}
                    <Button
                      onClick={() => removeSkill.mutate(skill.slug)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      移除
                    </Button>
                  </ItemActions>
                </Item>
                {index !== skills.length - 1 && <Separator />}
              </React.Fragment>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
