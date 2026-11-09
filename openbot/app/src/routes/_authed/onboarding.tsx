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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
import useMeasure from "react-use-measure";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { SourcesStep } from "@/components/avatar/avatar-sources";
import { Composer } from "@/components/channels/composer";
import { DesktopIllustration } from "@/components/computer/desktop-illustration";
import { ComputerPlaceholder } from "@/components/computer/placeholder";
import { ModelLibraryGuide } from "@/components/onboarding/model-library-guide";
=======
import {
  ALWAYS_ASKS,
  HANDED_TO_YOU,
} from "@/components/approvals/ask-first-copy";
import { AskFirstSwitch } from "@/components/onboarding/ask-first-switch";
import { BookingCalendar } from "@/components/onboarding/booking-calendar";
import { IntroReel } from "@/components/onboarding/demos/intro-reel";
import { SelfHostDemo } from "@/components/onboarding/demos/self-host-demo";
import { FINISH_MS, useNameStep } from "@/components/onboarding/name-step";
import { StepIntro } from "@/components/onboarding/onboarding-frame";
import {
  type OnboardingStep,
  OnboardingWizard,
} from "@/components/onboarding/onboarding-wizard";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
import { Button } from "@/components/ui/button";
import { currentUserQueryOptions, needsOnboarding } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { appConfig } from "@/lib/generated/application-config";
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
=======
import { BUSINESS_URL } from "@/lib/openbot-for-business";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
import {
  advanceOnboardingMutationOptions,
  completeOnboardingMutationOptions,
} from "@/lib/onboarding/mutations";
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
=======
import { setupChecklistQueryOptions } from "@/lib/setup/queries";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
import { queryClient } from "@/query-client";

const PRODUCT = appConfig.brand.productName;

/**
 * Every step, by id, with the number the server stores for it.
 *
 * `POST /api/me/onboarding` keeps a step as an integer, so each id has a number of its own. A
 * number per id, never a position in the list: Book a demo joins the list only for somebody trying
 * OpenBot alone, and the name step leaves it for somebody whose name is known, so a position would
 * mean different steps to different people. 0 is the server's "not started".
 */
const STEP_NUMBER = {
  welcome: 1,
  selfhost: 2,
  name: 3,
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

<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
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
          initialValue="把任务交给你的员工团队"
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
=======
/*
 * THREE CLICKS AT MOST INTO THE APP. Welcome, then Book a demo for somebody trying OpenBot alone,
 * then the name. Everything else waits for the app: the setup checklist lives in Settings → Setup,
 * apps are connected from Connections when a Bot needs one, and notifications are offered once the
 * first task has started (`NotifyPrompt`), when what they are for is plain.
 */
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b

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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
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
=======
function welcomeStep(computer: boolean): OnboardingStep {
  return {
    id: "welcome",
    title: `Welcome to ${PRODUCT}`,
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
                Set up your permissions
              </h2>
              <p className="text-pretty text-muted-foreground">
                {ALWAYS_ASKS} {HANDED_TO_YOU}
              </p>
            </div>
            <AskFirstSwitch />
            <div className="flex flex-col gap-1 text-sm text-pretty text-muted-foreground">
              <p>
                Bots can create, edit, and delete files in their own workspace
                without asking, unless this is on.
              </p>
              <p>You can change this setting anytime in Settings.</p>
            </div>
          </section>
        }
      >
        <p>Give work to Bots in plain words. They tell you when it's done.</p>
      </StepIntro>
    ),
    demo: () => <IntroReel computer={computer} />,
  };
}

/*
 * BOOK A DEMO IS FOR SOMEBODY TRYING OPENBOT ON THEIR OWN MACHINE, and only they see it (see
 * `localEvaluation` in RouteComponent). None of it is said to an organization's own people, who
 * already have OpenBot.
 *
 * THE CALENDAR IS THE STEP. It books a demo, or a call to scope a proof of concept, in place.
 *
 * ONE BUTTON AT A TIME. Until a call is booked the only way on is Not now: a Continue beside it read
 * as going on with the booking. Once the calendar says a call is booked there is nothing left to
 * skip, and Not now becomes Continue, in the same place. No place is kept for a second button,
 * which would lift Continue above where Not now was.
 *
 * A calendar that can't load (offline, blocked, silent) gives the step back its picture and Book a
 * call, which opens the OpenBot for Business page in a new tab (on the Desktop, in the person's
 * browser), with Not now beside it.
 */
function useBookDemoStep(): OnboardingStep {
  const [failed, setFailed] = React.useState(false);
  const [booked, setBooked] = React.useState(false);
  const fail = React.useCallback(() => setFailed(true), []);
  const book = React.useCallback(() => setBooked(true), []);
  const step: OnboardingStep = {
    id: "selfhost",
    title: "Book a demo",
    intro: () => (
      <StepIntro>
        <p>
          Thinking about {PRODUCT} for your team? Pick a time to see a demo or
          scope a proof of concept with us.
        </p>
      </StepIntro>
    ),
    demo: () =>
      failed ? (
        <SelfHostDemo />
      ) : (
        <BookingCalendar onBooked={book} onFailed={fail} />
      ),
    primaryHidden: !booked,
    secondary: booked ? undefined : { label: "Not now" },
  };
  if (!failed) return step;
  return {
    ...step,
    // A new tab, so booking doesn't cost the place in onboarding, and then on to the next step.
    primaryHidden: false,
    primaryLabel: "Book a call",
    onPrimary: (next) => {
      window.open(BUSINESS_URL, "_blank", "noopener,noreferrer");
      next();
    },
    notice: (
      <p
        className="text-sm text-center text-muted-foreground lg:text-left"
        role="status"
      >
        Couldn't load the calendar. Book a call opens it in your browser.
      </p>
    ),
  };
}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b

