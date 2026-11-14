import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import logo256 from "@/assets/brand/xiongbao-logo-256.png";
import "./summon-card-flip.css";

/**
 * 召唤一位员工时的「招聘入职」动画，游戏抽卡式：
 *
 *   charging —— 卡背（熊宝 logo + 纹样 + 流光边框）浮在整屏暗色遮罩上，金光向卡片聚拢、卡片轻颤；
 *               召唤请求还在路上时一直蓄力，至少蓄 `SUMMON_MIN_CHARGE_MS`，哪怕请求瞬间就回来了。
 *   reveal   —— 请求兑现后 3D 翻面，露出这位员工的工牌（挂绳与夹子、熊宝头像、名字、职务、工号）；
 *               侧立那一刻光芒迸发，随后一枚红色「已入职」圆章盖下来，彩带纸屑炸开、金光再放一次，
 *               「召唤成功 · 欢迎入职」出现；最后工牌缩小、飞向左侧（侧栏），`SUMMON_REVEAL_MS` 后
 *               调 `onDone()`。
 *
 * `result` 是召唤请求本身：它决定能不能翻面和盖章。拒绝时不翻面、不盖章、不出现「召唤成功」，只调
 * 一次 `onFail(error)`，遮罩随即收起（交给调用方报错），不会把页面挡住。
 *
 * 点击任意处（或 Esc / Enter / 空格）跳过：已兑现就立刻 `onDone()`；没兑现就先停掉特效，兑现的那一刻
 * `onDone()`。系统开了「减少动态效果」时不播动画，一上来就是工牌，兑现后盖好章并立刻 `onDone()`。
 * `onDone` 与 `onFail` 合起来只会被调用一次；卸载之后两者都不会再被调用。遮罩关闭时焦点回到打开前
 * 所在的元素（如果它还在页面上）。
 *
 * 遮罩始终是暗色（不随主题变），颜色在 summon-card-flip.css 里固定在遮罩上，深浅主题下一致。
 */
export const SUMMON_MIN_CHARGE_MS = 600;
/** 从翻面开始到交出 `onDone()`：翻面、盖章、彩带、「召唤成功 · 欢迎入职」，再飞向侧栏。 */
export const SUMMON_REVEAL_MS = 2500;

export interface SummonCardFlipProps {
  /** 被召唤员工的 id，只用来算工牌上展示用的工号。 */
  agentId: string;
  name: string;
  title: string;
  /** 员工头像的图片地址（预设的熊宝头像）。 */
  portrait: string;
  /** 召唤请求：兑现了才翻面。 */
  result: Promise<unknown>;
  onDone: () => void;
  onFail: (error: unknown) => void;
}

/**
 * 工牌上的工号：`XB-` 加 4 位数字，由员工 id 的 FNV-1a 哈希得来。同一个 id 永远是同一个号，
 * 纯展示，不对应任何真实编号。
 */
export function employeeNumber(agentId: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(agentId)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `XB-${String(hash % 10000).padStart(4, "0")}`;
}

type Settled = "pending" | "landed" | "failed";
type Motion = "full" | "skipped" | "reduced";

