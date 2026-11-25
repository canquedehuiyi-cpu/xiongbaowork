import {
  type Icon,
  IconLogout,
  IconSitemap,
  IconUsers,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps, useRouterState } from "@tanstack/react-router";
import { useId } from "react";
import { MORE_SIDEBAR_ONLY } from "@/components/app-sidebar/app-sidebar";
import { isPendingSummon } from "@/components/app-sidebar/roster";
import { EmployeeList } from "@/components/app-sidebar/sidebar-roster";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type NavigationItem,
  navigationOwns,
  type Rail,
  useNavigationItems,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { ListHead } from "./list-head";
import { currentMeLink, useMeMenu } from "./me-page";
import { MessageList } from "./message-list";

/** 设计稿 `.row`：一行一个入口，12px 圆角，悬停铺 `--wb-hover`，当前页抬成一张卡。 */
const rowClassName =
  "flex min-h-[44px] w-full min-w-0 items-center gap-[11px] rounded-(--wb-radius) border-0 bg-transparent px-[10px] py-2 text-left text-(--wb-fg) text-[14px] outline-none hover:bg-(--wb-hover) focus-visible:outline-2 focus-visible:outline-(--wb-accent) aria-[current=page]:bg-(--wb-card) aria-[current=page]:shadow-(--wb-row-shadow) [&>svg]:size-[18px] [&>svg]:shrink-0 [&>svg]:text-(--wb-accent)";

/** 设计稿 `.sec`：分组的小标题。 */
const sectionClassName =
  "flex justify-between px-[10px] pt-3 pb-1.5 font-semibold text-(--wb-muted) text-[11px] tracking-[.06em]";

/**
 * 一个链接行：图标、名字，可选第二行。打开着的那一页标 `aria-current`（由 `current` 决定）。
 *
 * TanStack 自己也会给它认为「正在打开」的链接写上 `aria-current`，而且盖不掉，所以它的匹配收得最紧
 * （路径完全相同）；两个只差查询参数的链接（人才市场 `/bots` 和我的群组 `/bots?tab=groups`）要传
 * `exactSearch`，查询参数也得完全相同才算，免得两行同时亮。
 */
