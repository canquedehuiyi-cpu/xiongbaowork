import {
  type BuiltInAgentClassicConfig,
  type BuiltInAgentConfiguration,
  resolveModel,
} from "@copilotkit/runtime/v2";
import { openParts } from "@xiongbao/shared/routine-checklist";
import {
  COMMAND_TOOL,
  LAST_STEP_NOTICE,
  type MadeCall,
  openPartsNudge,
  type PlanItem,
  planNudge,
  promiseNudge,
  readPlan,
  STEP_LIMIT_EVENT,
  type StepLimitPayload,
  UPDATE_PLAN_TOOL,
  unverifiedChanges,
  verifyNudge,
} from "@xiongbao/shared/run-notices";
import { droppedConnection } from "../network-error";
import { withReplayedReasoning } from "./replayed-reasoning";
import { DEFAULT_CONTEXT_WINDOW, foldEarlyResults } from "./turn-folding";
import { unkeptPromise } from "./unkept-promise";

export { STEP_LIMIT_EVENT, type StepLimitPayload };

// Use the model contract of the runtime we actually ship, without a second AI SDK version.
type Model = Extract<
  BuiltInAgentClassicConfig["model"],
  { specificationVersion: "v3" }
>;
type CallOptions = Parameters<Model["doStream"]>[0];
/** What a model is sent on one step: the conversation, in the runtime's own model contract. */
export type Prompt = CallOptions["prompt"];
type StreamResult = Awaited<ReturnType<Model["doStream"]>>;
type Part = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;
type GenerateResult = Awaited<ReturnType<Model["doGenerate"]>>;
type Usage = GenerateResult["usage"];

/**
 * One run's state, as the model wrapper keeps it between the steps of a run. One per agent, and so
 * one per run: the runtime clones the agent before every run, and the agent resets it when a run
 * starts (`startRun`).
 */
export type RunSteps = {
  /**
   * Where this run's steps start: how many model turns the conversation already held when its
   * first step was sent. Unset until then.
   */
  before?: number;
  /** Nudges sent since the run last called a tool. See {@link MOST_NUDGES}. */
  nudges?: number;
  /** The parts of the routine this run is a firing of. Empty: not a multi-part routine. */
  parts?: readonly string[];
  /** Everything the model has said in this run, which is what closes a part. */
  said?: string;
  /**
   * The run went on past its first budget of steps, because it was still calling tools on what
   * would have been its last. See {@link answersOnLastStep}'s `extension`. A run is extended once.
   */
  extended?: boolean;
  /**
   * The step an extended run was made to answer on with its tools off, or unset while it has not
   * been. Set, the run ran out of steps, and says so (`STEP_LIMIT_EVENT` in
   * `shared/run-notices.ts`).
   */
  limited?: number;
  /**
   * What the model thought before each tool call the conversation already holds, by tool call id,
   * for a provider that wants that thinking back on every later request (期三, DeepSeek's thinking
   * mode). Each step's prompt has it put back (`withReplayedReasoning`). Empty for any other run.
   */
  reasoning?: ReadonlyMap<string, string>;
  /**
   * The steps are the whole turn's, not this run's: a turn whose tool calls the host runs between
   * runs is several runs, and each starts from the conversation the last one left. Counted from the
   * person's message instead, so the budget is spent once across them. See {@link answersOnLastStep}.
   */
  wholeTurn?: boolean;
  /** The "files changed, nothing checked" reminder was already sent in this run. It is sent once. */
  verifyNudged?: boolean;
  /** The "this card's work is not handed in" reminder was already sent in this run. It is sent once. */
  deliveryNudged?: boolean;
  /** The run's id, for the line a retried model call logs ({@link retryingDroppedConnection}). Never read for anything else. */
  runId?: string;
};

/** A new run's state: counted from where it starts, never from where an earlier run stopped. */
export function startRun(
  steps: RunSteps,
  parts: readonly string[] = [],
  reasoning: ReadonlyMap<string, string> = new Map(),
  wholeTurn = false,
) {
  steps.reasoning = reasoning;
  steps.wholeTurn = wholeTurn;
  steps.before = undefined;
  steps.nudges = 0;
  steps.parts = parts;
  steps.said = "";
  steps.extended = false;
  steps.limited = undefined;
  steps.verifyNudged = false;
  steps.deliveryNudged = false;
}

/**
 * How many times in a row a run is sent back to work before it is let go.
 *
 * Counted again from nothing whenever the run calls a tool: the shape of Claude Code's Stop hook cap
 * (consecutive continuations, reset on a tool call). It was two; DeepSeek, told once, often opens
 * the next answer with another announcement (「好的，让我先…」) and only then calls the tool, so two
 * let go runs that were about to work. Four, decided with the person who runs it (2026-11-19). A
 * model still ending on a promise after four is not going to keep it, and the run should end with
 * what it has rather than spend more.
 */
export const MOST_NUDGES = 4;

/**
 * The step budget of a run nobody is watching: a routine's firing, or a check-in.
 *
 * Interactive chat has its own (`TOOL_STEPS` in the server's copilot.ts, extended once by as many
 * again when a run is still at work on its last): a person is there to say "carry on". A routine
 * has nobody to say it. The routine that showed this needed about twenty lookups, and seven
 * tool-enabled steps made one twenty-call burst the only plan that fitted.
 *
 * `base` covers that routine even read one lookup per step, with room to answer; a model reading a
 * few at a time, as it is asked to, uses well under half. Each part of a multi-part routine is its
 * own reads and its own write, so `perPart` more steps each. `most` is the ceiling the server sets
 * as the run's `maxSteps`: a model calling tools in a circle stops there, and the turn's own timeout
 * (`TURN_LIMITS.turnTimeoutMs`) still bounds the wall clock.
 */
