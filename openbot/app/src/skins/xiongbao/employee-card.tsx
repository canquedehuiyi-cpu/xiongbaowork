import { IconX } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { StatusDot } from "@/components/agents/status-dot";
import { latestDirectChannel } from "@/components/app-sidebar/roster";
import { ChannelAvatar } from "@/components/channels/avatar";
import { employeeNumber } from "@/components/summon/summon-card-flip";
import {
  knownPresence,
  presenceDoing,
  usePresence,
} from "@/lib/agents/presence";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  type ModelLibrary,
  modelChoiceName,
  modelLibraryQueryOptions,
  poolChoiceName,
} from "@/lib/models/queries";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";

/** 没有部门的员工在通讯录和名片上都写这个。 */
export const NO_DEPARTMENT = "未分组";

/*
 * 颜色只从 `--wb-*` 令牌取（`skin.css`）。通讯录页和名片也会画在别的皮肤（包括「经典」）里，那里没有
 * `--wb-*`，所以每个取值都带一个应用自己的令牌做后备。
 */
export const TONE = {
  fg: "text-[color:var(--wb-fg,var(--foreground))]",
  fg2: "text-[color:var(--wb-fg2,var(--foreground))]",
  muted: "text-[color:var(--wb-muted,var(--muted-foreground))]",
  frame: "bg-[color:var(--wb-frame,var(--background))]",
  main: "bg-[color:var(--wb-main,var(--background))]",
  card: "bg-[color:var(--wb-card,var(--card))]",
  card2: "bg-[color:var(--wb-card2,var(--muted))]",
  line: "border-[color:var(--wb-line,var(--border))]",
  line2: "border-[color:var(--wb-line2,var(--border))]",
  gold: "text-[color:var(--wb-gold,var(--foreground))]",
  focus:
    "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--wb-accent,var(--ring))]",
} as const;

/** 外壳给的开关：在任何地方打开某位员工的名片（`EmployeeCard`），抽屉挂在外壳上。 */
export type EmployeeCardControl = {
  openEmployeeCard: (agentId: string) => void;
};

export const EmployeeCardContext = createContext<EmployeeCardControl | null>(
  null,
);

/** 外壳挂了名片抽屉时拿到它的开关；别的皮肤里没有外壳，是 null。 */
export function useEmployeeCard(): EmployeeCardControl | null {
  return useContext(EmployeeCardContext);
}

/**
 * 一段话的第一句：到第一个句末标点（。！？!? 或后面跟空白的英文句号）或换行为止，标点留着。没有句末
 * 标点时是整段。去掉首尾空白，空的就是空串。
 */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = /^[\s\S]*?(?:[。！？!?]|\.(?=\s|$)|(?=\n))/.exec(trimmed);
  return (match ? match[0] : trimmed).trim();
}

/** 本地日历上的那一天（零点），按毫秒算。 */
function localDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/**
 * 入职第几天：按这台电脑的日历，创建那天是第 1 天。读不懂的时间、或者比今天还晚的（时钟不准）返回 null，
 * 不写。
 */
export function joinedDay(
  createdAt: string,
  now: Date = new Date(),
): number | null {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;
  const days = Math.round((localDay(now) - localDay(created)) / 86_400_000);
  return days >= 0 ? days + 1 : null;
}

/**
 * 名片上「模型」那一行：跑在别处的员工是外部托管模型；跑在这里、没绑模型的是部署自带的模型；绑了模型的
 * 写那个模型的名字（和员工配置里的模型选择同一种写法）。绑的模型在这个人的模型库里找不到（比如别人的
 * 员工绑的是别人的模型库），就不写，免得写错。
 */
export function modelLabel(
  agent: Pick<AgentProfile, "builtIn" | "modelRef" | "platformModelRef">,
  library: ModelLibrary | undefined,
): string | null {
  if (!agent.builtIn) return "外部托管模型";
  if (agent.platformModelRef) {
    const row = library?.pool.find(
      (model) => model.id === agent.platformModelRef,
    );
    return row ? poolChoiceName(row) : null;
  }
  if (agent.modelRef) {
    const row = library?.models.find((model) => model.id === agent.modelRef);
    return row ? modelChoiceName(row) : null;
  }
  return "部署自带的模型";
}

/**
 * 「此刻：正在做的事」（设计稿 `.status` / `.pcard .st`）：通讯录卡和名片上，员工忙碌时写它手上运行中的那件
 * 任务的标题。不忙、读不到时调用的人不画它，不写占位。
 */
export function NowDoing({
  doing,
  className,
}: {
  doing: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "block truncate rounded-[8px] px-2 py-1.5 text-[12px]",
        TONE.card2,
        TONE.fg2,
        className,
      )}
      data-now-doing=""
      title={doing}
    >
      <b className={cn("font-semibold", TONE.fg)}>此刻：</b>
      {doing}
    </span>
  );
}

