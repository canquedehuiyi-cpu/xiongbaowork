import { useId } from "react";
import { appConfig } from "@/lib/generated/application-config";
import { cn } from "@/lib/utils";

/**
 * The @Waker hero's picture: a group chat in an IM app where someone @-mentions a coworker.
 *
 * Composed the way the reference's hero is (docs/acceptance/qoderwake-reference/reachability.png,
 * measured at 1696×850): a dark card with a faint green line pattern, a chat window in it — title
 * bar, one request in a green-tinted bubble, an input bar — and three app badges around it. Drawn
 * here rather than shipped as an image, so it follows the theme (every colour is a theme token) and
 * carries no other company's artwork: the title bar names OUR product, and the badges are generic
 * chat shapes, not anyone's logo. The viewBox is the reference's box in CSS px (624×280), with the
 * right-hand badge hanging 12px past the card as there.
 */
export function WakerScene({ className }: { className?: string }) {
  const clip = useId();
  return (
    <svg
      aria-label="示意图：在 IM 群聊里 @员工，把工作交给它"
      className={cn("h-auto w-full max-w-[624px]", className)}
      role="img"
      viewBox="0 0 624 280"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <clipPath id={clip}>
          <rect height="280" rx="12" width="583" x="29" y="0" />
        </clipPath>
      </defs>

      {/* The card: the card colour tinted green, with a few broad, faint strokes across it. */}
      <g clipPath={`url(#${clip})`}>
        <rect fill="var(--card)" height="280" width="583" x="29" y="0" />
        <rect
          fill="var(--primary)"
          fillOpacity="0.1"
          height="280"
          width="583"
          x="29"
          y="0"
        />
        <g
          fill="none"
          stroke="var(--primary)"
          strokeLinecap="round"
          strokeOpacity="0.16"
          strokeWidth="9"
        >
          <path d="M20 26 C90 -6 170 4 250 -10" />
          <path d="M40 300 C60 230 30 170 70 120" />
          <path d="M560 300 C600 250 640 230 610 180" />
          <path d="M600 30 C560 60 590 120 640 140" />
        </g>

        {/* The chat window, running off the card's foot. */}
        <rect
          fill="var(--background)"
          height="300"
          rx="10"
          stroke="var(--foreground)"
          strokeOpacity="0.08"
          width="520"
          x="68"
          y="20"
        />
        <line
          stroke="var(--foreground)"
          strokeOpacity="0.13"
          x1="68"
          x2="588"
          y1="56.5"
          y2="56.5"
        />
        <text fontSize="12" x="84" y="43">
          <tspan fill="var(--primary)">群聊</tspan>
          <tspan dx="10" fill="var(--foreground)" fillOpacity="0.8">
            {appConfig.brand.productName}
          </tspan>
        </text>

        {/* The request, in a green-tinted bubble beside the sender. */}
        <rect
          fill="var(--primary)"
          fillOpacity="0.1"
          height="32"
          rx="8"
          width="257"
          x="275"
          y="71"
        />
        <text fontSize="13" textAnchor="end" x="520" y="91.5">
          <tspan fill="var(--primary)">@员工</tspan>
          <tspan dx="4" fill="var(--foreground)" fontWeight="600">
            整理本周客户反馈，并给出优先级
          </tspan>
        </text>
        <circle
          cx="558"
          cy="87"
          fill="var(--foreground)"
          fillOpacity="0.18"
          r="14"
        />
        <circle
          cx="558"
          cy="83"
          fill="var(--foreground)"
          fillOpacity="0.55"
          r="4.5"
        />
        <path
          d="M550 95 C551 89.5 565 89.5 566 95"
          fill="none"
          stroke="var(--foreground)"
          strokeLinecap="round"
          strokeOpacity="0.55"
          strokeWidth="3"
        />

        {/* The input bar, with our bear as the coworker about to answer. */}
        <circle cx="88" cy="133" fill="var(--primary)" r="3.5" />
        <circle cx="100" cy="133" fill="var(--primary)" r="3.5" />
        <circle cx="94" cy="140" fill="var(--primary)" r="8" />
        <circle cx="91" cy="139" fill="var(--primary-foreground)" r="1.2" />
        <circle cx="97" cy="139" fill="var(--primary-foreground)" r="1.2" />
        <rect
          fill="var(--muted)"
          height="33"
          rx="6"
          width="426"
          x="116"
          y="123"
        />
        <line
          stroke="var(--foreground)"
          strokeOpacity="0.6"
          x1="128.5"
          x2="128.5"
          y1="131"
          y2="148"
        />
      </g>

      {/* Three generic chat-app badges: shapes, not logos. */}
      {[
        { x: 4, y: 17 },
        { x: 0, y: 191 },
        { x: 560, y: 93 },
      ].map(({ x, y }) => (
        <rect
          fill="var(--card)"
          height="64"
          key={`${x}-${y}`}
          rx="12"
          stroke="var(--foreground)"
          strokeOpacity="0.07"
          width="64"
          x={x + 0.5}
          y={y + 0.5}
        />
      ))}
      {/* A speech bubble with three dots. */}
      <path
        d="M22 38 h28 a5 5 0 0 1 5 5 v14 a5 5 0 0 1 -5 5 h-16 l-7 6 v-6 h-5 a5 5 0 0 1 -5 -5 v-14 a5 5 0 0 1 5 -5 z"
        fill="var(--primary)"
        fillOpacity="0.85"
      />
      {[29, 36, 43].map((cx) => (
        <circle
          cx={cx}
          cy="50"
          fill="var(--primary-foreground)"
          key={cx}
          r="2"
        />
      ))}
      {/* Two overlapping bubbles. */}
      <circle
        cx="27"
        cy="219"
        fill="none"
        r="11"
        stroke="var(--foreground)"
        strokeOpacity="0.7"
        strokeWidth="3"
      />
      <circle cx="40" cy="232" fill="var(--primary)" r="9" />
      {/* A channel hash. */}
      <g
        stroke="var(--foreground)"
        strokeLinecap="round"
        strokeOpacity="0.75"
        strokeWidth="3.5"
      >
        <line x1="585" x2="581" y1="113" y2="139" />
        <line x1="597" x2="593" y1="113" y2="139" />
        <line x1="577" x2="603" y1="121" y2="121" />
        <line stroke="var(--primary)" x1="575" x2="601" y1="131" y2="131" />
      </g>
    </svg>
  );
}