export const UNATTENDED_STEPS = { base: 24, perPart: 4, most: 48 } as const;

/** The step an unattended run of this many parts answers on, under the ceiling it was given. */
export function unattendedLastStep(parts: number, maxSteps: number): number {
  return Math.min(
    maxSteps,
    UNATTENDED_STEPS.base + UNATTENDED_STEPS.perPart * parts,
  );
}

function turnsIn(prompt: Prompt): number {
  return prompt.filter((message) => message.role === "assistant").length;
}

/**
 * The model turns the conversation held before the person's latest message: where a whole turn's
 * steps start, however many runs it took. A prompt with no person's message counts them all.
 */
function turnsBeforeLastUser(prompt: Prompt): number {
  const last = prompt.map((message) => message.role).lastIndexOf("user");
  return turnsIn(last < 0 ? prompt : prompt.slice(0, last));
}

/**
 * The items of this run's own plan that are not done, as its latest `update_plan` call left them.
 *
 * Read from the prompt, where each step's calls are, and only from the turns this run added: a plan
 * an earlier run left open is history the model can read, not a list this run promised to finish. A
 * call the tool turned down is no plan, so the one before it stands.
 */
function openPlanItems(prompt: Prompt, before: number): PlanItem[] {
  let turns = 0;
  let plan: PlanItem[] | undefined;
  for (const message of prompt) {
    if (message.role !== "assistant") continue;
    turns += 1;
    if (turns <= before) continue;
    for (const part of message.content)
      if (part.type === "tool-call" && part.toolName === UPDATE_PLAN_TOOL)
        plan = readPlan(part.input) ?? plan;
  }
  return (plan ?? []).filter((item) => item.status !== "done");
}

/**
 * Every call the turn has made, in order: the model turns after the first `before` of them. Read from
 * the prompt, so a turn cut into several runs by the host (it runs the tool calls itself) is read
 * whole, whichever run asks.
 */
function callsSince(prompt: Prompt, before: number): MadeCall[] {
  const calls: MadeCall[] = [];
  let turns = 0;
  for (const message of prompt) {
    if (message.role !== "assistant") continue;
    turns += 1;
    if (turns <= before || typeof message.content === "string") continue;
    for (const part of message.content)
      if (part.type === "tool-call")
        calls.push({ name: part.toolName, input: part.input });
  }
  return calls;
}

/** The tool a coworker hands a board card in with. */
const DELIVER_TOOL = "deliver_task";

/** 给模型看的：没交付就要结束时的提醒。 */
const DELIVERY_NUDGE =
  "这件活还没交付：用 deliver_task 列出交付物和自查，交付后再结束。";

/**
 * Whether a `deliver_task` call after the first `before` model turns was accepted: its result says
 * `delivered: true`. A bounced hand-in (`bounced`), a refusal (text starting `Refused.`) and text that
 * is not JSON are not.
 */
function deliveredSince(prompt: Prompt, before: number): boolean {
  let turns = 0;
  const called = new Set<string>();
  for (const message of prompt) {
    if (message.role === "assistant") {
      turns += 1;
      if (turns <= before || typeof message.content === "string") continue;
      for (const part of message.content)
        if (part.type === "tool-call" && part.toolName === DELIVER_TOOL)
          called.add(part.toolCallId);
    } else if (message.role === "tool" && typeof message.content !== "string") {
      for (const part of message.content) {
        if (part.type !== "tool-result" || !called.has(part.toolCallId))
          continue;
        try {
          const parsed: unknown = JSON.parse(
            plainResult(resultText(part.output)),
          );
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as { delivered?: unknown }).delivered === true
          )
            return true;
        } catch {
          // Not JSON: a refusal or plain text, not a hand-in.
        }
      }
    }
  }
  return false;
}

/** A one-turn message: in this call's prompt only, never in the conversation. */
function told(prompt: Prompt, text: string): Prompt {
  return [...prompt, { role: "user", content: [{ type: "text", text }] }];
}

