import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import Avatar from "boring-avatars";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import * as React from "react";
import useMeasure from "react-use-measure";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { SourcesStep } from "@/components/avatar/avatar-sources";
import { Composer } from "@/components/channels/composer";
import { DesktopIllustration } from "@/components/computer/desktop-illustration";
import { ComputerPlaceholder } from "@/components/computer/placeholder";
import { ModelLibraryGuide } from "@/components/onboarding/model-library-guide";
import { Button } from "@/components/ui/button";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions, needsOnboarding } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";
import {
  advanceOnboardingMutationOptions,
  completeOnboardingMutationOptions,
} from "@/lib/onboarding/mutations";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/onboarding")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    // Somebody who has finished, or whose deployment tracks no onboarding, has no business here.
    if (!user || !needsOnboarding(user)) {
      throw redirect({ to: "/" });
    }
  },
  component: RouteComponent,
});

function WelcomeStep() {
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center">
        欢迎来到{appConfig.brand.productName}
      </h1>
      <div className="h-32" />
      <AgentOrb size="72px" />
      {/*
       * A POSTER OF A COMPOSER, AND `pointer-events-none` IS WHAT MAKES IT ONE. Nothing here is
       * meant to be typed in, clicked or dropped on: it is a picture of the thing the person is
       * about to get, shown while they read a sentence about it.
       *
       * THE DROP THAT PASSES STRAIGHT THROUGH IT IS SOMEBODY ELSE'S TO CATCH, WHICH IS WORTH
       * SAYING OUT LOUD. The composer guards its own form against a dropped file navigating the
       * whole app away (`refuseDragOver` in `composer.tsx`), and that guard cannot fire here: an
       * element with no pointer events is never the target of the drop, so the event goes past it
       * to the document as if this composer were not on the page. What catches it is
       * `useUnclaimedDropGuard` in `routes/__root.tsx`, which refuses every drop nobody claimed —
       * the reason that guard lives at the root rather than in the composer, and the reason this
       * wrapper does not need to change to be safe. Taking `pointer-events-none` off to "fix" the
       * drop would turn the poster back into a live composer with nowhere to upload to.
       */}
      <div className="max-w-md w-full mx-auto pointer-events-none mt-10">
        <Composer
          compact
          className="scale-90"
          editorClassName="text-base"
          initialValue="把任务交给你的数字员工团队"
        />
      </div>
    </div>
  );
}

function ComputerUseStep() {
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center">
        每位员工都有自己的电脑
      </h1>
      <div className="h-8" />
      <div className="relative aspect-5/3 w-full max-w-lg rounded-2xl overflow-hidden border border-border">
        <ComputerPlaceholder className="absolute inset-0 h-full w-full" />
        <DesktopIllustration />
      </div>
    </div>
  );
}

/** What a roster card needs — placeholders carry these three fields and nothing more. */
type RosterCard = Pick<AgentProfile, "id" | "name" | "avatarSeed">;

/**
 * Stand-ins for a deployment that has fewer than three public agents to show. Invented names on
 * purpose: they illustrate what a roster looks like without claiming any of these exist here.
 */
const AGENTS_PLACEHOLDER: RosterCard[] = [
  {
    id: "placeholder-research",
    name: "研究分析师",
    avatarSeed: "research-analyst",
  },
  { id: "placeholder-data", name: "数据分析师", avatarSeed: "data-analyst" },
  {
    id: "placeholder-support",
    name: "客服专员",
    avatarSeed: "support-agent",
  },
];

function RosterStep() {
  const { data: agents } = useQuery(agentListQueryOptions());
  const explore =
    agents?.filter((a) => !a.mine && a.visibility === "public") ?? [];
  // Always three cards: real public agents first, placeholders topping up a sparse deployment.
  // slice past the end is just [], so a roster of three or more takes no placeholders at all.
  const roster: Array<RosterCard & { example?: boolean }> = [
    ...explore.slice(0, 3),
    ...AGENTS_PLACEHOLDER.slice(explore.length).map((placeholder) => ({
      ...placeholder,
      example: true,
    })),
  ];

  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center">
        从多种员工里挑选，或者创建你自己的
      </h1>
      <div className="h-8" />
      <div className="w-full max-w-lg overflow-hidden grid grid-cols-1 md:grid-cols-2 gap-4">
        {roster.map((a) => {
          return (
            <div
              key={a.id}
              // Dimmed and labelled, so an invented name never reads as a Bot this deployment has.
              className={`bg-card p-4 rounded-lg flex flex-row gap-4 items-center ${a.example ? "opacity-70" : ""}`}
            >
              <Avatar name={a.avatarSeed} size={40} />
              <div className="flex min-w-0 flex-col">
                <h3 className="line-clamp-1 text-base font-medium tracking-tight">
                  {a.name}
                </h3>
                {a.example ? (
                  <span className="text-xs text-muted-foreground">示例</span>
                ) : null}
              </div>
            </div>
          );
        })}
        <div className="bg-card p-4 rounded-lg flex flex-row gap-4 items-center">
          <div className="rounded-full size-[40px] border border-foreground/30 border-dashed" />
          <h3 className="line-clamp-1 text-base font-medium tracking-tight text-foreground/70">
            你自己的员工
          </h3>
        </div>
      </div>
    </div>
  );
}

/**
 * The wizard, in order. A step with `ownActions` carries its own ways forward (the information-source
 * step saves or skips, and writes the step itself), so the shared 继续 is not shown under it.
 */