function LinkRow({
  icon: Glyph,
  label,
  detail,
  tag,
  current,
  exactSearch = false,
  ...link
}: LinkProps & {
  icon: Icon;
  label: string;
  detail?: string;
  /** 名字旁边的小标签（设计稿 `.tag.ai`），像第二行一样只算描述。 */
  tag?: string;
  current?: boolean;
  exactSearch?: boolean;
}) {
  const detailId = useId();
  const tagId = useId();
  const describedBy =
    [tag ? tagId : "", detail ? detailId : ""].filter(Boolean).join(" ") ||
    undefined;
  return (
    <li className="flex">
      <Link
        {...link}
        {...(current ? { "aria-current": "page" as const } : {})}
        activeOptions={{ exact: true, includeSearch: exactSearch }}
        activeProps={{}}
        aria-describedby={describedBy}
        className={rowClassName}
      >
        <Glyph aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium">{label}</span>
            {tag ? (
              <span
                aria-hidden="true"
                className="shrink-0 rounded-[5px] bg-(--wb-card2) bg-(image:--wb-tag-ai) px-1.5 py-px font-medium text-(--wb-gold) text-[10px]"
                id={tagId}
              >
                {tag}
              </span>
            ) : null}
          </span>
          {/* 第二行是描述，不算进链接的名字：读屏念「套餐与用量」，再念「Pro」。 */}
          {detail ? (
            <span
              aria-hidden="true"
              className="truncate text-(--wb-muted) text-[12px]"
              id={detailId}
            >
              {detail}
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

function usePathname() {
  return useRouterState({ select: (state) => state.location.pathname });
}

/** 人才市场里等着召唤的有几位：没召唤过的预设，加上还没召唤的分身。员工列表读到之前是 0。 */
function usePendingSummons(): number {
  const agents = useQuery(agentListQueryOptions()).data;
  return (agents ?? []).filter(isPendingSummon).length;
}

/**
 * 通讯录：人才市场（带待召唤人数）、我的群组、组织架构（`/contacts`，按部门分组的员工）三个入口，下面是
 * 现在侧栏里的员工列表。
 */
function ContactsList() {
  const pathname = usePathname();
  const search = useRouterState({
    select: (state) => state.location.search as { tab?: string },
  });
  const pending = usePendingSummons();
  const onBots = pathname === "/bots";
  return (
    <>
      <ListHead rail="contacts" />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <ul aria-label="通讯录入口" className="m-0 flex list-none flex-col p-0">
          <LinkRow
            current={onBots && search.tab !== "groups"}
            exactSearch
            icon={IconUsers}
            label="人才市场"
            tag={pending > 0 ? `${pending} 位待召唤` : undefined}
            to="/bots"
          />
          <LinkRow
            current={onBots && search.tab === "groups"}
            exactSearch
            icon={IconUsersGroup}
            label="我的群组"
            search={{ tab: "groups" }}
            to="/bots"
          />
          <LinkRow
            current={pathname === "/contacts"}
            icon={IconSitemap}
            label="组织架构"
            to="/contacts"
          />
        </ul>
        <div className="px-0.5">
          <EmployeeList />
        </div>
      </div>
    </>
  );
}

/**
 * 工作台：归「工作台」的导航项。常用（主导航）在前，更多（组团流程、团队 Bot、审批）在后，
 * 管理区只给能打开它的人（`useNavigationItems` 已经按角色和版本筛过）。
 */
function WorkList() {
  const pathname = usePathname();
  const work = useNavigationItems().filter((item) => item.rail === "work");
  const primary = work.filter(
    (item) => item.section === "primary" && !item.adminOnly,
  );
  const more = work.filter(
    (item) => item.section !== "primary" && !item.adminOnly,
  );
  const admin = work.filter((item) => item.adminOnly);
  const navRow = (item: NavigationItem) => (
    <LinkRow
      current={navigationOwns(item, pathname)}
      icon={item.icon}
      key={item.id}
      label={item.label}
      to={item.to}
    />
  );
  const under = (path: string) =>
    pathname === path || pathname.startsWith(`${path}/`);
  return (
    <>
      <ListHead rail="work" />
      <nav
        aria-label="工作台"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
      >
        <div className={sectionClassName} id="workbench-list-common">
          常用
        </div>
        <ul
          aria-labelledby="workbench-list-common"
          className="m-0 flex list-none flex-col p-0"
        >
          {primary.map(navRow)}
        </ul>
        <div className={sectionClassName} id="workbench-list-more">
          更多
        </div>
        <ul
          aria-labelledby="workbench-list-more"
          className="m-0 flex list-none flex-col p-0"
        >
          {more.map(navRow)}
          {MORE_SIDEBAR_ONLY.map((item) => (
            <LinkRow
              current={under(item.to)}
              icon={item.icon}
              key={item.id}
              label={item.label}
              to={item.to}
            />
          ))}
        </ul>
        {admin.length > 0 ? (
          <>
            <div className={sectionClassName} id="workbench-list-admin">
              管理
            </div>
            <ul
              aria-labelledby="workbench-list-admin"
              className="m-0 flex list-none flex-col p-0"
            >
              {admin.map(navRow)}
            </ul>
          </>
        ) : null}
      </nav>
    </>
  );
}

/**
 * 我：「我」页面（`/me`）的菜单缩在列表栏里。顶上是个人卡（头像、名字、套餐），点它回「我」页面；下面是
 * 页面上那份菜单里各自是一页的行（个人资料、外观是设置页里某一段的捷径，只在页面上列，免得在设置页时
 * 三行一起亮），最后是退出登录（只在有登录可退的部署上）。
 */
function MeList() {
  const pathname = usePathname();
  const menu = useMeMenu();
  const current = currentMeLink(menu.groups, pathname);
  const planId = useId();
  return (
    <>
      <ListHead rail="me" />
      <nav aria-label="我" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <Link
          {...(pathname === "/me" ? { "aria-current": "page" as const } : {})}
          activeOptions={{ exact: true, includeSearch: false }}
          activeProps={{}}
          aria-describedby={menu.plan ? planId : undefined}
          className={cn(rowClassName, "mb-1 min-h-[56px]")}
          to="/me"
        >
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-full bg-(image:--wb-me-avatar) font-semibold text-(--wb-fg) text-[14px]"
          >
            {menu.initial}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-semibold">{menu.name}</span>
            {menu.plan ? (
              <span
                aria-hidden="true"
                className="truncate text-(--wb-muted) text-[12px]"
                id={planId}
              >
                {menu.plan}
              </span>
            ) : null}
          </span>
        </Link>
        {menu.groups.map((group) => (
          <ul
            className="m-0 flex list-none flex-col border-(--wb-line) border-t p-0 pt-1"
            key={group[0]?.id}
          >
            {group
              .filter((row) => row.claims)
              .map((row) => (
                <LinkRow
                  {...row.link}
                  current={current?.id === row.id}
                  detail={row.detail}
                  icon={row.icon}
                  key={row.id}
                  label={row.label}
                />
              ))}
          </ul>
        ))}
        {menu.signOut.offered ? (
          <ul className="m-0 flex list-none flex-col border-(--wb-line) border-t p-0 pt-1">
            <li className="flex">
              <button
                className={cn(rowClassName, "disabled:opacity-60")}
                disabled={menu.signOut.pending}
                onClick={menu.signOut.run}
                type="button"
              >
                <IconLogout aria-hidden="true" />
                <span className="truncate font-medium">退出登录</span>
              </button>
            </li>
          </ul>
        ) : null}
      </nav>
    </>
  );
}

/**
 * 工作台的列表栏：按选中的入口画一列。每个入口一个组件，后面的任务各自换掉自己那一个（消息、通讯录、我）。
 */
export function ListColumn({ rail }: { rail: Rail }) {
  switch (rail) {
    case "msg":
      return <MessageList />;
    case "contacts":
      return <ContactsList />;
    case "work":
      return <WorkList />;
    case "me":
      return <MeList />;
  }
}