/**
 * A Bot's run that always ends by saying something, and does not end on a promise.
 *
 * THE LAST STEP. A run with tools stops after `maxSteps` model steps, and it stopped wherever it
 * was. A Bot that searched once per step spent all eight on searches, and the run ended on the
 * eighth search's results with no answer. So the last step a run is allowed is sent with no tool to
 * choose, and since a routine that ended "I'll fetch the rest now" on exactly that step, with a
 * message that says so: tools are off, answer from what you have, then say what you did not get to
 * and why ({@link LAST_STEP_NOTICE}). Every step before it is untouched.
 *
 * AN UNKEPT PROMISE. A step that ends the run (it called no tool and the model stopped) is held back
 * before the runtime sees it. If its words promise work it did not do ({@link unkeptPromise}), a
 * routine's part is still open ({@link openParts}), or an item of the plan this run wrote with
 * `update_plan` is not done ({@link openPlanItems}), the model is asked again in the same step with
 * the answer it gave and a one-turn nudge after it, and what it does then is streamed on as the
 * rest of that step: a tool call carries the run on as usual. At most {@link MOST_NUDGES} in a row,
 * counted again from nothing after any tool call, and never on the last step, where it has no tools
 * to keep a promise with. The nudge itself is never in the conversation: the next step's prompt holds
 * what the model said and did, not what it was told.
 *
 * WHICH STEP IS LAST IS READ FROM THE PROMPT, NOT COUNTED. The AI SDK retries a failed call with the
 * same prompt, so counting calls would take a step for every retry. Each step adds one assistant turn
 * to the prompt, so the step a call is for is how many the prompt holds past where the run began. A
 * nudged step is still one assistant turn, so a nudge never uses a step up.
 *
 * ONE MORE BUDGET, ONCE, FOR A PERSON'S RUN STILL AT WORK. With `extension`, a run somebody is
 * watching is not made to answer on step `maxSteps`: that step is sent with its tools like any other.
 * A model that answers on it ends the run there, as before. One that calls a tool is still working,
 * and the run carries on for `extension` more steps, the last of which is sent without tools as
 * above. That is the only extension a run gets ({@link RunSteps.extended}). A run that reaches it
 * is marked ({@link RunSteps.limited}), and the agent says so in its stream (`STEP_LIMIT_EVENT`)
 * so the person can carry on themselves. The configuration handed back holds `maxSteps + extension`,
 * so the runtime allows the steps. A run nobody is watching is never extended: its budget is its own.
 *
 * A wrapper around the model because the runtime takes only `maxSteps` and offers no hook between
 * steps, the same reason `withToolSearch` is one. A configuration with no step limit, or a model the
 * runtime cannot resolve here, is returned as it is.
 */
