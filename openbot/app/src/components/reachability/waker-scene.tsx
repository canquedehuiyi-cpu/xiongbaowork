import { cn } from "@/lib/utils";

/**
 * The @Waker hero's picture: messages from IM apps, a text and a phone travelling to one coworker.
 *
 * Drawn here rather than shipped as an image, so it follows the theme (every colour is a theme
 * token through `currentColor` or a CSS variable) and carries no other company's artwork. The app
 * tiles are generic shapes with letters, not anyone's logo.
 */
export function WakerScene({ className }: { className?: string }) {
  return (
    <svg
      aria-label="示意图：来自 IM 聊天、短信和手机的消息汇集到你的员工"
      className={cn("h-auto w-full text-muted-foreground", className)}
      role="img"
      viewBox="0 0 360 200"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Paths from each source to the coworker. */}
      <g
        fill="none"
        stroke="currentColor"
        strokeDasharray="3 5"
        strokeLinecap="round"
        strokeOpacity="0.45"
        strokeWidth="1.5"
      >
        <path d="M86 44 C150 44 170 92 226 100" />
        <path d="M86 100 C150 100 170 100 226 100" />
        <path d="M86 156 C150 156 170 108 226 100" />
      </g>

      {/* Three sources: two chat apps and a phone. */}
      {[
        { y: 24, letter: "S" },
        { y: 80, letter: "T" },
      ].map(({ y, letter }) => (
        <g key={letter}>
          <rect
            fill="var(--card)"
            height="40"
            rx="10"
            stroke="var(--border)"
            width="56"
            x="30"
            y={y}
          />
          <rect
            fill="currentColor"
            fillOpacity="0.18"
            height="20"
            rx="6"
            width="20"
            x="40"
            y={y + 10}
          />
          <text
            fill="var(--foreground)"
            fontSize="11"
            fontWeight="600"
            textAnchor="middle"
            x="50"
            y={y + 24}
          >
            {letter}
          </text>
          <rect
            fill="currentColor"
            fillOpacity="0.35"
            height="4"
            rx="2"
            width="16"
            x="64"
            y={y + 14}
          />
          <rect
            fill="currentColor"
            fillOpacity="0.2"
            height="4"
            rx="2"
            width="10"
            x="64"
            y={y + 22}
          />
        </g>
      ))}
      <g>
        <rect
          fill="var(--card)"
          height="44"
          rx="8"
          stroke="var(--border)"
          width="28"
          x="44"
          y="134"
        />
        <rect
          fill="currentColor"
          fillOpacity="0.18"
          height="26"
          rx="3"
          width="20"
          x="48"
          y="141"
        />
        <circle cx="58" cy="172" fill="currentColor" fillOpacity="0.4" r="2" />
      </g>

      {/* Bubbles in flight. */}
      <g>
        <rect
          fill="var(--card)"
          height="22"
          rx="11"
          stroke="var(--border)"
          width="58"
          x="118"
          y="40"
        />
        <rect
          fill="currentColor"
          fillOpacity="0.35"
          height="4"
          rx="2"
          width="34"
          x="130"
          y="49"
        />
        <rect
          fill="var(--card)"
          height="22"
          rx="11"
          stroke="var(--border)"
          width="46"
          x="128"
          y="138"
        />
        <rect
          fill="currentColor"
          fillOpacity="0.35"
          height="4"
          rx="2"
          width="22"
          x="140"
          y="147"
        />
      </g>

      {/* The coworker, with the primary colour as the one accent. */}
      <circle
        cx="262"
        cy="100"
        fill="var(--primary)"
        fillOpacity="0.14"
        r="46"
      />
      <circle
        cx="262"
        cy="100"
        fill="var(--card)"
        r="34"
        stroke="var(--primary)"
        strokeWidth="1.5"
      />
      <circle cx="262" cy="90" fill="var(--primary)" r="10" />
      <path
        d="M242 118 C246 106 278 106 282 118"
        fill="none"
        stroke="var(--primary)"
        strokeLinecap="round"
        strokeWidth="6"
      />
      <g>
        <rect
          fill="var(--primary)"
          height="24"
          rx="12"
          width="40"
          x="290"
          y="50"
        />
        <text
          fill="var(--primary-foreground)"
          fontSize="12"
          fontWeight="700"
          textAnchor="middle"
          x="310"
          y="66"
        >
          @
        </text>
      </g>
    </svg>
  );
}
