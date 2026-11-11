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
import { BUSINESS_URL } from "@/lib/openbot-for-business";
import { setupChecklistQueryOptions } from "@/lib/setup/queries";
import { queryClient } from "@/query-client";

const PRODUCT = appConfig.brand.productName;

/**
 * Every step, by id, with the number the server stores for it.
 *
 * `POST /api/me/onboarding` keeps a step as an integer, so each id has a number of its own. A
<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
 * number per id, never a position in the list: the name step leaves the list for somebody whose
 * name is known, so a position would mean different steps to different people. 0 is the server's
 * "not started".
=======
 * number per id, never a position in the list: OpenBot for Business joins the list only for somebody trying
 * OpenBot alone, and the name step leaves it for somebody whose name is known, so a position would
 * mean different steps to different people. 0 is the server's "not started".
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d
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
<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
 * THREE CLICKS AT MOST INTO THE APP, plus this deployment's own step. Welcome, then where the
 * person's 分身 finds their material (story F1, skippable), then the name. Upstream's Book a demo
 * step (a CopilotKit sales calendar for somebody trying OpenBot alone) is left out. Everything else
 * waits for the app: apps are connected when a Bot needs one, and notifications are offered once
 * the first task has started (`NotifyPrompt`), when what they are for is plain.
=======
 * THREE CLICKS AT MOST INTO THE APP. Welcome, then OpenBot for Business for somebody trying OpenBot alone,
 * then the name. Everything else waits for the app: the setup checklist lives in Settings → Setup,
 * apps are connected from Connections when a Bot needs one, and notifications are offered once the
 * first task has started (`NotifyPrompt`), when what they are for is plain.
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d
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

<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
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
=======
/*
 * OPENBOT FOR BUSINESS IS FOR SOMEBODY TRYING OPENBOT ON THEIR OWN MACHINE, and only they see it (see
 * `localEvaluation` in RouteComponent). None of it is said to an organization's own people, who
 * already have OpenBot.
 *
 * WHAT IT IS COMES BEFORE ASKING FOR A CALL. The step opens on what OpenBot for Business adds, beside
 * the picture of running OpenBot yourself (on this computer, with the agents you already have, for
 * your organization), with Book a demo and Not now. Somebody who has never heard of it has no reason
 * to book anything until they know what they would be booking.
 *
 * BOOK A DEMO OPENS THE CALENDAR IN THE STEP, in the picture's place, to book a demo or a call to
 * scope a proof of concept. Until a call is booked the only way on is Not now: a Continue beside it
 * read as going on with the booking. Once the calendar says a call is booked, Not now becomes
 * Continue, in the same place.
 *
 * A calendar that can't load (offline, blocked, silent) puts the picture back, with Book a call, which
 * opens the OpenBot for Business page in a new tab (on the Desktop, in the person's browser).
 */
function useBookDemoStep(): OnboardingStep {
  const [calendar, setCalendar] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [booked, setBooked] = React.useState(false);
  const fail = React.useCallback(() => setFailed(true), []);
  const book = React.useCallback(() => setBooked(true), []);
  const value: OnboardingStep = {
    id: "selfhost",
    title: "OpenBot for Business",
    intro: () => (
      <StepIntro>
        <p>
          Bring {PRODUCT} to your whole team, on your own servers. Everyone
          signs in with their work account and shares Bots in Slack and
          Microsoft Teams. Admins get the controls and audit trail your company
          needs.
        </p>
      </StepIntro>
    ),
    demo: () => <SelfHostDemo />,
    primaryLabel: "Book a demo",
    onPrimary: () => setCalendar(true),
    secondary: { label: "Not now" },
  };
  if (!calendar) return value;
  if (failed) {
    return {
      ...value,
      // A new tab, so booking doesn't cost the place in onboarding, and then on to the next step.
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
  return {
    ...value,
    intro: () => (
      <StepIntro>
        <p>Pick a time to see a demo or scope a proof of concept with us.</p>
      </StepIntro>
    ),
    demo: () => <BookingCalendar onBooked={book} onFailed={fail} />,
    primaryLabel: undefined,
    onPrimary: undefined,
    primaryHidden: !booked,
    secondary: booked ? undefined : { label: "Not now" },
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d
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
<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
=======
   * OpenBot for Business is for somebody evaluating OpenBot locally, never for an organization's people: the
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

  /*
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d
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
<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
   * this person's list (the name step once it is known) reads as the last one they have. Arriving
   * without a step writes it into the address in place, so the entry the person lands on already
   * names its step.
=======
   * this person's list (OpenBot for Business for an organization's person, the name step once it is known)
   * reads as the last one they have, once the answer that decides it is in. Arriving without a step
   * writes it into the address in place, so the entry the person lands on already names its step.
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d
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
<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
=======
    // OpenBot for Business waits for the answer that says whether this person has one.
    if (current === "selfhost" && !capabilities) return;
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d
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
   * Where the fade lands. The model guide's way out goes to 能力与资源's model library tab, which the
   * person can only reach once onboarding is finished.
   */
  const [destination, setDestination] = React.useState<"/" | "/resources">("/");
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
        destination === "/resources"
          ? navigate({ to: "/resources", search: { tab: "models" } })
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
        connecting={complete.isPending && destination === "/resources"}
        onConnect={() => {
          // Finishing comes first: every screen behind it sends somebody unfinished straight back.
          setDestination("/resources");
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
<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
   * on: Get started on the last step left. The sources step finishes from its own buttons.
=======
   * on: Get started on Welcome, and Book a demo, Continue (once booked), Book a call or Not now on
   * OpenBot for Business.
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d
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
      // A step's own primary decides whether it moves on: Book a call does, so it finishes;
      // Book a demo opens the calendar in the step and stays.
      onPrimary: step.onPrimary ? () => step.onPrimary?.(out) : out,
      secondary: step.secondary
        ? { label: step.secondary.label, onClick: out }
        : undefined,
      notice: step.notice ?? finishFailed,
    };
  });

<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
=======
  // An OpenBot for Business step in the address waits for the answer that puts it in the list, rather than
  // drawing Welcome for a moment and then jumping.
  const waiting = askingCapabilities && current === "selfhost";

>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d
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