export function answersOnLastStep(
  configuration: BuiltInAgentConfiguration,
  steps: RunSteps,
  run: {
    unattended?: boolean;
    extension?: number;
    /**
     * Whether the plan an answer is held to is the whole turn's (the default) or only what this run
     * added. A turn the host carries on between runs is many runs, and a plan written in an earlier
     * one is the same turn's plan. `false` is the old reading.
     */
    planAcrossRuns?: boolean;
    /**
     * Whether an answer that ends a turn which changed files, with no check run since, is sent back
     * once (the default). `false` never does.
     */
    verifyChanges?: boolean;
    /**
     * The host says this run is a board card's work, which is to be handed in with `deliver_task`. An
     * answer that would end the turn with no accepted hand-in is sent back once. Absent, never.
     */
    deliveryDue?: boolean;
    /**
     * The check commands of the skill this run follows (its fast path's own check). Running one
     * counts as having checked the changes, so a run that does what its skill says is not sent back
     * to check again. Absent, only the commands that look like a check count.
     */
    skillChecks?: readonly string[];
    /**
     * Whether a tool result ends the turn: the step that follows a step whose tool result this says
     * yes to is not asked of the model, and the run ends there with nothing more said. The host gives it
     * for a hand-in (`deliver_task` accepted): what was handed in is already in the call's arguments,
     * and the model's one more sentence only sent the whole history up again. Absent, never.
     *
     * Not at once when a reminder is due: a plan with items still open, or changes made and never
     * checked, is answered by the model once more, as it was before, so the reminder still has its
     * say. That is ONE step (it may call tools, and they run); the step after it ends the turn.
     */
    endsTurnAfter?: (toolName: string, result: string) => boolean;
  } = {},
): BuiltInAgentConfiguration {
  if ("factory" in configuration) return configuration;
  const { maxSteps } = configuration;
  if (!maxSteps || maxSteps < 2 || !configuration.tools?.length)
    return configuration;
  let model: unknown;
  try {
    model = resolveModel(configuration.model, configuration.apiKey);
  } catch {
    return configuration;
  }
  // v2 stays v2 and v3 stays v3: the runtime converts a model by its own version.
  const older = isOlderModel(model);
  if (!older && !isModel(model)) return configuration;
  const inner = model as Model;
  const extension =
    !run.unattended && run.extension && run.extension > 0
      ? Math.floor(run.extension)
      : 0;

  /** The call for this step, and whether it is the run's last. */
  const forStep = (asked: CallOptions) => {
    // Earlier turns' thinking, put back before anything reads the prompt. See `RunSteps.reasoning`.
    const options = steps.reasoning?.size
      ? {
          ...asked,
          prompt: withReplayedReasoning(asked.prompt, steps.reasoning),
        }
      : asked;
    const turns = turnsIn(options.prompt);
    steps.before ??= steps.wholeTurn
      ? turnsBeforeLastUser(options.prompt)
      : turns;
    const step = turns - steps.before + 1;
    const budget = run.unattended
      ? unattendedLastStep(steps.parts?.length ?? 0, maxSteps)
      : maxSteps;
    // Past its first budget only because it was still calling tools on that budget's last step.
    if (extension > 0 && step > budget) steps.extended = true;
    const lastStep = budget + extension;
    if (step >= lastStep && steps.extended) steps.limited = step;
    return step >= lastStep
      ? {
          last: true,
          call: {
            ...options,
            prompt: told(options.prompt, LAST_STEP_NOTICE),
            toolChoice: { type: "none" as const },
          },
        }
      : { last: false, call: options };
  };

  /**
   * The nudge an answer that would end the run has earned, or undefined when it may end. `text` is
   * already in `steps.said`, so a part this answer closes counts as closed. `prompt` is the step's
   * own, which holds every call the run made before it, its plan's among them.
   */
  const nudgeFor = (
    text: string,
    prompt: Prompt,
    tools: readonly { name: string }[] = [],
    /** Only whether one is due: nothing is counted or marked as sent. */
    dry = false,
  ): string | undefined => {
    if ((steps.nudges ?? 0) >= MOST_NUDGES) return undefined;
    const open = openParts(steps.parts ?? [], steps.said ?? "");
    const promise = unkeptPromise(text);
    const turnStart =
      run.planAcrossRuns === false
        ? (steps.before ?? 0)
        : turnsBeforeLastUser(prompt);
    const planned = openPlanItems(prompt, turnStart);
    // Only a run that holds the shell can check anything; a Bot without one is not told to.
    const unchecked =
      run.verifyChanges !== false &&
      !steps.verifyNudged &&
      tools.some((tool) => tool.name === COMMAND_TOOL)
        ? unverifiedChanges(callsSince(prompt, turnStart), run.skillChecks)
        : [];
    const undelivered =
      run.deliveryDue === true &&
      !steps.deliveryNudged &&
      tools.some((tool) => tool.name === DELIVER_TOOL) &&
      !deliveredSince(prompt, turnStart);
    const nudge = [
      ...(promise ? [promiseNudge(promise)] : []),
      ...(open.length > 0 ? [openPartsNudge(open)] : []),
      ...(planned.length > 0 ? [planNudge(planned)] : []),
      ...(unchecked.length > 0 ? [verifyNudge(unchecked)] : []),
      ...(undelivered ? [DELIVERY_NUDGE] : []),
    ].join(" ");
    if (!nudge) return undefined;
    if (dry) return nudge;
    if (unchecked.length > 0) steps.verifyNudged = true;
    if (undelivered) steps.deliveryNudged = true;
    steps.nudges = (steps.nudges ?? 0) + 1;
    return nudge;
  };

  /**
   * Whether this step is not worth asking the model, because the turn's hand-in (`run.endsTurnAfter`)
   * was accepted and the turn has had all it is owed since:
   *  - the step before this one ended with the accepted hand-in and no reminder is due: it ends;
   *  - a reminder is due: ONE step is let through (a check or a plan update, its tool calls run as
   *    usual), and the step after that ends the turn, whatever it did. A hand-in made again in that
   *    step, and accepted, ends it just the same.
   * A hand-in that was bounced is no hand-in: nothing here applies to it.
   */
  const turnEnded = (prompt: Prompt, tools: readonly { name: string }[]) => {
    if (run.endsTurnAfter === undefined) return false;
    const since = stepsSinceHandIn(prompt, run.endsTurnAfter);
    if (since === undefined) return false;
    if (since >= STEPS_AFTER_HAND_IN) return true;
    return (
      endedByResult(prompt, run.endsTurnAfter) &&
      nudgeFor("", prompt, tools, true) === undefined
    );
  };

  /** The same call asked again, with what it answered and the nudge after it. */
  const again = (call: CallOptions, text: string, nudge: string) => ({
    ...call,
    prompt: told(
      [
        ...call.prompt,
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text }],
        },
      ],
      nudge,
    ),
  });

  const doStream = async (options: CallOptions): Promise<StreamResult> => {
    const { last, call } = forStep(options);
    if (!last && turnEnded(call.prompt, call.tools ?? []))
      return { stream: endedStream(older) };
    const result = await inner.doStream(call);
    if (last) {
      return { ...result, stream: heard(result.stream) };
    }
    return { ...result, stream: heldToItsWord(result.stream, call) };
  };

  /** The last step's stream, as it is, with what it says kept for the run. */
  const heard = (stream: ReadableStream<Part>) =>
    stream.pipeThrough(
      new TransformStream<Part, Part>({
        transform(part, controller) {
          if (part.type === "text-delta")
            steps.said = `${steps.said ?? ""}${part.delta}`;
          controller.enqueue(part);
        },
      }),
    );

  /**
   * The step's stream, passed on as it arrives, with only its `finish` held until it is known whether
   * the step ends the run with work undone. If it does, the model is asked again and that ask's parts
   * follow on in the same stream, as they arrive, renamed so no text or reasoning id repeats within
   * the step. Its `stream-start` is dropped: a step starts once.
   */
  const heldToItsWord = (
    stream: ReadableStream<Part>,
    call: CallOptions,
  ): ReadableStream<Part> => {
    let reader = stream.getReader();
    let current = call;
    let asked = 0;
    let text = "";
    let called = false;
    let earlier: Usage | undefined;
    /**
     * Whether the person has already been shown words this step, which a second ask's first words
     * are set apart from by a paragraph break, so "I'll fetch the rest now." and what follows it do
     * not run together into one sentence.
     */
    let apart = false;
    const renamed = (part: Part): Part =>
      asked > 0 && "id" in part && isNamedPart(part.type)
        ? ({ ...part, id: `${part.id}-${asked}` } as Part)
        : part;
    return new ReadableStream<Part>({
      async pull(controller) {
        // Until something is passed on: a pull that enqueues nothing is not pulled again.
        for (;;) {
          const { done, value: part } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (part.type === "stream-start" && asked > 0) continue;
          if (part.type === "text-delta" && apart && part.delta) {
            apart = false;
            const delta = `

${part.delta.trimStart()}`;
            text += delta;
            controller.enqueue(renamed({ ...part, delta }));
            return;
          }
          if (part.type === "text-delta") text += part.delta;
          if (
            part.type === "tool-call" ||
            part.type === "tool-input-start" ||
            part.type === "tool-approval-request"
          )
            called = true;
          if (part.type !== "finish") {
            controller.enqueue(renamed(part));
            return;
          }
          const usage = earlier ? addUsage(earlier, part.usage) : part.usage;
          steps.said = `${steps.said ?? ""}\n${text}`;
          if (called) steps.nudges = 0;
          const nudge =
            !called && stopped(part.finishReason)
              ? nudgeFor(text, call.prompt, call.tools)
              : undefined;
          if (!nudge) {
            controller.enqueue({ ...part, usage });
            return;
          }
          const nextCall = again(current, text, nudge);
          let next: StreamResult;
          try {
            next = await inner.doStream(nextCall);
          } catch {
            // A nudge is a courtesy to the run; failing to send one must not fail the step it follows.
            controller.enqueue({ ...part, usage });
            return;
          }
          void reader.cancel().catch(() => {});
          reader = next.stream.getReader();
          current = nextCall;
          asked += 1;
          apart = text.trim().length > 0;
          text = "";
          earlier = usage;
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  };

  const doGenerate = async (options: CallOptions): Promise<GenerateResult> => {
    const { last, call } = forStep(options);
    if (!last && turnEnded(call.prompt, call.tools ?? []))
      return endedGeneration(older);
    let result = await inner.doGenerate(call);
    if (last) return result;
    let current = call;
    let seen = 0;
    for (;;) {
      const text = result.content
        .slice(seen)
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      seen = result.content.length;
      steps.said = `${steps.said ?? ""}\n${text}`;
      const called = result.content.some(
        (part) =>
          part.type === "tool-call" || part.type === "tool-approval-request",
      );
      if (called) {
        steps.nudges = 0;
        return result;
      }
      if (!stopped(result.finishReason)) return result;
      const nudge = nudgeFor(text, call.prompt, call.tools);
      if (!nudge) return result;
      current = again(current, text, nudge);
      let next: GenerateResult;
      try {
        next = await inner.doGenerate(current);
      } catch {
        return result;
      }
      result = {
        ...next,
        content: [...result.content, ...next.content],
        usage: addUsage(result.usage, next.usage),
      };
    }
  };

  /*
   * A v2 model is not rebuilt: it is put in front of, as `withFoldedCalls` does, so its version, provider
   * and the members it keeps on its prototype are still its own. Only the two calls are replaced.
   */
  const wrapped: Model = older
    ? Object.assign(Object.create(inner) as Model, { doGenerate, doStream })
    : {
        specificationVersion: "v3",
        provider: inner.provider,
        modelId: inner.modelId,
        supportedUrls: inner.supportedUrls,
        doGenerate,
        doStream,
      };
  return {
    ...configuration,
    model: wrapped,
    ...(extension > 0 ? { maxSteps: maxSteps + extension } : {}),
  };
}

/** The text a tool result carries, whichever shape the prompt holds it in. */
function resultText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || typeof output !== "object") return "";
  const { value } = output as { value?: unknown };
  if (typeof value === "string") return value;
  return value === undefined ? "" : JSON.stringify(value);
}

/**
 * Whether the step the prompt ends with was answered by a tool result the host says ends the turn:
 * the last message is the tool results of the step just run, and one of them is such a result. Only
 * that latest step counts, so a hand-in the run has gone on past does not end it later.
 */
function endedByResult(
  prompt: Prompt,
  ends: (toolName: string, result: string) => boolean,
): boolean {
  const last = prompt[prompt.length - 1];
  if (last?.role !== "tool" || typeof last.content === "string") return false;
  return last.content.some(
    (part) =>
      part.type === "tool-result" &&
      ends(part.toolName, plainResult(resultText(part.output))),
  );
}

/**
 * How many steps a turn is given after its hand-in was accepted, when a reminder was due and so the
 * turn was not ended at once: one, so the coworker can check or update its plan, and no more.
 */
const STEPS_AFTER_HAND_IN = 1;

/**
 * How many model steps the turn has taken since its first accepted hand-in (`ends` says which tool
 * result is one), or undefined when none was accepted in it. Read from the prompt after the person's
 * latest message, so a turn the host cut into several runs counts the same.
 */
function stepsSinceHandIn(
  prompt: Prompt,
  ends: (toolName: string, result: string) => boolean,
): number | undefined {
  const last = prompt.map((message) => message.role).lastIndexOf("user");
  let since: number | undefined;
  for (const message of prompt.slice(last + 1)) {
    if (message.role === "assistant" && since !== undefined) since += 1;
    else if (
      message.role === "tool" &&
      since === undefined &&
      typeof message.content !== "string" &&
      message.content.some(
        (part) =>
          part.type === "tool-result" &&
          ends(part.toolName, plainResult(resultText(part.output))),
      )
    )
      since = 0;
  }
  return since;
}

/** A result the runtime stored as a quoted string is read as the tool returned it. */
function plainResult(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"'))
    return text;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "string" ? parsed : text;
  } catch {
    return text;
  }
}