export function SummonCardFlip({
  agentId,
  name,
  title,
  portrait,
  result,
  onDone,
  onFail,
}: SummonCardFlipProps) {
  const reduced = usePrefersReducedMotion();
  const [settled, setSettled] = useState<Settled>("pending");
  const [charged, setCharged] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const overlay = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // 只交一次：onDone 与 onFail 互斥，且各自最多一次。
  const handedOver = useRef(false);
  const callbacks = useRef({ onDone, onFail });
  useEffect(() => {
    callbacks.current = { onDone, onFail };
  });
  const finish = useCallback(() => {
    if (handedOver.current) return;
    handedOver.current = true;
    callbacks.current.onDone();
  }, []);

  useEffect(() => {
    let live = true;
    result.then(
      () => {
        if (live) setSettled("landed");
      },
      (error: unknown) => {
        if (!live) return;
        setSettled("failed");
        restoreFocus(returnFocus.current);
        if (handedOver.current) return;
        handedOver.current = true;
        callbacks.current.onFail(error);
      },
    );
    return () => {
      live = false;
    };
  }, [result]);

  useEffect(() => {
    const timer = setTimeout(() => setCharged(true), SUMMON_MIN_CHARGE_MS);
    return () => clearTimeout(timer);
  }, []);

  const motion: Motion = reduced ? "reduced" : skipped ? "skipped" : "full";
  const landed = settled === "landed";
  const succeeded = landed && (charged || motion !== "full");

  // 没有动画可看（减少动态效果、已跳过）：兑现即交出。
  useEffect(() => {
    if (landed && motion !== "full") finish();
  }, [landed, motion, finish]);

  // 完整动画：翻面后 SUMMON_REVEAL_MS 交出（工牌那时正好飞进侧栏）。
  useEffect(() => {
    if (!succeeded || motion !== "full") return;
    const timer = setTimeout(finish, SUMMON_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [succeeded, motion, finish]);

  // 打开时把焦点拿到遮罩上，关闭时还回去。
  useEffect(() => {
    const active = document.activeElement;
    returnFocus.current = active instanceof HTMLElement ? active : null;
    overlay.current?.focus({ preventScroll: true });
    return () => restoreFocus(returnFocus.current);
  }, []);

  const skip = () => {
    if (landed) finish();
    else setSkipped(true);
  };

  // 遮罩是传送到 body 的，但 React 的事件仍会沿组件树冒泡到调用方（比如触发召唤的那一行），
  // 所以在这里截住，点遮罩不会再点到它下面的东西。
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    skip();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      skip();
    }
  };

  if (settled === "failed" || typeof document === "undefined") return null;

  const phase = succeeded ? "reveal" : "charging";
  const animated = motion === "full";

  return createPortal(
    <div
      aria-label="召唤员工"
      aria-modal="true"
      className="summon-overlay"
      data-motion={motion}
      data-phase={phase}
      onClick={onClick}
      onKeyDown={onKeyDown}
      ref={overlay}
      role="dialog"
      tabIndex={-1}
    >
      <div aria-hidden="true" className="summon-backdrop" />
      <div className="summon-stage">
        {animated && (
          <>
            <div aria-hidden="true" className="summon-rays" />
            <div aria-hidden="true" className="summon-halo" />
            {phase === "charging" ? (
              <ChargeEffects />
            ) : (
              <div aria-hidden="true" className="summon-glory" />
            )}
          </>
        )}
        <div className="summon-flyer">
          <div className="summon-lift">
            <div className="summon-scene">
              <div className="summon-card">
                <div
                  aria-hidden="true"
                  className="summon-face summon-back"
                  data-face="back"
                >
                  <div className="summon-back-ground">
                    <span className="summon-back-frame" />
                    <img
                      alt=""
                      className="summon-back-logo"
                      draggable={false}
                      src={logo256}
                    />
                  </div>
                </div>
                <div className="summon-face summon-front" data-face="front">
                  <Badge
                    agentId={agentId}
                    name={name}
                    portrait={portrait}
                    stamped={succeeded}
                    title={title}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
        {animated && phase === "reveal" && <RevealBurst />}
      </div>
      <p aria-live="polite" className="summon-status" role="status">
        {succeeded ? (
          <>
            <span className="summon-status-word">召唤成功</span>
            <span aria-hidden="true" className="summon-status-dot">
              ·
            </span>
            <span className="summon-status-word">欢迎入职</span>
          </>
        ) : (
          `正在召唤${name}…`
        )}
      </p>
      <p aria-hidden="true" className="summon-hint">
        点击任意处跳过
      </p>
    </div>,
    document.body,
  );
}

