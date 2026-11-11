import { useMutation, useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  redirect,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import * as React from "react";
import {
  ALWAYS_ASKS,
  HANDED_TO_YOU,
} from "@/components/approvals/ask-first-copy";
import { SourcesStep } from "@/components/avatar/avatar-sources";
import { AskFirstSwitch } from "@/components/onboarding/ask-first-switch";
import { IntroReel } from "@/components/onboarding/demos/intro-reel";
import { ModelLibraryGuide } from "@/components/onboarding/model-library-guide";
import { FINISH_MS, useNameStep } from "@/components/onboarding/name-step";
import { StepIntro } from "@/components/onboarding/onboarding-frame";
import {
  type OnboardingStep,
  OnboardingWizard,
} from "@/components/onboarding/onboarding-wizard";
import { currentUserQueryOptions, needsOnboarding } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";
import {
  advanceOnboardingMutationOptions,
  completeOnboardingMutationOptions,
} from "@/lib/onboarding/mutations";
import { setupChecklistQueryOptions } from "@/lib/setup/queries";
import { queryClient } from "@/query-client";

const PRODUCT = appConfig.brand.productName;

/**
 * Every step, by id, with the number the server stores for it.
 *
 * `POST /api/me/onboarding` keeps a step as an integer, so each id has a number of its own. A
 * number per id, never a position in the list: the name step leaves the list for somebody whose
 * name is known, so a position would mean different steps to different people. 0 is the server's
 * "not started".
 */
const STEP_NUMBER = {
  welcome: 1,
  // 2 was upstream's Book a demo, which this deployment leaves out; the number stays unused.
  name: 3,
  sources: 4,
} as const;
type StepId = keyof typeof STEP_NUMBER;

const isStepId = (value: unknown): value is StepId =>
  typeof value === "string" && Object.hasOwn(STEP_NUMBER, value);

/** The step a stored number names, or null for "not started" and for a number no step has. */
function stepForNumber(step: number | undefined): StepId | null {
  const found = Object.entries(STEP_NUMBER).find(([, at]) => at === step);
  return found ? (found[0] as StepId) : null;
}

/**
 * The step somebody was last on. Kept in the history entry Continue pushed (`onboardingFrom`), so
 * Back after a reload still pops the entry instead of adding a second one for the same step.
 */
type OnboardingEntry = { onboardingFrom?: unknown };

export const Route = createFileRoute("/_authed/onboarding")({
  /*
   * WHERE SOMEBODY IS LIVES IN THE ADDRESS. `?step=<id>` is the step on screen, so a reload stays
   * on it, and browser Back and Forward walk the steps. Anything else is ignored.
   */
  validateSearch: (search: Record<string, unknown>): { step?: StepId } => ({
    // Named even when absent: the router lays this over the raw search, so a key left out would
    // keep whatever was typed into the address.
    step: isStepId(search.step) ? search.step : undefined,
  }),
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

/*
 * THREE CLICKS AT MOST INTO THE APP, plus this deployment's own step. Welcome, then where the
 * person's 分身 finds their material (story F1, skippable), then the name. Upstream's Book a demo
 * step (a CopilotKit sales calendar for somebody trying OpenBot alone) is left out. Everything else
 * waits for the app: apps are connected when a Bot needs one, and notifications are offered once
 * the first task has started (`NotifyPrompt`), when what they are for is plain.
 */

/**
 * The welcome step: one animation of what OpenBot does, and beside it the one choice worth making
 * before the first task, whether a Bot asks before it changes anything.
 *
 * What always asks is said above the switch, so nobody reads turning it off as turning those off
 * too. The switch only adds routine changes on top (reported on 0.3.3).
 *
 * The animation is a picture and the switch is real, so they never share a pane: the switch sits
 * with the words, and the picture stays a picture.
 */
function welcomeStep(
  computer: boolean,
  modelGuide: React.ReactNode,
): OnboardingStep {
  return {
    id: "welcome",
    title: `欢迎来到${PRODUCT}`,
    intro: () => (
      <StepIntro
        after={
          <section
            aria-labelledby="onboarding-permissions"
            className="flex flex-col gap-3 text-left"
          >
            <div className="flex flex-col gap-1">
              <h2
                className="text-lg font-semibold text-pretty"
                id="onboarding-permissions"
              >
                设置权限
              </h2>
              <p className="text-pretty text-muted-foreground">
                {ALWAYS_ASKS} {HANDED_TO_YOU}
              </p>
            </div>
            <AskFirstSwitch />
            <div className="flex flex-col gap-1 text-sm text-pretty text-muted-foreground">
              <p>
                除非打开这个开关，员工可以在自己的工作区里新建、修改和删除文件，不必先问你。
              </p>
              <p>之后随时可以在设置里修改。</p>
            </div>
          </section>
        }
      >
        <p>用平常的话把工作交给员工，做完了它会告诉你。</p>
      </StepIntro>
    ),
    demo: () => <IntroReel computer={computer} />,
    // The empty-library nudge: a prompt, not a step, and it never blocks the buttons.
    footnote: modelGuide,
  };
}

/**
 * Story F1: right after the welcome, where the person's 分身 finds their material. Skippable (spec
 * D3): the 分身 then stays 待配置 and is configured from its own detail page. The step carries its
 * own ways forward (save, or skip) and writes the step it leads to itself, so the wizard's buttons
 * are not shown under it.
 */
function sourcesStep(nextStep: number, onAdvanced: () => void): OnboardingStep {
  return {
    id: "sources",
    // The step list names a step by its heading, and SourcesStep draws its own.
    title: "告诉你的分身，你的资料在哪里",
    intro: () => <SourcesStep nextStep={nextStep} onAdvanced={onAdvanced} />,
    primaryHidden: true,
  };
}

function RouteComponent() {
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const search = Route.useSearch();
  const complete = useMutation(completeOnboardingMutationOptions(queryClient));
  const advance = useMutation(advanceOnboardingMutationOptions(queryClient));
  const me = useQuery(currentUserQueryOptions());

  /*
   * A NAME ALREADY KNOWN IS NOT ASKED FOR AGAIN. A sign-in that brought a real name leaves the name
   * step out, and the last step left gets the person in instead.
   *
   * DECIDED ONCE, ON ARRIVAL. Saving the name on the name step makes it known, and deciding again
   * then would drop the step from under its own finish, back to Welcome. `beforeLoad` has the user
   * in the cache before the first render, so the first answer is the real one.
   */
  const [nameKnown] = React.useState(
    () =>
      me.data?.needsName !== true &&
      Boolean(me.data?.name) &&
      me.data?.name !== me.data?.email,
  );
  const ids: StepId[] = [
    "welcome",
    "sources",
    ...(nameKnown ? [] : (["name"] as const)),
  ];

  /*
   * The step on screen: the address's, else the one the server saved, else the first. A step not in
   * this person's list (the name step once it is known) reads as the last one they have. Arriving
   * without a step writes it into the address in place, so the entry the person lands on already
   * names its step.
   */
  const reachable = (step: StepId | null | undefined): StepId | undefined => {
    if (!step) return undefined;
    return ids.includes(step) ? step : ids[ids.length - 1];
  };
  const saved = reachable(stepForNumber(me.data?.onboarding?.step));
  const asked = reachable(isStepId(search.step) ? search.step : undefined);
  const current: StepId = asked ?? saved ?? "welcome";
  React.useEffect(() => {
    if (asked !== undefined && asked === search.step) return;
    navigate({ to: "/onboarding", search: { step: current }, replace: true });
  }, [navigate, current, asked, search.step]);

  // Saved wherever the person goes, by Continue, Back or the browser.
  const savedStep = me.data?.onboarding?.step;
  const { mutate: save } = advance;
  React.useEffect(() => {
    if (savedStep === undefined || savedStep === STEP_NUMBER[current]) return;
    /*
     * A save that fails is tried again on the next move, since the saved step still differs. It is
     * said in the console rather than on the step: the person is where they meant to be, and only a
     * reload would show the place was not kept.
     */
    save(STEP_NUMBER[current], {
      onError: (error) =>
        console.warn("Your place in onboarding was not saved.", error),
    });
  }, [current, savedStep, save]);

  /*
   * CONTINUE PUSHES, AND BACK RETURNS THROUGH HISTORY WHEN IT CAN. Continue adds an entry carrying
   * the step it was pressed on, so browser Back walks back a step. The frame's Back pops that entry
   * when it was pushed from the step behind, and otherwise (arriving by a link, say) replaces this
   * entry with the step behind, so history never holds the same step twice in a row.
   */
  const cameFrom = (location.state as OnboardingEntry).onboardingFrom;
  const move = (to: string, way: "forward" | "back") => {
    if (!isStepId(to)) return;
    if (way === "back" && cameFrom === to) {
      router.history.back();
      return;
    }
    const state: Record<string, unknown> =
      way === "forward" ? { onboardingFrom: current } : {};
    navigate({
      to: "/onboarding",
      search: { step: to },
      replace: way === "back",
      state,
    });
  };

  /*
   * THE WAY OUT IS THE LAST STEP'S BUTTON. On the name step, Get started saves the name first. Then
   * completion is saved, the orb or the button plays its finish, the page fades, and the app opens.
   * A completion that fails is said on the step, and the button can be pressed again.
   */
  const reduced = useReducedMotion() === true;
  const [finished, setFinished] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  /*
   * Where the fade lands. The model guide's way out goes to 能力's model library tab
   * (`/capabilities/models`), which the person can only reach once onboarding is finished.
   */
  const [destination, setDestination] = React.useState<
    "/" | "/capabilities/models"
  >("/");
  const finish = async () => {
    await complete.mutateAsync(undefined);
    setFinished(true);
    await new Promise((resolve) =>
      setTimeout(resolve, reduced ? 150 : FINISH_MS),
    );
    setLeaving(true);
  };
  React.useEffect(() => {
    if (!leaving) return;
    // Navigation must also complete in a background tab, where animation frames may pause.
    const timer = setTimeout(
      () =>
        destination === "/capabilities/models"
          ? navigate({ to: "/capabilities/models" })
          : navigate({ to: "/" }),
      reduced ? 0 : 300,
    );
    return () => clearTimeout(timer);
  }, [leaving, navigate, reduced, destination]);

  const name = useNameStep({ finish, finished });
  /*
   * The checklist says whether there is a Bot computer, and the intro shows one only where there
   * is. Until it answers, the usual case: a computer that is there.
   */
  const { data: checklist } = useQuery(setupChecklistQueryOptions());
  const computerMissing =
    checklist?.rows.find((row) => row.id === "computer")?.status ===
    "needs_setup";

  const finishFailed = complete.error ? (
    <p
      className="text-sm text-center text-destructive lg:text-left"
      role="alert"
    >
      {complete.error.message || "没能完成设置，请重试。"}
    </p>
  ) : undefined;

  const after = (id: StepId): StepId | undefined => ids[ids.indexOf(id) + 1];
  const sourcesNext = after("sources");
  const byId: Record<StepId, OnboardingStep> = {
    welcome: welcomeStep(
      !computerMissing,
      <ModelLibraryGuide
        connecting={
          complete.isPending && destination === "/capabilities/models"
        }
        onConnect={() => {
          // Finishing comes first: every screen behind it sends somebody unfinished straight back.
          setDestination("/capabilities/models");
          void finish().catch(() => setDestination("/"));
        }}
      />,
    ),
    sources: sourcesStep(
      sourcesNext ? STEP_NUMBER[sourcesNext] : STEP_NUMBER.sources,
      () => {
        if (sourcesNext) move(sourcesNext, "forward");
        else void finish().catch(() => undefined);
      },
    ),
    name,
  };
  /*
   * Without the name step, the last step's buttons finish onboarding where they would have moved
   * on: Get started on the last step left. The sources step finishes from its own buttons.
   */
  const lastId = ids[ids.length - 1];
  const steps: OnboardingStep[] = ids.map((id) => {
    const step = byId[id];
    // The sources step finishes from its own buttons; a completion that fails there is said too.
    if (id === "sources")
      return id === lastId
        ? { ...step, notice: step.notice ?? finishFailed }
        : step;
    if (id !== lastId || id === "name") return step;
    const out = () => void finish().catch(() => undefined);
    return {
      ...step,
      primaryLabel: finished ? "都好了" : (step.primaryLabel ?? "开始使用"),
      primaryDone: finished,
      primaryPending: complete.isPending,
      // A step's own primary decides whether it moves on (it is handed the finish); a step without
      // one finishes. No step here has its own today; upstream's Book a demo step was one.
      onPrimary: step.onPrimary ? () => step.onPrimary?.(out) : out,
      secondary: step.secondary
        ? { label: step.secondary.label, onClick: out }
        : undefined,
      notice: step.notice ?? finishFailed,
    };
  });

  return (
    // Outside `_app` on purpose: no sidebar and no chrome until onboarding is done.
    // The fade runs only after the completion is saved, so a failed save never fades a page the
    // person still needs, and navigation waits for the fade, so the next screen never pops in over
    // a half-faded onboarding.
    <motion.div
      animate={{ opacity: leaving ? 0 : 1 }}
      className={`min-h-svh w-full ${leaving ? "pointer-events-none" : ""}`}
      initial={false}
      transition={{ duration: reduced ? 0 : 0.3, ease: "easeOut" }}
    >
      <OnboardingWizard
        onMove={(to, way) => move(to, way)}
        stepId={current}
        steps={steps}
      />
    </motion.div>
  );
}
