import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import logo256 from "@/assets/brand/xiongbao-logo-256.png";
import "./summon-card-flip.css";

/**
 * 召唤一位员工时的翻卡动画，游戏抽卡式：
 *
 *   charging —— 卡背（熊宝 logo + 纹样 + 流光边框）浮在整屏暗色遮罩上，光线向卡片聚拢、卡片轻颤；
 *               召唤请求还在路上时一直蓄力，至少蓄 `SUMMON_MIN_CHARGE_MS`，哪怕请求瞬间就回来了。
 *   reveal   —— 请求兑现后 3D 翻面，露出员工的熊宝头像、名字和职务，光芒、冲击环和粒子迸发，
 *               「召唤成功」弹出；再过 `SUMMON_REVEAL_MS` 调 `onDone()`。
 *
 * `result` 是召唤请求本身：它决定能不能翻面。拒绝时不翻面、不出现「召唤成功」，只调一次
 * `onFail(error)`，遮罩随即收起（交给调用方报错），不会把页面挡住。
 *
 * 点击任意处（或 Esc / Enter / 空格）跳过：已兑现就立刻 `onDone()`；没兑现就先停掉特效，兑现的那一刻
 * `onDone()`。系统开了「减少动态效果」时不播动画，一上来就是结果卡，兑现后立刻 `onDone()`。
 * `onDone` 与 `onFail` 合起来只会被调用一次。
 *
 * 遮罩始终是暗色（不随主题变），颜色在 summon-card-flip.css 里固定在遮罩上，深浅主题下一致。
 */
export const SUMMON_MIN_CHARGE_MS = 600;
/** 从翻面开始到交出 `onDone()` 的时间：翻面、迸发、「召唤成功」，再停一拍让人看清。 */
export const SUMMON_REVEAL_MS = 2000;

export interface SummonCardFlipProps {
  name: string;
  title: string;
  /** 员工头像的图片地址（预设的熊宝头像）。 */
  portrait: string;
  /** 召唤请求：兑现了才翻面。 */
  result: Promise<unknown>;
  onDone: () => void;
  onFail: (error: unknown) => void;
}

type Settled = "pending" | "landed" | "failed";
type Motion = "full" | "skipped" | "reduced";

export function SummonCardFlip({
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

  // 完整动画：翻面后停 SUMMON_REVEAL_MS 再交出。
  useEffect(() => {
    if (!succeeded || motion !== "full") return;
    const timer = setTimeout(finish, SUMMON_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [succeeded, motion, finish]);

  useEffect(() => {
    overlay.current?.focus({ preventScroll: true });
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
      <div className="summon-stage">
        {animated && (
          <>
            <div aria-hidden="true" className="summon-rays" />
            <div aria-hidden="true" className="summon-halo" />
            {phase === "charging" && <ChargeEffects />}
          </>
        )}
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
                <div className="summon-front-ground">
                  <div className="summon-portrait">
                    <img alt={name} draggable={false} src={portrait} />
                  </div>
                  <div className="summon-nameplate">
                    <span className="summon-name">{name}</span>
                    <span className="summon-title">{title}</span>
                  </div>
                  <span aria-hidden="true" className="summon-sheen" />
                </div>
              </div>
            </div>
          </div>
        </div>
        {animated && phase === "reveal" && <RevealBurst />}
      </div>
      <p aria-live="polite" className="summon-status" role="status">
        {succeeded ? "召唤成功" : `正在召唤${name}…`}
      </p>
      <p aria-hidden="true" className="summon-hint">
        点击任意处跳过
      </p>
    </div>,
    document.body,
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

/** 翻面那一刻：闪光、两道冲击环、四散的粒子和几颗闪烁的星。 */
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

/** 翻面后在卡片周围闪烁的四角星。 */
const TWINKLES: Vars[] = [
  { "--x": "-132px", "--y": "-118px", "--s": "18px", "--delay": "620ms" },
  { "--x": "128px", "--y": "-92px", "--s": "14px", "--delay": "760ms" },
  { "--x": "-118px", "--y": "96px", "--s": "12px", "--delay": "880ms" },
  { "--x": "140px", "--y": "120px", "--s": "20px", "--delay": "700ms" },
  { "--x": "6px", "--y": "-196px", "--s": "12px", "--delay": "940ms" },
  { "--x": "-12px", "--y": "200px", "--s": "10px", "--delay": "1020ms" },
];

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