/** 工牌正面：挂绳与夹子、红色抬头、头像、名字职务、工号与条码；兑现后盖上「已入职」章。 */
function Badge({
  agentId,
  name,
  title,
  portrait,
  stamped,
}: {
  agentId: string;
  name: string;
  title: string;
  portrait: string;
  stamped: boolean;
}) {
  return (
    <>
      <span aria-hidden="true" className="summon-lanyard" />
      <div className="summon-badge">
        <div className="summon-badge-body">
          <div className="summon-badge-head">
            <span aria-hidden="true" className="summon-badge-slot" />
            <span className="summon-badge-org">
              <img alt="" draggable={false} src={logo256} />
              熊宝 · 员工证
            </span>
          </div>
          <div className="summon-portrait">
            <img alt={name} draggable={false} src={portrait} />
          </div>
          <div className="summon-nameplate">
            <span className="summon-name">{name}</span>
            <span className="summon-title">{title}</span>
          </div>
          <div className="summon-badge-foot">
            <span className="summon-badge-number">
              <span className="summon-badge-label">工号</span>
              <span>{employeeNumber(agentId)}</span>
            </span>
            <span aria-hidden="true" className="summon-barcode" />
          </div>
          <span aria-hidden="true" className="summon-sheen" />
        </div>
      </div>
      <span aria-hidden="true" className="summon-clip" />
      {stamped && (
        <>
          <span aria-hidden="true" className="summon-seal-splash" />
          <Seal />
        </>
      )}
    </>
  );
}

/** 红色圆章：外粗内细两道圈，上弧「熊宝人事部」，中间五角星，下方「已入职」；边缘用噪声做出墨迹。 */
function Seal() {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const arc = `summon-seal-arc-${id}`;
  const ink = `summon-seal-ink-${id}`;
  return (
    <svg
      aria-label="已入职"
      className="summon-seal"
      role="img"
      viewBox="0 0 100 100"
    >
      <defs>
        <path d="M 19 50 A 31 31 0 1 1 81 50" id={arc} />
        <filter height="120%" id={ink} width="120%" x="-10%" y="-10%">
          <feTurbulence
            baseFrequency="0.85"
            numOctaves="2"
            result="noise"
            type="fractalNoise"
          />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="2.4" />
        </filter>
      </defs>
      <g fill="currentColor" filter={`url(#${ink})`}>
        <circle
          cx="50"
          cy="50"
          fill="none"
          r="45.5"
          stroke="currentColor"
          strokeWidth="5"
        />
        <circle
          cx="50"
          cy="50"
          fill="none"
          r="39"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <text fontSize="10.5" fontWeight="700" letterSpacing="2.5">
          <textPath href={`#${arc}`} startOffset="50%" textAnchor="middle">
            熊宝人事部
          </textPath>
        </text>
        <path d="M50 36 L52.2 42 L58.6 42.2 L53.5 46.1 L55.3 52.3 L50 48.7 L44.7 52.3 L46.5 46.1 L41.4 42.2 L47.8 42Z" />
        <text
          fontSize="17"
          fontWeight="900"
          letterSpacing="1"
          textAnchor="middle"
          x="50"
          y="72"
        >
          已入职
        </text>
      </g>
    </svg>
  );
}

/** 蓄力：一圈向内收的能量环，和一束束向卡片聚拢的光。 */
function ChargeEffects() {
  return (
    <>
      <span aria-hidden="true" className="summon-converge" />
      <span
        aria-hidden="true"
        className="summon-converge summon-converge-late"
      />
      <div aria-hidden="true" className="summon-gather">
        {GATHER.map((style, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 固定长度的装饰粒子。
          <span key={index} style={style} />
        ))}
      </div>
    </>
  );
}

/** 翻面与盖章：闪光、冲击环、四散的粒子、闪烁的星，和盖章时炸开的彩带纸屑。 */
function RevealBurst() {
  return (
    <>
      <span aria-hidden="true" className="summon-flash" />
      <span aria-hidden="true" className="summon-shockwave" />
      <span
        aria-hidden="true"
        className="summon-shockwave summon-shockwave-late"
      />
      <div aria-hidden="true" className="summon-burst">
        {BURST.map((style, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 固定长度的装饰粒子。
          <span key={index} style={style} />
        ))}
      </div>
      <div aria-hidden="true" className="summon-confetti">
        {CONFETTI.map((style, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 固定长度的装饰粒子。
          <span key={index} style={style} />
        ))}
      </div>
      <div aria-hidden="true" className="summon-twinkles">
        {TWINKLES.map((style, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 固定长度的装饰粒子。
          <span key={index} style={style} />
        ))}
      </div>
    </>
  );
}

