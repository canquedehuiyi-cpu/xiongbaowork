import { type SVGProps, useId } from "react";

/**
 * The stage a component preview is drawn on (component tiles and their detail pages).
 *
 * A light, neutral sheet with a faint dot grid, in both themes (docs/design/ios-studio: black, white
 * and red, no decorative colour). It stays light on purpose: a component is drawn the way a
 * conversation shows it, and the preview's own "cannot draw this" sentence is dark text written for
 * a light surface. The rainbow gradient it used to be was the old palette's.
 */
export function SettingsItemBackground(props: SVGProps<SVGSVGElement>) {
  const dots = useId();
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      preserveAspectRatio="xMidYMin slice"
      viewBox="0 0 1200 800"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <defs>
        <pattern height={24} id={dots} patternUnits="userSpaceOnUse" width={24}>
          <circle cx={2} cy={2} fill="#0D0D0E" fillOpacity={0.09} r={1.6} />
        </pattern>
      </defs>
      {/* A shade dimmer on the dark canvas, so the sheet does not outshine the page's own white. */}
      <rect
        className="fill-[#F2F2F3] dark:fill-[#D6D6D9]"
        height="800"
        width="1200"
      />
      <rect fill={`url(#${dots})`} height="800" width="1200" />
    </svg>
  );
}
