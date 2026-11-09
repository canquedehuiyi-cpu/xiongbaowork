import {
  IconBrain,
  IconBuildingBank,
  IconBulb,
  IconChevronRight,
  IconCode,
  IconDeviceDesktop,
  IconKey,
  IconLayoutGrid,
  IconListDetails,
  IconLockAccess,
  IconPuzzle,
  IconRadar,
  IconShieldCheck,
  IconSlash,
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
        description: "员工运行工具用的机器、空闲多久停下，以及它们能连到哪里。",
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
      },
    ],
  },
  {
    title: "员工能做什么",
    description: "所有员工能用的模型、应用、技能和界面组件。",
    items: [
      {
        title: "插件",
        description: "这个部署能连到的服务、哪些员工可以用，以及审批 MCP 服务器。",
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
      },
      {
        title: "模型提供方",
        description: "看员工的模型由谁提供，并选出员工可以用哪些模型。",
        icon: IconBrain,
        linkOptions: { to: "/admin/providers" },
      },
      {
        title: "技能",
        description: "任何人都能用斜杠调用的具名指令。",
        icon: IconSlash,
        linkOptions: { to: "/admin/skills" },
      },
      {
        title: "自动学习",
        description: "从结束的对话里学习，审核它提出的技能，并决定大家能否分享自己的技能。",
        icon: IconBulb,
        linkOptions: { to: "/admin/learning" },
      },
      {
        title: "主动巡检",
        description: "开关主动巡检、限制频率，并查看大家多常接手员工提出的事。",
        icon: IconRadar,
        linkOptions: { to: "/admin/proactive" },
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
        title: "权限",
        description: "决定大家能拿员工做什么，可以对所有人设置，也可以按角色或分组设置。",
        icon: IconLockAccess,
        linkOptions: { to: "/admin/permissions" },
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
          "公司自己的 SAML 或 OpenID Connect 身份提供方，按邮箱域名分流，并可强制 SSO。",
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
        description: "这个部署里发生的每个动作、是谁做的，以及员工执行过的命令记录。",
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
                  <ItemMedia variant="icon">
                    <item.icon />
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