type Vars = CSSProperties & Record<`--${string}`, string>;

/** 14 束聚拢的光，角度均分再错开一点，起点远近和节拍各不相同（确定值，每次渲染一样）。 */
const GATHER: Vars[] = Array.from({ length: 14 }, (_, i) => ({
  "--a": `${(i * 360) / 14 + (i % 3) * 7}deg`,
  "--d": `${170 + ((i * 37) % 60)}px`,
  "--delay": `${-((i * 173) % 1000)}ms`,
  "--len": `${12 + ((i * 7) % 14)}px`,
}));

const BURST_COLORS = [
  "var(--summon-gold)",
  "var(--summon-ink)",
  "var(--summon-red)",
  "var(--summon-gold-soft)",
];

/** 26 颗迸发粒子：金、白、红，圆点与菱形混着，飞出的距离和大小各不相同。 */
const BURST: Vars[] = Array.from({ length: 26 }, (_, i) => ({
  "--a": `${(i * 360) / 26 + ((i * 11) % 9)}deg`,
  "--d": `${150 + ((i * 53) % 110)}px`,
  "--s": `${4 + ((i * 5) % 6)}px`,
  "--c": BURST_COLORS[i % BURST_COLORS.length] as string,
  "--r": i % 3 === 0 ? "1px" : "50%",
  "--delay": `${(i * 17) % 90}ms`,
}));

const CONFETTI_COLORS = [
  "var(--summon-gold)",
  "var(--summon-red)",
  "var(--summon-ink)",
  "var(--summon-gold-soft)",
  "var(--summon-amber)",
];

/**
 * 40 片彩带纸屑：先向上向外抛，再带着翻转落下。每三片里有一条细长彩带，其余是小方片；
 * 翻转轴、抛出高度、落点各不相同（确定值）。
 */
const CONFETTI: Vars[] = Array.from({ length: 40 }, (_, i) => {
  const side = i % 2 === 0 ? 1 : -1;
  const ribbon = i % 3 === 0;
  return {
    "--x": `${side * (40 + ((i * 47) % 240))}px`,
    "--up": `${-(110 + ((i * 61) % 170))}px`,
    "--fall": `${150 + ((i * 83) % 230)}px`,
    "--w": ribbon ? "4px" : `${6 + (i % 4)}px`,
    "--h": ribbon ? `${18 + ((i * 7) % 12)}px` : `${9 + ((i * 3) % 6)}px`,
    "--c": CONFETTI_COLORS[i % CONFETTI_COLORS.length] as string,
    "--axis": `${(i % 5) / 4} 1 ${((i * 3) % 4) / 4}`,
    "--spin": `${520 + ((i * 37) % 420)}ms`,
    "--dur": `${1300 + ((i * 29) % 400)}ms`,
    "--delay": `${(i * 13) % 120}ms`,
  };
});

/** 盖章后在工牌周围闪烁的四角星。 */
const TWINKLES: Vars[] = [
  { "--x": "-132px", "--y": "-118px", "--s": "18px", "--delay": "1180ms" },
  { "--x": "128px", "--y": "-92px", "--s": "14px", "--delay": "1300ms" },
  { "--x": "-118px", "--y": "96px", "--s": "12px", "--delay": "1420ms" },
  { "--x": "140px", "--y": "120px", "--s": "20px", "--delay": "1240ms" },
  { "--x": "6px", "--y": "-206px", "--s": "12px", "--delay": "1480ms" },
  { "--x": "-12px", "--y": "200px", "--s": "10px", "--delay": "1560ms" },
];

function restoreFocus(element: HTMLElement | null) {
  if (element?.isConnected) element.focus({ preventScroll: true });
}

/** 系统是否开了「减少动态效果」，跟着系统设置变化。 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => reducedMotionQuery()?.matches ?? false,
  );
  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return;
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function reducedMotionQuery(): MediaQueryList | null {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return null;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)");
}
