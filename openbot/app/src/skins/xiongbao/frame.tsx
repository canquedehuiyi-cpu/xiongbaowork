import { IconChevronLeft } from "@tabler/icons-react";
import {
  Link,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { UpdateBanner } from "@/components/layout/update-banner";
import { useIsMobile } from "@/hooks/use-mobile";
import { hasFailedStart, onFailedStart } from "@/lib/channels/pending-start";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { type Rail, railForPath } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import {
  EmployeeCard,
  EmployeeCardContext,
  type EmployeeCardControl,
} from "./employee-card";
import { ListColumn } from "./list-column";
import { WorkbenchRail } from "./rail";

/**
 * 默认外观的外壳，聊天工作台（设计稿 `docs/specs/assets/2026-11-14-chat-workbench-mock.html`）：
 * 最左 68px 的入口栏，300px 的列表栏，右边是主区。主区照常画路由页面（`children`），更新横幅和自托管
 * 横幅在它顶上，和原来的外壳一样。
 *
 * 亮哪个入口跟着地址走（`railForPath`），刷新、直达链接都落到对的入口。点一下入口栏，列表栏先切过去，
 * 主区不动，像微信那样；地址一变，入口又回到地址所属的那个。「通讯录」「工作台」「我」例外：它们直接落到
 * 自己的页面（组织架构 `/contacts`、工作台首页 `/workbench`、「我」页面 `/me`）。
 *
 * 员工名片（右侧抽屉）挂在这里，盖在列表栏和主区的右边：任何地方用 `useEmployeeCard()` 拿到
 * `openEmployeeCard(agentId)` 打开它。地址一变它就收起，和入口栏的「先切过去」是同一个办法。
 *
 * 手机上（宽度不足 768px，`useIsMobile`）像微信：入口栏变成底部标签栏，一屏只放一样东西。在四个入口的
 * 根地址（`ENTRY_ROOTS`）上是那个入口的一屏加标签栏，「消息」是全屏的会话列表，另外三个是各自的页面；别的
 * 地址（对话、群组、设置的某一页、员工的某一页……）是页面全屏，标签栏收起，顶上一个「返回」回到地址所属
 * 入口的根地址，对话回到消息列表：上一条历史记录就是同一个入口里的页面时是浏览器的后退（回到原来滚到的
 * 地方，也不多压一条历史），直达链接这类没有上一页可退的，才去入口的根地址。名片在手机上是盖住整屏的一页，
 * 也是历史里的一页（`CARD_STATE`）：安卓的返回键、浏览器后退先收起名片，不离开底下的页面。
 *
 * 颜色只从 `--wb-*` 令牌取（`skin.css`），暗色跟着 `<html class="dark">`。
 */
/** 四个入口各自的根地址：手机上在这里显示标签栏，别处「返回」回到这里。 */
const ENTRY_ROOTS: Record<Rail, "/" | "/contacts" | "/workbench" | "/me"> = {
  msg: "/",
  contacts: "/contacts",
  work: "/workbench",
  me: "/me",
};

function isEntryRoot(pathname: string): boolean {
  return Object.values(ENTRY_ROOTS).some((root) => root === pathname);
}

/**
 * 手机上打开名片时压进历史的那条记录，在 `state` 里带着这个记号，值是员工 id。地址不变，只多一条历史：
 * 后退（安卓返回键、浏览器后退）就回到没有记号的那条，名片跟着收起；「关闭」收起时把这条退掉。桌面的
 * 抽屉不进历史。
 */
const CARD_STATE = "workbenchCard";

/** 这条历史记录上开着谁的名片（手机）；没有记号是 null。 */
function cardInState(state: unknown): string | null {
  const value = (state as Record<string, unknown> | undefined)?.[CARD_STATE];
  return typeof value === "string" ? value : null;
}

/**
 * 这个应用里走过的每条历史记录是哪个地址，按历史里的序号（`__TSR_index`）记，每个路由的历史一份。放在
 * 模块里而不是外壳里：设置、管理各自套一层外壳，在它们之间走动时外壳会换一个，记下的不能跟着丢。
 */
const visitedPaths = new WeakMap<object, Map<number, string>>();

function visitsOf(history: object): Map<number, string> {
  let visits = visitedPaths.get(history);
  if (!visits) {
    visits = new Map();
    visitedPaths.set(history, visits);
  }
  return visits;
}

export function WorkbenchFrame({ children }: { children: ReactNode }) {
  // 整个应用一条推送连接，开在名册保持最新的地方，和原来的侧栏一样。
  useChannelEvents();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  /*
   * 首页带着要填进输入框的话（`?ask=`，教员工做事的「试一试」交过来的）时，手机上也得是首页那个输入框，
   * 不能换成会话列表。
   */
  const asking = useRouterState({
    select: (state) =>
      Boolean((state.location.search as { ask?: unknown }).ask),
  });
  const historyIndex = useRouterState({
    select: (state) =>
      (state.location.state as { __TSR_index?: number }).__TSR_index ?? 0,
  });
  const markedCard = useRouterState({
    select: (state) => cardInState(state.location.state),
  });
  const router = useRouter();
  const navigate = useNavigate();
  const phone = useIsMobile();
  /*
   * 首页输入框里发出的对话没能开始时，话和原因留着等首页取（`takeFailedStart`）。手机上 `/` 是会话列表，
   * 所以有这样一条在等时，`/` 照常画首页，直到离开 `/` 或按「返回」。
   */
  const [failedHome, setFailedHome] = useState(hasFailedStart);
  useEffect(() => onFailedStart(() => setFailedHome(true)), []);
  useEffect(() => {
    visitsOf(router.history).set(historyIndex, pathname);
  }, [router.history, historyIndex, pathname]);
  const [chosen, setChosen] = useState<Rail | null>(null);
  const [card, setCard] = useState<string | null>(null);
  // 地址一变（点链接、浏览器后退前进都算），点出来的临时入口就作废，回到地址所属的入口；名片也收起。
  // 只是「不匹配时忽略」不够：后退回到原地址时，旧的选择又会匹配上，把入口错放在别处。
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setChosen(null);
    setCard(null);
    setFailedHome(hasFailedStart());
  }
  // 手机上一屏只放一样东西，入口只跟着地址走：点标签栏就是换地址。
  const rail = (phone ? null : chosen) ?? railForPath(pathname);
  /*
   * 桌面上名片是抽屉，开着谁记在这里（`card`）；手机上名片是历史里的一页，开着谁看这条历史记录上的记号。
   * 换地址时新的记录上没有记号，名片照样收起。
   */
  const cardFor = phone ? markedCard : card;
  /*
   * 手机上：入口的根地址有标签栏；「消息」的根地址画会话列表而不是主区。名片盖住整屏时底下的都 `inert`
   * （点不到、读屏读不到），但不收起，关掉名片回来时页面还停在原来滚到的地方。
   */
  const homePage = asking || failedHome;
  const phoneDetail = phone && (!isEntryRoot(pathname) || homePage);
  const phoneList = phone && pathname === "/" && !homePage;
  const covered = phone && cardFor !== null;
  /** 上一条历史记录还在这个应用里、也归这个入口时，「返回」就是后退一步。 */
  const previous = visitsOf(router.history).get(historyIndex - 1);
  const backSteps =
    pathname !== ENTRY_ROOTS[rail] &&
    previous !== undefined &&
    railForPath(previous) === rail;
  const phoneNow = useRef(phone);
  phoneNow.current = phone;
  const cards = useMemo<EmployeeCardControl>(
    () => ({
      openEmployeeCard: (agentId) => {
        if (!phoneNow.current) {
          setCard(agentId);
          return;
        }
        // 同一个地址压一条带记号的历史；已经开着一张时换掉那一条，不再多压。
        const { href, state } = router.history.location;
        const next = { ...state, [CARD_STATE]: agentId };
        if (cardInState(state)) router.history.replace(href, next);
        else router.history.push(href, next);
      },
    }),
    [router],
  );
  /**
   * 「关闭」和 Esc。手机上把名片那条历史退掉：底下那条就是这一页时后退一步；否则（刷新后停在名片那条上，
   * 底下不是这一页）就地把记号去掉，不后退到别处。
   */
  const closeCard = () => {
    if (!phone) {
      setCard(null);
      return;
    }
    const { href, state } = router.history.location;
    if (!cardInState(state)) return;
    if (previous === pathname) {
      router.history.back();
      return;
    }
    const rest: Record<string, unknown> = { ...state };
    delete rest[CARD_STATE];
    router.history.replace(href, rest);
  };

  return (
    <EmployeeCardContext.Provider value={cards}>
      <div
        className={cn(
          "relative h-svh overflow-hidden bg-(--wb-frame) text-foreground",
          phone ? "flex flex-col" : "grid grid-cols-[68px_300px_minmax(0,1fr)]",
        )}
        data-workbench-frame
        data-workbench-phone={phone ? "" : undefined}
      >
        {phoneDetail ? (
          <header
            className="flex h-11 shrink-0 items-center border-(--wb-line) border-b bg-(--wb-list) px-1.5"
            data-workbench-back
            inert={covered}
          >
            <Link
              className="inline-flex h-9 items-center gap-0.5 rounded-(--wb-radius-sm) pr-2.5 pl-1 text-(--wb-accent) text-[15px] outline-none focus-visible:outline-2 focus-visible:outline-(--wb-accent) [&>svg]:size-[22px] [&>svg]:stroke-[1.8]"
              onClick={(event) => {
                setFailedHome(false);
                if (!backSteps) return;
                event.preventDefault();
                router.history.back();
              }}
              to={ENTRY_ROOTS[rail]}
            >
              <IconChevronLeft aria-hidden="true" />
              返回
            </Link>
          </header>
        ) : null}
        {/* 手机上标签栏在详情页只是收起（`hidden`），不拿掉：它挂着角标和浏览器通知。 */}
        <WorkbenchRail
          hidden={phoneDetail}
          inert={covered}
          layout={phone ? "tabs" : "rail"}
          onSelect={(next) => {
            setChosen(next);
            // 已经在 /me（/contacts、/workbench）时地址不变，靠上面这一行把列表栏切回去。
            if (next === "me") void navigate({ to: "/me" });
            if (next === "contacts") void navigate({ to: "/contacts" });
            if (next === "work") void navigate({ to: "/workbench" });
            // 手机上没有并排的列表栏，「消息」就是回到会话列表那一屏。
            if (next === "msg" && phone) void navigate({ to: "/" });
          }}
          rail={rail}
        />
        <aside
          aria-label="列表栏"
          className={cn(
            "flex min-h-0 min-w-0 flex-col bg-(--wb-list) text-(--wb-fg)",
            phone ? "flex-1" : "border-(--wb-line) border-r",
          )}
          data-workbench-list={rail}
          hidden={phone && !phoneList}
          inert={covered}
        >
          {phone && !phoneList ? null : <ListColumn rail={rail} />}
        </aside>
        <main
          className={cn(
            "relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-(--wb-main)",
            phone && "flex-1",
          )}
          data-workbench-main
          hidden={phoneList}
          inert={covered}
        >
          {/* Only inside the desktop app: the banner asks it, and draws nothing in a browser. */}
          <UpdateBanner />
          <SelfHostBanner />
          {/* 手机上的消息入口画会话列表，首页（新对话的输入框）不挂；新对话走列表顶上的「＋」。 */}
          {phoneList ? null : children}
        </main>
        {cardFor ? (
          <EmployeeCard
            agentId={cardFor}
            fullScreen={phone}
            key={cardFor}
            onClose={closeCard}
            // 去别处的按钮随后就换地址：桌面收起抽屉；手机上名片那条历史留着，从那一页后退回到名片。
            onLeave={() => setCard(null)}
          />
        ) : null}
      </div>
    </EmployeeCardContext.Provider>
  );
}
