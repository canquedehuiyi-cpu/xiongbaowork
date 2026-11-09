import { IconShare } from "@tabler/icons-react";
import { PageRows } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { ControlsSection } from "./controls-section";

/** Admin, Automatic learning: whether people may open their recorded Skills to every Bot. */
export function SkillSharingSection() {
  return (
    <ControlsSection
      description="每个人的录制会在自己的学习空间里教出技能，这些技能会提供给这个人用的员工。共享出去的技能，会把这个人录制和讲解的文字展示给所有人的员工。"
      title="共享"
    >
      {({ data, setSetting, saving }) => (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconShare />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>技能共享</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {data.settings.skillSharing
                  ? "大家可以在「设置 → 学习」里把自己的技能向所有员工公开。"
                  : "已关闭。每个人的技能只提供给自己用的员工，以前公开过的技能也一样。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="技能共享"
                checked={data.settings.skillSharing}
                disabled={saving}
                onCheckedChange={(checked) =>
                  setSetting("skillSharing", checked)
                }
              />
            </ItemActions>
          </Item>
        </PageRows>
      )}
    </ControlsSection>
  );
}
