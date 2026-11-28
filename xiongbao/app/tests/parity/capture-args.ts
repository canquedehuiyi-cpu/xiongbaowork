/**
 * capture.ts 的参数解析与输出路径。单独成文件，是为了单元测试能导入它而不启动浏览器。
 */

import { join } from "node:path";
import { type FixtureAudience, SCENARIOS, type Scenario } from "./fixtures";

export type Theme = "dark" | "light";

export const VIEWPORTS = [
  { width: 1696, height: 783 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
] as const;

export const AUDIENCES: readonly FixtureAudience[] = [
  "admin",
  "member",
  "personal",
];

export const DEFAULT_OUT =
  "/tmp/claude-0/-home-user-xiongbaowork/87ff88c2-019b-516c-a0cd-6b2b65a63f7a/scratchpad/parity-shots";

export type Options = {
  base: string;
  out: string;
  scenarios: Scenario[];
  themes: Theme[];
  audiences: FixtureAudience[];
  /** Playwright `deviceScaleFactor`. */
  scale: number;
  only: string | undefined;
  /** One ad-hoc path to capture instead of the route list. */
  path: string | undefined;
  viewports: { width: number; height: number }[];
  concurrency: number;
};

export function parseArgs(argv: string[]): Options {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const scenario = value("--scenario") ?? "all";
  const theme = value("--theme") ?? "dark";
  const audience = value("--audience") ?? "admin";
  const scaleText = value("--scale") ?? "1";
  const viewport = value("--viewport");
  if (scenario !== "all" && !SCENARIOS.includes(scenario as Scenario)) {
    throw new Error(`--scenario must be data, empty or all (got ${scenario})`);
  }
  if (!["dark", "light", "all"].includes(theme)) {
    throw new Error(`--theme must be dark, light or all (got ${theme})`);
  }
  if (audience !== "all" && !AUDIENCES.includes(audience as FixtureAudience)) {
    throw new Error(
      `--audience must be admin, member, personal or all (got ${audience})`,
    );
  }
  const scale = Number(scaleText);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`--scale must be a positive number (got ${scaleText})`);
  }
  return {
    base: (value("--base") ?? "http://127.0.0.1:3910").replace(/\/$/, ""),
    out: value("--out") ?? DEFAULT_OUT,
    scenarios: scenario === "all" ? [...SCENARIOS] : [scenario as Scenario],
    themes: theme === "all" ? ["dark", "light"] : [theme as Theme],
    audiences:
      audience === "all" ? [...AUDIENCES] : [audience as FixtureAudience],
    scale,
    only: value("--only"),
    path: value("--path"),
    viewports: viewport
      ? [
          {
            width: Number(viewport.split("x")[0]),
            height: Number(viewport.split("x")[1]),
          },
        ]
      : VIEWPORTS.map((entry) => ({ ...entry })),
    concurrency: Math.max(1, Number(value("--concurrency") ?? 3)),
  };
}

/** `<out>/<audience>/<scenario>/<theme>/<WxH>`: runs for different audiences never overwrite each other. */
export const outputDir = (
  out: string,
  audience: FixtureAudience,
  scenario: Scenario,
  theme: Theme,
  size: string,
) => join(out, audience, scenario, theme, size);