function RouteComponent() {
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const search = Route.useSearch();
  const complete = useMutation(completeOnboardingMutationOptions(queryClient));
  const advance = useMutation(advanceOnboardingMutationOptions(queryClient));
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
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
=======
  const me = useQuery(currentUserQueryOptions());

  /*
   * Book a demo is for somebody evaluating OpenBot locally, never for an organization's people: the
   * server says single-user mode, which an organization's deployment, always behind sign-in, cannot
   * be in. Until the answer arrives it is left out, and Welcome's button waits for it, so a slow or
   * failed request never shows an organization's employees a page about booking a call, and an
   * evaluator never walks past theirs.
   *
   * NOT GATED ON `selfHostBanner` AS WELL. That flag is off for any deployment with a paid
   * Intelligence entitlement, and the stack `copilotkit local` installs runs on an enterprise
   * evaluation licence, so every CLI evaluator, the person this step is for, would never see it.
   */
  const {
    data: capabilities,
    error: capabilitiesError,
    refetch: retryCapabilities,
    isFetching: loadingCapabilities,
    isPending: askingCapabilities,
  } = useQuery(deploymentCapabilitiesQueryOptions());
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b

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
    ...(capabilities?.localEvaluation ? (["selfhost"] as const) : []),
    ...(nameKnown ? [] : (["name"] as const)),
  ];

<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
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
=======
  /*
   * The step on screen: the address's, else the one the server saved, else the first. A step not in
   * this person's list (Book a demo for an organization's person, the name step once it is known)
   * reads as the last one they have, once the answer that decides it is in. Arriving without a step
   * writes it into the address in place, so the entry the person lands on already names its step.
   */
  const reachable = (step: StepId | null | undefined): StepId | undefined => {
    if (!step) return undefined;
    if (step === "selfhost" && !capabilities) return step;
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
    // Book a demo waits for the answer that says whether this person has one.
    if (current === "selfhost" && !capabilities) return;
    /*
     * A save that fails is tried again on the next move, since the saved step still differs. It is
     * said in the console rather than on the step: the person is where they meant to be, and only a
     * reload would show the place was not kept.
     */
    save(STEP_NUMBER[current], {
      onError: (error) =>
        console.warn("Your place in onboarding was not saved.", error),
    });
  }, [current, savedStep, save, capabilities]);

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
    const timer = setTimeout(() => navigate({ to: "/" }), reduced ? 0 : 300);
    return () => clearTimeout(timer);
  }, [leaving, navigate, reduced]);

  const name = useNameStep({ finish, finished });
  const selfhost = useBookDemoStep();
  /*
   * The checklist says whether there is a Bot computer, and the intro shows one only where there
   * is. Until it answers, the usual case: a computer that is there.
   */
  const { data: checklist } = useQuery(setupChecklistQueryOptions());
  const computerMissing =
    checklist?.rows.find((row) => row.id === "computer")?.status ===
    "needs_setup";

  const capabilitiesFailed =
    capabilitiesError && !capabilities ? (
      <div className="flex flex-col items-center gap-1 lg:items-start">
        <p
          className="text-sm text-center text-destructive lg:text-left"
          role="alert"
        >
          Couldn't load your setup. Try again to continue.
        </p>
        <Button
          disabled={loadingCapabilities}
          onClick={() => retryCapabilities()}
          size="sm"
          variant="ghost"
        >
          Try again
        </Button>
      </div>
    ) : undefined;
  const finishFailed = complete.error ? (
    <p
      className="text-sm text-center text-destructive lg:text-left"
      role="alert"
    >
      Couldn't finish setting up. Try again.
    </p>
  ) : undefined;

  const byId: Record<StepId, OnboardingStep> = {
    welcome: {
      ...welcomeStep(!computerMissing),
      primaryDisabled: !capabilities,
      notice: capabilitiesFailed,
    },
    selfhost,
    name,
  };
  /*
   * Without the name step, the last step's buttons finish onboarding where they would have moved
   * on: Get started on Welcome, and Get started (once booked), Book a call or Not now on Book a demo.
   */
  const lastId = ids[ids.length - 1];
  const steps: OnboardingStep[] = ids.map((id) => {
    const step = byId[id];
    if (id !== lastId || id === "name") return step;
    const out = () => void finish().catch(() => undefined);
    return {
      ...step,
      primaryLabel: finished ? "All set" : (step.primaryLabel ?? "Get started"),
      primaryDone: finished,
      primaryPending: complete.isPending,
      onPrimary: () => {
        step.onPrimary?.(() => undefined);
        out();
      },
      secondary: step.secondary
        ? { label: step.secondary.label, onClick: out }
        : undefined,
      notice: step.notice ?? finishFailed,
    };
  });

  // A Book a demo step in the address waits for the answer that puts it in the list, rather than
  // drawing Welcome for a moment and then jumping.
  const waiting = askingCapabilities && current === "selfhost";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b

  return (
    // Outside `_app` on purpose: no sidebar and no chrome until onboarding is done.
    // The fade runs only after the completion is saved, so a failed save never fades a page the
    // person still needs, and navigation waits for the fade, so the next screen never pops in over
    // a half-faded onboarding.
    <motion.div
      animate={{ opacity: leaving ? 0 : 1 }}
      className={`min-h-svh w-full ${leaving ? "pointer-events-none" : ""}`}
      initial={false}
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
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
=======
      transition={{ duration: reduced ? 0 : 0.3, ease: "easeOut" }}
    >
      {waiting ? null : (
        <OnboardingWizard
          onMove={(to, way) => move(to, way)}
          stepId={current}
          steps={steps}
        />
      )}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
    </motion.div>
  );
}