/** A step that says nothing and ends the run, in the version of the contract the model speaks. */
function endedStream(older: boolean): ReadableStream<Part> {
  const finish = older
    ? {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      }
    : {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: endedUsage(),
      };
  return new ReadableStream<Part>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] } as Part);
      controller.enqueue(finish as unknown as Part);
      controller.close();
    },
  });
}

function endedGeneration(older: boolean): GenerateResult {
  return {
    content: [],
    finishReason: older ? "stop" : { unified: "stop", raw: "stop" },
    usage: older
      ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      : endedUsage(),
    warnings: [],
  } as unknown as GenerateResult;
}

function endedUsage() {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

/** The parts whose `id` names a block of text or reasoning, which a second ask in one step reuses. */
function isNamedPart(type: string): boolean {
  return type.startsWith("text-") || type.startsWith("reasoning-");
}

function add(a: number | undefined, b: number | undefined) {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

/** Whether a step ended because the model stopped: a v3 reason is `{ unified }`, a v2 one is the word. */
function stopped(reason: unknown): boolean {
  return typeof reason === "string"
    ? reason === "stop"
    : (reason as { unified?: unknown } | undefined)?.unified === "stop";
}

/** Two asks in one step are billed as one: what the step cost is what both of them cost. */
function addUsage(a: Usage, b: Usage): Usage {
  // A v2 usage is flat numbers (`inputTokens: 12`); every field is summed.
  if (typeof (a as { inputTokens?: unknown }).inputTokens !== "object") {
    const flat = (usage: Usage) => usage as unknown as Record<string, number>;
    const summed: Record<string, number | undefined> = {};
    for (const key of new Set([
      ...Object.keys(flat(a)),
      ...Object.keys(flat(b)),
    ]))
      summed[key] = add(flat(a)[key], flat(b)[key]);
    return { ...b, ...summed } as unknown as Usage;
  }
  return {
    ...b,
    inputTokens: {
      total: add(a.inputTokens.total, b.inputTokens.total),
      noCache: add(a.inputTokens.noCache, b.inputTokens.noCache),
      cacheRead: add(a.inputTokens.cacheRead, b.inputTokens.cacheRead),
      cacheWrite: add(a.inputTokens.cacheWrite, b.inputTokens.cacheWrite),
    },
    outputTokens: {
      total: add(a.outputTokens.total, b.outputTokens.total),
      text: add(a.outputTokens.text, b.outputTokens.text),
      reasoning: add(a.outputTokens.reasoning, b.outputTokens.reasoning),
    },
  };
}

/**
 * 规格 v2 的模型：提示和流的形状和 v3 几乎一样，只有结束原因（一个词）和用量（平的数字）不同。折叠只改提示，
 * 最后一步的收尾和提醒也读这两处，都按各自的版本读，v2 保持 v2。
 */
function isOlderModel(model: unknown): boolean {
  return (
    typeof model === "object" &&
    model !== null &&
    (model as { specificationVersion?: unknown }).specificationVersion === "v2"
  );
}

function isModel(model: unknown): model is Model {
  return (
    typeof model === "object" &&
    model !== null &&
    (model as { specificationVersion?: unknown }).specificationVersion === "v3"
  );
}

export type FoldingOptions = {
  /**
   * 这个模型的窗口（token）。读不到（返回空，或者抛错）就用 {@link DEFAULT_CONTEXT_WINDOW}。每个模型只问一次。
   */
  windowFor?: (
    provider: string,
    modelId: string,
  ) => number | undefined | Promise<number | undefined>;
  /** 绝对预算（token）：估算超过它就折叠，不管窗口多大。不写用 `FOLD_BUDGET_TOKENS`，0 关掉。 */
  budget?: number;
};

/**
 * 规格 v2 的模型：不重新拼一个对象，而是接在它前面。规格、提供方、模型名和它自己的其它成员（`provider` 是原型上的
 * 取值函数）都从它那里读，只有这两个调用先折叠再交给它；换成 v3 的壳，运行时就不会再把它当 v2 转换，流的格式对不上。
 * 两个调用用赋值挂上（可写、可配置）：运行时把 v2 模型转成 v3 时会再套一层代理，不可配置的属性它取不出来。
 */
function withFoldedCalls(
  inner: Model,
  folded: (asked: CallOptions) => Promise<CallOptions>,
): Model {
  const wrapper = Object.create(inner) as Model;
  wrapper.doGenerate = async (asked) => inner.doGenerate(await folded(asked));
  wrapper.doStream = async (asked) => inner.doStream(await folded(asked));
  return wrapper;
}

/**
 * 每一步发给模型之前，先按 {@link foldEarlyResults} 折叠较早的工具结果。包在模型外面，是因为运行时只给
 * `maxSteps`，两步之间没有别的位置可以改这一步的提示，`answersOnLastStep` 也是这样做的；放在它外面，让它看到的
 * 已经是折叠后的提示（折叠不改回合数，它按回合数数步）。v2、v3 规格的模型都折（见 {@link isOlderModel}）；工厂式配置、解析不了的、别的规格的模型原样返回。
 */
export function foldingEarlyResults(
  configuration: BuiltInAgentConfiguration,
  options: FoldingOptions = {},
): BuiltInAgentConfiguration {
  if ("factory" in configuration) return configuration;
  let model: unknown;
  try {
    model = resolveModel(configuration.model, configuration.apiKey);
  } catch {
    return configuration;
  }
  const older = isOlderModel(model);
  if (!older && !isModel(model)) return configuration;
  const inner = model as Model;
  let window: Promise<number> | undefined;
  const windowOf = () => {
    window ??= (async () => {
      try {
        const known = await options.windowFor?.(inner.provider, inner.modelId);
        return known && known > 0 ? known : DEFAULT_CONTEXT_WINDOW;
      } catch {
        return DEFAULT_CONTEXT_WINDOW;
      }
    })();
    return window;
  };
  const folded = async (asked: CallOptions): Promise<CallOptions> => {
    const prompt = foldEarlyResults(asked.prompt, {
      window: await windowOf(),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    });
    return prompt === asked.prompt ? asked : { ...asked, prompt };
  };
  const wrapped: Model = older
    ? withFoldedCalls(inner, folded)
    : {
        specificationVersion: "v3",
        provider: inner.provider,
        modelId: inner.modelId,
        supportedUrls: inner.supportedUrls,
        doGenerate: async (asked) => inner.doGenerate(await folded(asked)),
        doStream: async (asked) => inner.doStream(await folded(asked)),
      };
  return { ...configuration, model: wrapped };
}

/**
 * 每一步发给模型之前，把对话里记下的思考放回 assistant 消息（`withReplayedReasoning`，见 `RunSteps.reasoning`）。
 *
 * 单独成一层，不依赖员工有没有自己授予的工具：`answersOnLastStep` 在没有工具、也没有步数上限时直接原样返回，
 * 放在它里面的回放就跟着没了（服务器执行单聊时工具全靠 `input.tools`，续跑只剩空的 `reasoning_content`）。
 * 已经带着思考的消息不动，所以和 `answersOnLastStep` 里那一次叠在一起也没有副作用。没记下思考的运行原样透传。
 * 工厂式配置、解析不了的、别的规格的模型原样返回。
 */
export function replayingReasoning(
  configuration: BuiltInAgentConfiguration,
  steps: RunSteps,
): BuiltInAgentConfiguration {
  if ("factory" in configuration) return configuration;
  let model: unknown;
  try {
    model = resolveModel(configuration.model, configuration.apiKey);
  } catch {
    return configuration;
  }
  const older = isOlderModel(model);
  if (!older && !isModel(model)) return configuration;
  const inner = model as Model;
  const replayed = async (asked: CallOptions): Promise<CallOptions> => {
    if (!steps.reasoning?.size) return asked;
    const prompt = withReplayedReasoning(asked.prompt, steps.reasoning);
    return prompt === asked.prompt ? asked : { ...asked, prompt };
  };
  const wrapped: Model = older
    ? withFoldedCalls(inner, replayed)
    : {
        specificationVersion: "v3",
        provider: inner.provider,
        modelId: inner.modelId,
        supportedUrls: inner.supportedUrls,
        doGenerate: async (asked) => inner.doGenerate(await replayed(asked)),
        doStream: async (asked) => inner.doStream(await replayed(asked)),
      };
  return { ...configuration, model: wrapped };
}

/** How long a model call waits before it is made again after a dropped connection: one to two seconds. */
const NET_RETRY_DELAY_MS = { base: 1000, jitter: 1000 } as const;

export type NetRetryOptions = {
  /** Where the run's id is read for the log line. */
  steps?: RunSteps;
  /** Waits before the second try. Tests give a quick one. */
  sleep?: (milliseconds: number) => Promise<unknown>;
  /** One JSON line, no content. Absent, the server's log. */
  log?: (line: string) => void;
  /**
   * Nobody is watching the run (a board card's turn, a routine): its thinking parts are held back
   * until the stream says its first word or calls its first tool, so a connection that drops while
   * the model is only thinking is also made again. A person's chat leaves this off: the thinking is
   * shown as it comes, and only a stream that has said nothing at all is made again.
   */
  holdThinking?: boolean;
};

/** The parts a stream sends before it says anything: holding them back costs nothing, and lets a retry start clean. */
const PREAMBLE_PARTS = new Set(["stream-start", "response-metadata", "raw"]);

/** The parts that carry the model's thinking (`reasoning-start`, `reasoning-delta`, `reasoning-end`). */
const isThinkingPart = (type: string): boolean => type.startsWith("reasoning-");

/**
 * ONE MORE TRY FOR A MODEL CALL WHOSE CONNECTION DROPPED. The model call of one step is made again,
 * once, when it throws, or when its stream fails BEFORE it has sent anything (no text, thinking or
 * tool-call part of any kind), and the failure is a dropped connection (`droppedConnection`:
 * ECONNRESET, "the socket connection was closed unexpectedly", and the like). It waits one to two
 * seconds first.
 *
 * Seen in an evaluation: three runs ended on `ECONNRESET` between two tool calls, and the work was
 * carried on by later runs that spent steps getting back to where it was. The AI SDK does not
 * make such a call again by itself unless the provider wrapped the failure as a retryable API error;
 * a stream cut after its headers, or a plain error out of `doStream`, goes straight up.
 *
 * A run nobody is watching (`holdThinking`) also gets its second try when the stream had sent only
 * thinking before it dropped: the thinking is held until the first text or tool-call part, thrown
 * away on a retry, and the log line says `afterReasoning: true`.
 *
 * NEVER AFTER ANYTHING WAS SAID. A stream that sent a part of the answer and then dropped is given
 * up as it is: making the call again would say it twice, or call a tool twice. An answer from the
 * provider (an HTTP status: 401, 402, 429, 5xx) is not a dropped connection and is left to the
 * SDK's own retries, which are unchanged; a run somebody stopped (its abort signal) is never made
 * again.
 *
 * Inside the other wrappers (the last-step one and the folding one), around the model as the runtime
 * resolved it, so every step of every kind of run is covered and each is retried on its own. A
 * configuration with a factory, or a model the runtime cannot resolve here, is returned as it is.
 * Deployment switch `XIONGBAO_MODEL_NET_RETRY=off` (the agent reads it).
 */
export function retryingDroppedConnection(
  configuration: BuiltInAgentConfiguration,
  options: NetRetryOptions = {},
): BuiltInAgentConfiguration {
  if ("factory" in configuration) return configuration;
  let model: unknown;
  try {
    model = resolveModel(configuration.model, configuration.apiKey);
  } catch {
    return configuration;
  }
  const older = isOlderModel(model);
  if (!older && !isModel(model)) return configuration;
  const inner = model as Model;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const log = options.log ?? ((line: string) => console.info(line));

  const codeOf = (error: unknown): string => {
    for (let depth = 0, value = error; depth < 5 && value; depth++) {
      if (typeof value !== "object") break;
      const code = (value as { code?: unknown }).code;
      if (typeof code === "string") return code;
      value = (value as { cause?: unknown }).cause;
    }
    return "network";
  };
  const report = (
    error: unknown,
    asked: CallOptions,
    recovered: boolean,
    afterReasoning = false,
  ): void => {
    try {
      log(
        JSON.stringify({
          type: "model-net-retry",
          ...(options.steps?.runId ? { runId: options.steps.runId } : {}),
          code: codeOf(error),
          step: turnsIn(asked.prompt) + 1,
          recovered,
          afterReasoning,
        }),
      );
    } catch {
      // A log line that cannot be written is not a reason to fail the step.
    }
  };
  /** Whether this failure is made up for by one more try, and the wait for it has passed. */
  const worthAnotherTry = async (
    error: unknown,
    asked: CallOptions,
  ): Promise<boolean> => {
    if (asked.abortSignal?.aborted || !droppedConnection(error)) return false;
    await sleep(
      NET_RETRY_DELAY_MS.base + Math.random() * NET_RETRY_DELAY_MS.jitter,
    );
    return !asked.abortSignal?.aborted;
  };

  const doGenerate = async (asked: CallOptions): Promise<GenerateResult> => {
    try {
      return await inner.doGenerate(asked);
    } catch (error) {
      if (!(await worthAnotherTry(error, asked))) throw error;
      try {
        const result = await inner.doGenerate(asked);
        report(error, asked, true);
        return result;
      } catch (second) {
        report(error, asked, false);
        throw second;
      }
    }
  };

  const doStream = async (asked: CallOptions): Promise<StreamResult> => {
    let result: StreamResult;
    let tried: { error: unknown; afterReasoning: boolean } | undefined;
    try {
      result = await inner.doStream(asked);
    } catch (error) {
      if (!(await worthAnotherTry(error, asked))) throw error;
      tried = { error, afterReasoning: false };
      try {
        result = await inner.doStream(asked);
      } catch (second) {
        report(error, asked, false, false);
        throw second;
      }
    }
    let reader = result.stream.getReader();
    // Parts held until the stream has said something, and what happens once it has.
    let held: Part[] = [];
    let flowing = false;
    let failure: { error: unknown } | undefined;
    let ended = false;
    let reported = false;
    /** The stream has said all it will say first: what is held goes out, and a retry's outcome is logged. */
    const flow = () => {
      flowing = true;
      if (tried && !reported) {
        reported = true;
        report(
          tried.error,
          asked,
          !failure && !held.some((part) => part.type === "error"),
          tried.afterReasoning,
        );
      }
    };

    /** The first try failed before saying anything: ask again, once, and carry on from the new stream. */
    const startOver = async (error: unknown): Promise<boolean> => {
      if (tried || !(await worthAnotherTry(error, asked))) return false;
      tried = {
        error,
        afterReasoning: held.some((part) => isThinkingPart(part.type)),
      };
      reader.cancel().catch(() => {});
      try {
        const next = await inner.doStream(asked);
        reader = next.stream.getReader();
        held = [];
      } catch (second) {
        held = [];
        failure = { error: second };
        flow();
      }
      return true;
    };

    const stream = new ReadableStream<Part>({
      async pull(controller) {
        for (;;) {
          if (flowing && held.length > 0) {
            controller.enqueue(held.shift() as Part);
            return;
          }
          if (flowing && failure) {
            controller.error(failure.error);
            return;
          }
          if (flowing && ended) {
            controller.close();
            return;
          }
          let step: Awaited<ReturnType<typeof reader.read>>;
          try {
            step = await reader.read();
          } catch (error) {
            if (!flowing && (await startOver(error))) continue;
            failure = { error };
            flow();
            continue;
          }
          if (step.done) {
            ended = true;
            flow();
            continue;
          }
          const part = step.value;
          if (
            !flowing &&
            part.type === "error" &&
            (await startOver(part.error))
          )
            continue;
          held.push(part);
          if (
            !flowing &&
            !PREAMBLE_PARTS.has(part.type) &&
            part.type !== "error" &&
            !(options.holdThinking && isThinkingPart(part.type))
          )
            flow();
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return { ...result, stream };
  };

  // A v2 model is put in front of, not rebuilt, as `answersOnLastStep` does.
  const wrapped: Model = older
    ? Object.assign(Object.create(inner) as Model, { doGenerate, doStream })
    : {
        specificationVersion: "v3",
        provider: inner.provider,
        modelId: inner.modelId,
        supportedUrls: inner.supportedUrls,
        doGenerate,
        doStream,
      };
  return { ...configuration, model: wrapped };
}
