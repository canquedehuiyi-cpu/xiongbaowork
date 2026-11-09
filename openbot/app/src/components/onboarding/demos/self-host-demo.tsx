import { WEB_HARNESSES } from "@openbot/shared/harnesses";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { HarnessMark } from "@/components/agents/harness-mark";
import { appConfig } from "@/lib/generated/application-config";
import { DemoStage } from "../demo-stage";
import { LaptopIllustration } from "../laptop-illustration";
import { OrganizationFlow } from "../organization-flow";

/** Every framework the New Bot wizard offers by name; "an agent you already run" is the sentence. */
export const FRAMEWORKS = WEB_HARNESSES.filter(
  (harness) => harness.id !== "byo-url",
);

const PRODUCT = appConfig.brand.productName;

/** The three things somebody running OpenBot themselves is deciding, one picture each. */
const PANELS: Array<{ id: string; caption: string; picture: () => ReactNode }> =
  [
    {
      id: "local",
      caption: "在这台电脑上",
      picture: () => <LaptopIllustration />,
    },
    {
      id: "agents",
      caption: "接入你已有的智能体",
      picture: () => (
        <div className="flex flex-wrap justify-center gap-2">
          {FRAMEWORKS.map((harness) => (
            <span
              className="text-xs flex items-center gap-2 rounded-full bg-card px-3 py-1.5 ring-1 ring-border shadow-sm"
              key={harness.id}
            >
              <HarnessMark id={harness.mark} name={harness.name} />
              {harness.name}
            </span>
          ))}
        </div>
      ),
    },
    {
      id: "organization",
      caption: "面向你的组织",
      picture: () => <OrganizationFlow />,
    },
  ];

function Panel({ panel }: { panel: (typeof PANELS)[number] }) {
  return (
    <div className="flex flex-col items-center gap-5" data-panel={panel.id}>
      <p className="text-xs font-medium text-muted-foreground">
        {panel.caption}
      </p>
      {panel.picture()}
    </div>
  );
}

/**
 * Running it yourself: on this computer, with the agents you already have, and for your
 * organization. The three local-evaluation slides as one picture that turns through them.
 * With reduced motion the three sit one above the other.
 */
export function SelfHostDemo() {
  return (
    <DemoStage
      beats={PANELS.length}
      beatMs={3200}
      className="flex min-h-[22rem] flex-col justify-center gap-10 px-4 py-8 sm:px-6"
      kind="self-host"
      label={`笔记本电脑上的${PRODUCT}；可以作为员工接入的框架：${FRAMEWORKS.map((harness) => harness.name).join("、")}；以及用 Google、Microsoft 或 Okta 登录的组织`}
      rest={-1}
    >
      {({ beat, reduced }) =>
        reduced ? (
          PANELS.map((panel) => <Panel key={panel.id} panel={panel} />)
        ) : (
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              initial={{ opacity: 0, y: 8 }}
              key={PANELS[beat]?.id}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              {PANELS[beat] ? <Panel panel={PANELS[beat]} /> : null}
            </motion.div>
          </AnimatePresence>
        )
      }
    </DemoStage>
  );
}
