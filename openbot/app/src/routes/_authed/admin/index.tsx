import {
  IconBuildingBank,
  IconChevronRight,
  IconCode,
  IconDeviceDesktop,
  IconFileText,
  IconKey,
  IconLayoutGrid,
  IconListDetails,
  IconPuzzle,
  IconShieldCheck,
  IconUsers,
} from "@tabler/icons-react";
import {
  createFileRoute,
  Link,
  type LinkOptions,
} from "@tanstack/react-router";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";

export const Route = createFileRoute("/_authed/admin/")({
  component: RouteComponent,
});

/**
 * Grouped by what the decision is about rather than by how the code is organised.
 *
 * "What Bots can reach" is the group an administrator arrives worrying about, so it goes first.
 * Everything in it either grants a capability or fences one in.
 */
const SECTIONS: {
  title: string;
  description: string;
  items: {
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    title: string;
  }[];
}[] = [
  {
    title: "员工能碰到什么",
    description: "员工在这个应用之外能碰到的一切，以及对它的限制。",
    items: [
      {
        title: "凭据",
        description: "为这个部署保管的密钥和令牌。",
        icon: IconKey,
        linkOptions: { to: "/admin/credentials" },
      },
      {
        title: "边界规则",
        description: "决定员工绝不能做什么的规则。",
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
      },
      {
        title: "电脑",
        description: "员工运行工具用的机器。",
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
      },
    ],
  },
  {
    title: "员工能做什么",
    description: "所有员工都能用的能力和界面组件。",
    items: [
      {
        title: "插件",
        description: "这个部署能连到的服务，以及哪些员工可以用。",
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
      },
      {
        title: "技能",
        description: "任何人都能用斜杠调用的具名指令。",
        icon: IconFileText,
        linkOptions: { to: "/admin/skills" },
      },
      {
        title: "界面组件",
        description: "员工可以在对话里画出来的自定义组件。",
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
      },
      {
        title: "试验台",
        description: "写一个组件，边写边看它渲染出来。",
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
      },
    ],
  },
  {
    title: "谁能进来",
    description: "",
    items: [
      {
        title: "成员",
        description: "所有登录过的人、谁在管理这个部署、谁的访问已被移除。",
        icon: IconUsers,
        linkOptions: { to: "/admin/people" },
      },
      {
        title: "企业管控",
        description:
          "按角色和分组的能力、强制 SSO、SCIM、网络策略、MCP 与模型白名单、操作录制。",
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/enterprise" },
      },
      {
        title: "身份提供方",
        description:
          "公司自己的 SAML 或 OpenID Connect 身份提供方，按邮箱域名分流。",
        icon: IconBuildingBank,
        linkOptions: { to: "/admin/identity-providers" },
      },
    ],
  },
  {
    title: "发生过什么",
    description: "",
    items: [
      {
        title: "审计",
        description: "这个部署里发生的每个动作，以及是谁做的。",
        icon: IconListDetails,
        linkOptions: { to: "/admin/audit" },
      },
    ],
  },
];

function RouteComponent() {
  return (
    <PageShell
      description="对这个部署里所有人都生效的设置。这里的任何改动都会影响每个人和每位员工，这正是它和你个人偏好的区别。"
      title="管理"
    >
      {SECTIONS.map((section) => (
        <PageSection
          description={section.description || undefined}
          key={section.title}
          title={section.title}
        >
          <PageRows>
            {section.items.map((item, index) => (
              <StaggerItem index={index} key={item.title}>
                {/*
                 * The whole row is the link, not a chevron somebody has to aim at: every row here
                 * goes exactly one place, so there is nothing else the row could mean.
                 */}
                <Item
                  render={(props) => <Link {...item.linkOptions} {...props} />}
                  size="sm"
                >
                  <ItemMedia>
                    <item.icon className="size-4 text-muted-foreground" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{item.title}</ItemTitle>
                    <ItemDescription>{item.description}</ItemDescription>
                  </ItemContent>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Item>
                {index !== section.items.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        </PageSection>
      ))}
    </PageShell>
  );
}