const actionClassName = cn(
  "grid min-h-[38px] place-items-center rounded-[10px] px-2 py-[9px] text-center font-medium text-[13px]",
  TONE.focus,
);

function Action({
  primary = false,
  children,
  onClick,
  ...link
}: {
  primary?: boolean;
  children: ReactNode;
  onClick: () => void;
} & LinkProps) {
  return (
    <Link
      {...link}
      onClick={onClick}
      activeOptions={{ exact: true, includeSearch: true }}
      activeProps={{}}
      className={cn(
        actionClassName,
        primary
          ? "bg-primary bg-[image:var(--wb-me,none)] text-[color:var(--wb-me-fg,var(--primary-foreground))]"
          : cn(TONE.card2, TONE.fg),
      )}
    >
      {children}
    </Link>
  );
}

function CardBody({
  agent,
  onClose,
}: {
  agent: AgentProfile;
  onClose: () => void;
}) {
  const channels = useInfiniteQuery(channelListQueryOptions()).data;
  const bound = Boolean(agent.modelRef || agent.platformModelRef);
  const library = useQuery({
    ...modelLibraryQueryOptions(),
    enabled: agent.builtIn && bound,
  }).data;
  const skills = useQuery(agentPluginsQueryOptions(agent.id)).data?.skills;
  const direct = latestDirectChannel(channels, agent.id);
  const presence = knownPresence(usePresence([agent.id]).get(agent.id));
  const doing = presenceDoing(presence);
  // 最近的单聊，没有就开一段发给他的新对话，和侧栏员工行一样。
  const talk: LinkProps = direct
    ? { to: "/channel/$channelId", params: { channelId: direct.id } }
    : { to: "/channel/new", search: { agent: agent.id } };
  const tone = firstSentence(agent.persona?.tone ?? "");
  const model = modelLabel(agent, library);
  const day = agent.createdAt ? joinedDay(agent.createdAt) : null;
  const facts = [
    agent.title,
    agent.department || NO_DEPARTMENT,
    `工号 ${employeeNumber(agent.id)}`,
    day === null ? "" : `入职第 ${day} 天`,
  ].filter(Boolean);
  return (
    <div className="-mt-9 grid gap-2.5 px-[18px]">
      <span
        className={cn(
          "relative w-fit rounded-full border-[3px] border-[color:var(--wb-frame,var(--background))]",
          TONE.frame,
        )}
      >
        <span aria-hidden="true" className="block">
          <ChannelAvatar participantIds={[agent.id]} size={72} />
        </span>
        <StatusDot
          className="right-0.5 bottom-0.5 size-3.5 border-[color:var(--wb-frame,var(--background))]"
          overlay
          status={presence?.status}
        />
      </span>
      <h2 className="m-0 font-semibold text-[18px] leading-tight">
        {agent.name}
      </h2>
      <p
        className={cn(
          "m-0 flex flex-wrap gap-x-1 text-[12.5px] leading-relaxed",
          TONE.muted,
        )}
      >
        {facts.map((fact, index) => (
          // 职务和部门可能一字不差，所以按位置认。
          // biome-ignore lint/suspicious/noArrayIndexKey: the list is rebuilt whole each render, never reordered.
          <span key={index}>
            {index > 0 ? (
              <span aria-hidden="true" className="mr-1">
                ·
              </span>
            ) : null}
            <span>{fact}</span>
          </span>
        ))}
      </p>
      {doing ? <NowDoing className="text-[12.5px]" doing={doing} /> : null}
      {tone || model ? (
        <dl className="m-0 grid grid-cols-[70px_1fr] gap-x-2.5 gap-y-2 text-[12.5px]">
          {tone ? (
            <>
              <dt className={TONE.muted}>性格</dt>
              <dd className={cn("m-0", TONE.fg2)}>{tone}</dd>
            </>
          ) : null}
          {model ? (
            <>
              <dt className={TONE.muted}>模型</dt>
              <dd className={cn("m-0", TONE.fg2)}>{model}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {skills && skills.length > 0 ? (
        <div>
          <p
            className={cn("m-0 mb-1.5 text-[12.5px]", TONE.muted)}
            id={`employee-skills-${agent.id}`}
          >
            擅长的技能
          </p>
          <ul
            aria-labelledby={`employee-skills-${agent.id}`}
            className="m-0 flex list-none flex-wrap gap-1.5 p-0"
          >
            {skills.map((skill) => (
              <li
                className={cn(
                  "rounded-[6px] px-2 py-[3px] text-[11.5px]",
                  TONE.card2,
                  TONE.fg2,
                )}
                key={skill.slug}
              >
                {skill.title}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-1 grid grid-cols-2 gap-2">
        <Action {...talk} onClick={onClose} primary>
          发消息
        </Action>
        <Action
          onClick={onClose}
          params={{ agentId: agent.id }}
          to="/bots/$agentId/setup"
        >
          配置
        </Action>
        {/*
         * 任务在对话里交代：和「发消息」去同一段对话。两个落点都会把光标放进输入框——已有的对话一打开就
         * 聚焦输入框（ChannelChat 的 `autoFocus`），发给他的新对话有了收件人也聚焦输入框——所以到了就能
         * 直接写任务。
         */}
        <Action {...talk} onClick={onClose}>
          交给他一个任务
        </Action>
        <Action onClick={onClose} search={{ agent: agent.id }} to="/group/new">
          拉进群
        </Action>
      </div>
    </div>
  );
}

/**
 * 员工名片（设计稿右侧的抽屉）：封面，头像，名字，职务 · 部门 · 工号 · 入职第几天；性格（人设「怎么说话」的
 * 第一句）、模型、擅长的技能（已装技能的名字）；按钮「发消息 / 配置 / 交给他一个任务 / 拉进群」。读不到的
 * 那一项不写。
 *
 * 它不是模态框：页面还能点，抽屉盖在右边。打开时焦点落在「关闭」上，Esc 或「关闭」收起，焦点回到打开它的
 * 地方。挂在哪里由调用的人决定（工作台外壳；没有外壳时是通讯录页自己），它只要一个相对定位的祖先。
 *
 * 手机上（`fullScreen`）它不是抽屉，是盖住整个外壳的一页，像微信点开一个人的资料页。
 */
export function EmployeeCard({
  agentId,
  onClose,
  fullScreen = false,
}: {
  agentId: string;
  onClose: () => void;
  fullScreen?: boolean;
}) {
  const agents = useQuery(agentListQueryOptions());
  const agent = agents.data?.find((candidate) => candidate.id === agentId);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  /*
   * 打开它的那个元素，在这一张名片第一次渲染时记下：那时上一张名片（直接从 A 换到 B 时）还没收起，焦点
   * 还在点的那张员工卡上。焦点在另一张名片里时不记，免得收起 B 后跳回 A。
   */
  const [opener] = useState(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement &&
      !active.closest("[data-employee-card]")
      ? active
      : null;
  });

  useEffect(() => {
    const drawer = drawerRef.current;
    /** 焦点还归这张名片管：在它里面，或者哪儿都不在（落在 body 上）。 */
    const ownsFocus = () => {
      const active = document.activeElement;
      return !active || active === document.body || !!drawer?.contains(active);
    };
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      // 主区里的下拉框、对话框、输入框先处理过的 Esc 不算；焦点在别处时 Esc 也不是给名片的。
      if (event.key !== "Escape" || event.defaultPrevented || !ownsFocus())
        return;
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // 换到另一张名片、或者焦点已经被别处拿走时，不去抢。
      if (ownsFocus() && opener?.isConnected) opener.focus();
    };
  }, [opener]);

  return (
    <div
      aria-label="员工名片"
      aria-modal="false"
      className={cn(
        "absolute z-30 overflow-y-auto motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-200",
        fullScreen
          ? "inset-0 pb-[calc(18px+env(safe-area-inset-bottom))]"
          : "inset-y-0 right-0 w-[320px] max-w-full border-l pb-[18px] shadow-[var(--wb-drawer-shadow,var(--shadow-lg))]",
        TONE.frame,
        TONE.line2,
        TONE.fg,
      )}
      data-employee-card={agentId}
      data-full-screen={fullScreen ? "" : undefined}
      ref={drawerRef}
      role="dialog"
    >
      <div className="relative h-24 bg-muted bg-[image:var(--wb-cover,none)]">
        <button
          aria-label="关闭"
          className={cn(
            "absolute top-2.5 right-2.5 grid size-7 cursor-pointer place-items-center rounded-[8px] border-0 bg-[color:var(--wb-cover-button,var(--background))] text-[color:var(--wb-cover-button-fg,var(--foreground))] [&>svg]:size-4",
            TONE.focus,
          )}
          onClick={onClose}
          ref={closeRef}
          type="button"
        >
          <IconX aria-hidden="true" />
        </button>
      </div>
      {agent ? (
        <CardBody agent={agent} onClose={onClose} />
      ) : (
        <p className={cn("m-0 px-[18px] pt-4 text-[13px]", TONE.muted)}>
          {agents.isPending ? "正在加载…" : "找不到这位员工。"}
        </p>
      )}
    </div>
  );
}
