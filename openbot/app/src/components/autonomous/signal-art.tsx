/**
 * 自主工作's header art (docs/design/ios-studio `.signal-stage`, 03-自主工作.png): a tilted graphite
 * chip with a bolt and a red underline, faint circuit traces either side, one red signal running
 * through it to a red node, a few light points and two dashed reticles, and the mono caption
 * 「● TRIGGER → EXECUTE」 under it.
 *
 * The drawing is the reference's own SVG, served as one image rather than as live nodes: it is pure
 * decoration, and a few dozen svg elements in the page's tree tripled the time every role query on
 * this page took (measured on tests/autonomous-screen.test.tsx). Its traces and points are a neutral
 * grey, so the same picture reads on the dark canvas and on paper. It is still: nothing moves, so
 * there is nothing for a reduced-motion preference to turn off. `PageShell` hides it below md.
 */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 260" fill="none">
<defs>
<linearGradient id="t"><stop stop-color="#a3a3a6" stop-opacity="0"/><stop offset=".52" stop-color="#a3a3a6" stop-opacity=".42"/><stop offset="1" stop-color="#a3a3a6" stop-opacity="0"/></linearGradient>
<linearGradient id="b"><stop stop-color="#ed373a" stop-opacity="0"/><stop offset=".45" stop-color="#fa565b"/><stop offset=".66" stop-color="#ffc5c5"/><stop offset="1" stop-color="#ed373a" stop-opacity="0"/></linearGradient>
<linearGradient id="m" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="#3e3f42"/><stop offset=".38" stop-color="#242426"/><stop offset=".74" stop-color="#151517"/><stop offset="1" stop-color="#272729"/></linearGradient>
<linearGradient id="r"><stop stop-color="#e3e3e3" stop-opacity=".74"/><stop offset=".44" stop-color="#b0b0b0" stop-opacity=".2"/><stop offset="1" stop-color="#797979" stop-opacity=".5"/></linearGradient>
<radialGradient id="h"><stop stop-color="#ea343a" stop-opacity=".26"/><stop offset="1" stop-color="#ea343a" stop-opacity="0"/></radialGradient>
<filter id="f" x="-50%" width="200%" y="-50%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>
</defs>
<ellipse cx="284" cy="137" rx="190" ry="97" fill="url(#h)"/>
<g stroke="url(#t)">
<path d="M14 184h96l47-34h169l47-33h131M20 196h94l48-34h168l47-33h135M8 208h110l47-34h169l47-33h123M29 220h93l47-34h168l47-33h119M50 232h76l47-34h169l46-33h116"/>
<path d="M52 107h66l47 34h164l46 35h120M70 95h52l47 34h164l46 35h125M28 83h98l47 34h164l46 35h106"/>
</g>
<path d="M10 196h104l48-34h168l47-33h135" stroke="url(#b)" stroke-width="7" filter="url(#f)"/>
<path d="M10 196h104l48-34h168l47-33h135" stroke="url(#b)" stroke-width="1.5"/>
<g transform="translate(275 128) rotate(-18)">
<rect x="-59" y="-36" width="118" height="101" rx="24" fill="#121214" stroke="#ffffff" stroke-opacity=".15"/>
<rect x="-59" y="-51" width="118" height="101" rx="24" fill="url(#m)" stroke="url(#r)"/>
<rect x="-51" y="-43" width="102" height="85" rx="18" stroke="#ffffff" stroke-opacity=".11"/>
<path d="M-37 47h70" stroke="#fe5257" stroke-width="2"/>
<path d="m4-24-18 26h14l-4 23 18-28H1l3-21Z" fill="#f7f7f7"/>
</g>
<g fill="#fa565b"><circle cx="114" cy="196" r="3"/><circle cx="377" cy="129" r="3"/></g>
<g fill="#b9b9bc"><circle cx="118" cy="107" r="2"/><circle cx="421" cy="164" r="2"/></g>
<path d="M411 72h55m-27-11v22M99 151h19m-9-9v18" stroke="#9a9a9d" stroke-opacity=".5" stroke-dasharray="2 3"/>
</svg>`;

const SRC = `data:image/svg+xml,${encodeURIComponent(SVG)}`;

export function SignalArt() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-y-0 right-[15%] w-full"
      data-slot="signal-art"
    >
      <img
        alt=""
        className="absolute inset-0 h-full w-full select-none object-contain"
        decoding="async"
        draggable={false}
        src={SRC}
      />
      <span className="absolute right-[19%] bottom-[12px] flex items-center gap-[5px] font-mono text-[9px] text-faint uppercase tracking-[0.1em]">
        <span className="size-[4px] rounded-full bg-signal" />
        TRIGGER → EXECUTE
      </span>
    </div>
  );
}