const STEPS: Array<{
  render: (moveTo: (step: number) => void, index: number) => React.ReactNode;
  ownActions?: boolean;
}> = [
  { render: () => <WelcomeStep /> },
  /*
   * Story F1: right after the welcome, the 分身's information sources. Skippable (spec D3): the
   * 分身 then stays 待配置 and is configured from its own detail page.
   */
  {
    render: (moveTo, index) => (
      <SourcesStep nextStep={index + 1} onAdvanced={() => moveTo(index + 1)} />
    ),
    ownActions: true,
  },
  { render: () => <ComputerUseStep /> },
  { render: () => <RosterStep /> },
];

/** A pane arrives from the side the journey is moving toward, and leaves out the other. */
const variants = {
  initial: (direction: number) => ({ x: `${110 * direction}%`, opacity: 0 }),
  active: { x: "0%", opacity: 1 },
  exit: (direction: number) => ({ x: `${-110 * direction}%`, opacity: 0 }),
};

function RouteComponent() {
  const navigate = useNavigate();
  const complete = useMutation(completeOnboardingMutationOptions(queryClient));
  const advance = useMutation(advanceOnboardingMutationOptions(queryClient));
  const { data: user } = useQuery(currentUserQueryOptions());

  /*
   * Where the person left off, as the server has it (spec D8): every move below writes the step, so a
   * reload comes back to the same pane. Clamped, because the number outlives any one wizard's length.
   */
  const [step, setStep] = React.useState(() =>
    Math.min(Math.max(user?.onboarding?.step ?? 0, 0), STEPS.length - 1),
  );
  const [direction, setDirection] = React.useState(1);
  // The way out: set once the completion is saved, it fades the whole page and then navigates.
  const [leaving, setLeaving] = React.useState(false);
  // Where the fade lands. The model guide's way out goes to the resources screen's model zone.
  const [destination, setDestination] = React.useState<"/" | "/resources">("/");
  const [ref, bounds] = useMeasure();

  const last = step === STEPS.length - 1;

  /** Show a step that is already saved on the server. */
  const moveTo = (to: number) => {
    setDirection(to > step ? 1 : -1);
    setStep(to);
  };
  /** Move and save the step, so a reload resumes here. A failed save is shown, not fatal. */
  const go = (to: number) => {
    moveTo(to);
    advance.mutate(to);
  };
  const current = STEPS[step];

  return (
    // Outside `_app` on purpose: no sidebar and no chrome until onboarding is done.
    // The fade runs only after the completion is saved, so a failed save never fades a page the
    // person still needs — and navigation waits for the fade, so the home screen never pops in
    // over a half-faded wizard.
    <motion.div
      animate={{ opacity: leaving ? 0 : 1 }}
      className={`min-h-svh overflow-hidden flex flex-col items-center justify-center w-full ${leaving ? "pointer-events-none" : ""}`}
      initial={false}
      onAnimationComplete={() => {
        if (leaving) {
          // Connecting a model lands on 能力与资源's model library tab, not its default 插件 tab.
          if (destination === "/resources")
            navigate({ to: destination, search: { tab: "models" } });
          else navigate({ to: destination });
        }
      }}
      transition={{ duration: 0.5, ease: "easeInOut" }}
    >
      <div className="mx-auto w-full max-w-2xl px-4">
        <MotionConfig transition={{ duration: 0.5, type: "spring", bounce: 0 }}>
          {/* The frame follows each pane's height, so the buttons glide instead of jumping. */}
          <motion.div
            animate={{ height: bounds.height > 0 ? bounds.height : "auto" }}
            className="overflow-hidden"
          >
            <div ref={ref}>
              <AnimatePresence
                custom={direction}
                initial={false}
                mode="popLayout"
              >
                <motion.div
                  animate="active"
                  custom={direction}
                  exit="exit"
                  initial="initial"
                  key={step}
                  variants={variants}
                >
                  {current?.render(moveTo, step)}
                </motion.div>
              </AnimatePresence>

              {/*
               * The empty-library nudge. Finishing onboarding comes first, because every screen
               * behind it sends somebody who has not finished straight back here.
               */}
              <ModelLibraryGuide
                connecting={complete.isPending && destination === "/resources"}
                onConnect={() => {
                  setDestination("/resources");
                  complete.mutate(undefined, {
                    onSuccess: () => setLeaving(true),
                    onError: () => setDestination("/"),
                  });
                }}
              />

              {complete.error || advance.error ? (
                <p className="mt-4 text-destructive text-sm" role="alert">
                  {(complete.error ?? advance.error)?.message}
                </p>
              ) : null}

              <motion.div
                className="mt-20 flex flex-col items-center justify-center max-w-xs gap-4 w-full mx-auto"
                layout
              >
                {current?.ownActions ? null : (
                  <Button
                    className="w-full"
                    disabled={complete.isPending}
                    onClick={() => {
                      if (last) {
                        complete.mutate(undefined, {
                          onSuccess: () => setLeaving(true),
                        });
                      } else {
                        go(step + 1);
                      }
                    }}
                    size="lg"
                  >
                    {complete.isPending
                      ? "正在保存…"
                      : last
                        ? "开始使用"
                        : "继续"}
                  </Button>
                )}
                {step !== 0 && (
                  <Button
                    className="w-full"
                    onClick={() => go(step - 1)}
                    variant="secondary"
                    size="lg"
                  >
                    返回
                  </Button>
                )}
              </motion.div>
            </div>
          </motion.div>
        </MotionConfig>
      </div>
    </motion.div>
  );
}
