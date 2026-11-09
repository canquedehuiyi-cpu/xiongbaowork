import {
  IconChevronRight,
  IconListSearch,
  IconPlus,
  IconShieldX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
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
import { ruleLabel } from "@/lib/boundaries/rules";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import { actionPolicyQueryOptions } from "@/lib/computers/queries";

// M4: 待接入 新建/查看单条规则的 admin/boundaries_.new.tsx、boundaries_.$index.tsx 与 lib/boundaries/rules.ts 的规则名仍是上游英文，需要中文化
export const Route = createFileRoute("/_authed/admin/boundaries")({
  component: BoundariesPage,
});

const DESCRIPTION =
  "规定员工绝不能做的动作。员工在自己的电脑上或在已连接的应用里动手之前，都会先检查这些规则。";

/**
 * The deployment's boundaries, read as a list of things Bots may never do.
 *
 * It used to be one screen that was also the editor: the rule language explained in a paragraph of
 * attribute names, rules shown as raw CEL, and ready-made rules drawn as buttons. Nobody could tell
 * from it what the page was for. Now each rule is a row with a name, adding one is its own screen
 * (`boundaries_.new.tsx`) and a rule opens to what it has stopped (`boundaries_.$index.tsx`).
 */
function BoundariesPage() {
  const queryClient = useQueryClient();
  const stored = useQuery(actionPolicyQueryOptions());
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));
  /* What the server stored wins once a save lands: it normalises what it keeps. */
  const policy = savePolicy.data ?? stored.data ?? null;

  const addRule = (
    <Button
      render={(props) => <Link {...props} to="/admin/boundaries/new" />}
      size="sm"
      variant="ghost"
    >
      <IconPlus />
      添加规则
    </Button>
  );

  if (!policy) {
    return (
      <PageShell description={DESCRIPTION} title="边界规则">
        {/* Nothing until the policy is known: a rule list that guesses is worse than a blank. */}
        {stored.error ? (
          <p className="text-destructive text-sm" role="alert">
            {stored.error.message}
          </p>
        ) : null}
      </PageShell>
    );
  }

  const trial = policy.mode === "dry-run";
  const allowsEverythingElse =
    policy.allow.length === 1 && policy.allow[0] === "true";

  return (
    <PageShell action={addRule} description={DESCRIPTION} title="边界规则">
      <PageSection title="员工绝不能">
        {policy.deny.length === 0 ? (
          <PageEmpty
            action={
              <Button
                render={(props) => (
                  <Link {...props} to="/admin/boundaries/new" />
                )}
                size="sm"
                variant="outline"
              >
                <IconPlus />
                添加规则
              </Button>
            }
            icon={IconShieldX}
            title="还没有规则"
          >
            员工可以做它自身权限允许的任何事。
          </PageEmpty>
        ) : (
          <PageRows>
            {policy.deny.map((rule, index) => {
              const label = ruleLabel(policy, rule);
              return (
                <StaggerItem index={index} key={rule}>
                  <Item
                    render={(props) => (
                      <Link
                        {...props}
                        params={{ index: String(index) }}
                        to="/admin/boundaries/$index"
                      />
                    )}
                    size="sm"
                  >
                    <ItemMedia variant="icon">
                      <IconShieldX />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle>{label.name}</ItemTitle>
                      {label.description ? (
                        <ItemDescription>{label.description}</ItemDescription>
                      ) : (
                        // A rule nobody named is still told apart from the next by what it says.
                        <ItemDescription className="line-clamp-1 font-mono">
                          {rule}
                        </ItemDescription>
                      )}
                    </ItemContent>
                    <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </Item>
                  {index !== policy.deny.length - 1 && <Separator />}
                </StaggerItem>
              );
            })}
          </PageRows>
        )}
      </PageSection>

      <PageSection title="规则怎么生效">
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>试运行</ItemTitle>
              <ItemDescription>
                {trial
                  ? "已开启。命中规则的动作照常进行，并记录在审计里，这样可以先看清规则会拦住什么，再让它真正拦下。"
                  : "已关闭。命中规则的动作会被拦下，员工会被告知是哪条规则拦的。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="试运行"
                checked={trial}
                disabled={savePolicy.isPending}
                onCheckedChange={(checked) =>
                  savePolicy.mutate({
                    ...policy,
                    mode: checked ? "dry-run" : "enforce",
                  })
                }
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item
            render={(props) => <Link {...props} to="/admin/audit" />}
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconListSearch />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>被拦下的动作</ItemTitle>
              <ItemDescription>
                在审计里选「已拦截」，就能看到被规则拦下的每个动作，以及是哪条规则。
              </ItemDescription>
            </ItemContent>
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </Item>
          <Separator />
          {/*
           * Read-only, and only interesting when it is not the default. Allow rules are checked after
           * the list above and an empty list refuses everything, so a deployment that narrowed them
           * in configuration needs to see that here rather than wonder why every action is refused.
           */}
          <Item size="sm">
            <ItemContent className="min-w-0">
              <ItemTitle>除此之外</ItemTitle>
              <ItemDescription
                className={allowsEverythingElse ? undefined : "font-mono"}
              >
                {allowsEverythingElse
                  ? "允许。在自身权限之内，上面没有规则拦下的事员工都可以做。"
                  : policy.allow.length === 0
                    ? "其他一律不允许。每个动作都会被拒绝。"
                    : `只允许这些规则放行的：${policy.allow.join(" · ")}`}
              </ItemDescription>
            </ItemContent>
          </Item>
        </PageRows>
        {savePolicy.error ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {savePolicy.error.message}
          </p>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
