import {
  IconBolt,
  IconChevronRight,
  IconFileOff,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { SkillFields } from "@/components/skills/skill-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { grantRoster } from "@/lib/agents/grant-roster";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useManagePaths } from "@/lib/manage-paths";
import {
  removeSkillMutationOptions,
  saveSkillMutationOptions,
  setPluginGrantMutationOptions,
} from "@/lib/plugins/mutations";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * One of the deployment's skills: which Bots offer it, what it says, and removing it.
 *
 * Bots first, because a skill no Bot offers does nothing, and that is the decision made most often
 * here. Each Bot is one row with one switch, as on a tool's page (`plugin-tool-page.tsx`), where the
 * list used to draw a chip per Bot inside every skill's row.
 *
 * Editing saves the same way creating does: `POST /api/plugins/skills` upserts on the slug and
 * leaves the owner alone, so the command is fixed here (`slugLocked`).
 */
export function SkillPage({ slug }: { slug: string }) {
  const paths = useManagePaths();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  /* The ones this person has hidden, so a grant one of them holds still has its switch here. */
  const { data: hiddenAgents } = useQuery(agentListQueryOptions(true));
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const setGrant = useMutation({
    ...setPluginGrantMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
  });
  const saveSkill = useMutation(saveSkillMutationOptions(queryClient));
  const removeSkill = useMutation(removeSkillMutationOptions(queryClient));

  const back = { label: "技能", linkProps: paths.skills() };
  const skill = plugins.data?.skills.find(
    (candidate) => candidate.slug === slug,
  );

  /* Nothing rather than a placeholder, so no sentence asserts anything while the fetch is open. */
  if (plugins.isPending) {
    return (
      <PageShell backButton={back} title="技能">
        {null}
      </PageShell>
    );
  }

  /* A list that could not be read is not a missing skill: `isPending` goes false on a failure too. */
  if (!plugins.data) {
    return (
      <PageShell backButton={back} title="技能">
        <p className="text-destructive text-sm" role="alert">
          这个技能没能加载，请刷新页面。
        </p>
      </PageShell>
    );
  }

  if (!skill) {
    return (
      <PageShell backButton={back} title="技能">
        <PageEmpty icon={IconFileOff} title="找不到这个技能">
          它可能已被删除。回到技能列表看看现有的技能。
        </PageEmpty>
      </PageShell>
    );
  }

  const bots = grantRoster({
    roster: agents ?? [],
    hidden: hiddenAgents ?? [],
    holders: skill.grantedTo,
  });

  return (
    <PageShell
      backButton={back}
      {...(skill.summary ? { description: skill.summary } : {})}
      title={skill.title}
    >
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <PageSection
        description={
          <>
            Bots with their switch on offer {skill.title} when someone types{" "}
            <code>/</code>. It takes effect at once.
          </>
        }
        title="员工"
      >
        {bots.length === 0 ? (
          <PageEmpty icon={IconBolt} title="还没有员工">
            先创建一位员工来提供这个技能。
          </PageEmpty>
        ) : (
          <PageRows>
            {bots.map((bot, index) => {
              const held = skill.grantedTo.includes(bot.id);
              return (
                <div key={bot.id}>
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{bot.name}</ItemTitle>
                      <ItemDescription>
                        {bot.hidden ? "已从你的名单里隐藏。" : ""}
                        {held ? "提供这个技能。" : "不提供这个技能。"}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * Binary and immediate: it takes effect when switched and there is no save.
                       * Disabled only while its own write is in flight, so switching one Bot does
                       * not freeze the rest of the list.
                       */}
                      <Switch
                        aria-label={`${bot.name} 提供 ${skill.title}`}
                        checked={held}
                        disabled={
                          setGrant.isPending &&
                          setGrant.variables?.agentId === bot.id
                        }
                        onCheckedChange={(next) => {
                          setError(null);
                          setGrant.mutate({
                            agentId: bot.id,
                            granted: next,
                            kind: "skill",
                            ref: skill.slug,
                          });
                        }}
                      />
                    </ItemActions>
                  </Item>
                  {index !== bots.length - 1 && <Separator />}
                </div>
              );
            })}
          </PageRows>
        )}
      </PageSection>

      <SkillFields
        // No Cancel: the Bots above save on their own, and Back is the way out.
        sections={{}}
        defaultValues={{
          slug: skill.slug,
          title: skill.title,
          summary: skill.summary ?? "",
          instructions: skill.instructions,
          // A skill written before this field existed opens with nothing ticked.
          tools: skill.tools ?? [],
        }}
        error={saveSkill.error}
        // Remounted after a save, so the form starts again from what the server now holds.
        key={`${skill.title}\u0000${skill.summary}\u0000${skill.instructions}`}
        onSubmit={async (values) => {
          await saveSkill.mutateAsync({ ...values, global: true });
          toast.add({ title: "技能已保存", type: "success" });
        }}
        slugLocked
        submitLabel="保存修改"
      />

      {/* A row that opens the confirmation, as deleting a Bot is on its own page. */}
      <PageSection title="管理">
        <PageRows>
          <Item
            render={<button onClick={() => setRemoving(true)} type="button" />}
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconTrash />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>删除</ItemTitle>
              <ItemDescription>
                删除后没人能再运行它，也没有员工会提供它。此操作无法撤销。
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      <Dialog onOpenChange={setRemoving} open={removing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 {skill.title}？</DialogTitle>
            <DialogDescription>
              删除后没人能再运行它，也没有员工会提供它。此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          {removeSkill.error ? (
            <p className="text-destructive text-sm" role="alert">
              {removeSkill.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setRemoving(false)}
              size="sm"
              variant="ghost"
            >
              取消
            </Button>
            <Button
              disabled={removeSkill.isPending}
              onClick={() =>
                removeSkill.mutate(skill.slug, {
                  onSuccess: () => navigate(paths.skills()),
                })
              }
              size="sm"
              variant="destructive"
            >
              {removeSkill.isPending ? "正在删除…" : "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
