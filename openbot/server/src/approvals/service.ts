import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ALREADY_WAITING,
  DECLINED_BY_PERSON,
  HANDLED_BY_PERSON,
  NOT_DONE,
  notDoneOnRecheck,
  OUTCOME_UNKNOWN,
  WITHDRAWN_APPROVALS_OFF,
  WITHDRAWN_RULE_ALLOWS,
} from "@openbot/shared/approval-outcomes";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { PERSON_INITIATOR } from "../audit";
import { currentTenant } from "../tenant/context";
import { desktopFloor } from "./desktop-policy";
import {
  ApprovalFreshError,
  createApprovalFreshCoordinator,
} from "./fresh-producer";
import {
  applicableRules,
  DEFAULT_SENSITIVE_PATHS,
  decideAction,
  effectiveHostCommandPolicy,
  type ReviewModel,
  refusedOutright,
  ruleMatches,
  toolDisabled,
} from "./policy";
import type { ApprovalQuestions } from "./questions";
import {
  type ApprovalAction,
  ApprovalAlreadyAnsweredError,
  type ApprovalCandidate,
  type ApprovalContinuation,
  type ApprovalDecision,
  type ApprovalFreshProducerPort,
  ApprovalNotFoundError,
  type ApprovalPermit,
  type ApprovalPolicyOutcome,
  type ApprovalPreferences,
  type ApprovalRecord,
  type ApprovalRecoveryContext,
  type ApprovalRecoveryOutcome,
  type ApprovalRecoveryPort,
  ApprovalRefusedError,
  type ApprovalRule,
  type ApprovalRuleInput,
  type ApprovalStore,
  type ApprovalTeamSettings,
  approvalAction,
  approvalArgsPreview,
  approvalPreview,
  currentApprovalContext,
  EMPLOYEE_TOOL_BEHAVIOUR,
  type EmployeeSecuritySettings,
  type EmployeeToolMode,
  type HostCommandPolicy,
  parseApprovalContinuation,
  validateApprovalRecoveryContext,
  withApprovalContext,
} from "./types";

// The sentences a Bot is told about a step it did not carry out live with their person-facing
// versions (shared/approval-outcomes.ts), so the app translates exactly what is sent here.
export {
  ALREADY_WAITING,
  DECLINED_BY_PERSON,
  HANDLED_BY_PERSON,
  OUTCOME_UNKNOWN,
  WITHDRAWN_APPROVALS_OFF,
  WITHDRAWN_RULE_ALLOWS,
};
/** Why a change in a check-in task waits for the person, on its card where they decide it. */
export const TASK_ASKS =
  "Tasks started from a check-in ask before every change.";

/** Snapshot ids and element refs change on every page read; the action they point at does not. */
const VOLATILE = new Set(["snapshotId", "ref", "toolCallId", "signal"]);
function stable(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((entry) => stable(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE.has(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stable(entry, depth + 1)]),
  );
}
export function equivalenceOf(candidate: ApprovalCandidate): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        candidate.actorId,
        candidate.botId,
        candidate.toolRef,
        candidate.effect,
        candidate.scope,
        // Both: a connector, host or hand-off target names the tool, not the call, so the target
        // alone made every later call to that tool "the same" as one the person declined.
        stable(candidate.target),
        stable(candidate.args),
        // 哪个邮箱：拒绝了从一个账号发出的邮件，不代表另一个账号也被拒绝。
        ...(candidate.account ? [candidate.account] : []),
      ]),
    )
    .digest("hex");
}
const userTurnsOf = (continuation: ApprovalContinuation | undefined) =>
  (continuation?.messages ?? []).filter((message) => message.role === "user")
    .length;

/**
 * What the Bot is told when an approved action was started and the process running it stopped
 * before its result was saved (结果不明). It is never run a second time. The sentence itself now
 * lives with its person-facing version in shared/approval-outcomes.ts.
 */
export const APPROVAL_OUTCOME_UNKNOWN = OUTCOME_UNKNOWN;
const executionAuthority = new AsyncLocalStorage<{
  approvalId: string;
  digest: string;
  owner: string;
}>();
const validationProbe = new AsyncLocalStorage<{ action?: ApprovalAction }>();
/**
 * Whether this call is an approved action's re-check, which only asks the gate what it would decide.
 * Anything with a side effect of its own (spending a one-time consent) must wait for the real run.
 */
export const isApprovalRecheck = () => validationProbe.getStore() !== undefined;
class ApprovalValidated extends HeadlessToolSuspension {
  constructor() {
    super("The action was checked before execution.", {
      kind: "approval_validation",
    });
  }
}
export type ApprovalResumeDependencies = {
  /**
   * Whether the deployment still lets this Bot run for this person (Use Bots, the model allowlist).
   * Asked before anything else, so a refused action is never carried out, and final: the Bot cannot
   * answer the result either, so the request ends with the refusal saved and no continuation.
   */
  refusal?(action: ApprovalAction): Promise<string | null>;
  /** Resolve the target again and recheck current policy/grants; never trust approval as authority. */
  validate(action: ApprovalAction): Promise<ApprovalAction>;
  execute(action: ApprovalAction): Promise<unknown>;
  /** Persist this deterministic tool result and resume its canonical conversation. */
  continue(input: {
    approvalId: string;
    messageId: string;
    continuation: ApprovalContinuation;
    result: { content: string; error?: string };
  }): Promise<void>;
};
export class ApprovalRecoveryBlockedError extends Error {
  constructor() {
    super("approval_recovery_blocked");
    this.name = "ApprovalRecoveryBlockedError";
  }
}
export class ApprovalRecoveryUnknownError extends Error {
  constructor() {
    super("approval_recovery_unknown");
    this.name = "ApprovalRecoveryUnknownError";
  }
}
export class ApprovalRecoveryBusyError extends Error {
  constructor() {
    super("approval_recovery_busy");
    this.name = "ApprovalRecoveryBusyError";
  }
}
export type ApprovalService = ReturnType<typeof createApprovalService>;

export function createApprovalService(
  store: ApprovalStore,
  questions?: ApprovalQuestions,
  frontend?: (
    ownerUserId: string,
    botId: string,
    snapshot: ApprovalContinuation,
  ) => Promise<unknown>,
  options: {
    /** The deployment's configured model, for auto-review and pre-approval checks. */
    review?: ReviewModel;
    continuationRecovery?: ApprovalRecoveryPort;
    freshProducer?: ApprovalFreshProducerPort;
    /**
     * `database`: the server settles an approved action itself, on the approval row, when neither
     * Root-attested port above is supplied. Internal composition only (index.ts); no request or
     * configuration value maps to it, and with either port present that port's path is used instead.
     *
     * The row is the fence. `consume` claims the run (approved → consumed, result still SQL NULL,
     * under a row lock), so at most one process ever carries the action out; `saveResult` is a
     * compare-and-set on the NULL result, so exactly one answer is kept and only the process that
     * saved it continues the conversation; `finish` comes last. A row found consumed with no result
     * is never run again: it is answered "outcome unknown".
     */
    settlement?: "database";
  } = {},
) {
  const fresh = options.freshProducer
    ? createApprovalFreshCoordinator(store, options.freshProducer)
    : undefined;
  // Decided once, here: a resume never reads an option, so a blocked retry touches nothing.
  const databaseSettled =
    options.settlement === "database" &&
    !fresh &&
    !options.continuationRecovery;
  /**
   * The row this frame reads must be the owner's own, stamped with the frame's tenant, and bound to
   * the run and call it was opened for (G01). Anything else is never run and never answered.
   */
  async function assertDatabaseBinding(request: ApprovalRecord, owner: string) {
    if (!store.getRecoveryContext) throw new ApprovalRecoveryBlockedError();
    try {
      const context = await store.getRecoveryContext(owner, request.id);
      validateApprovalRecoveryContext(
        context,
        owner,
        request.id,
        currentTenant(),
      );
      if (!isDeepStrictEqual(context.request.action, request.action))
        throw new ApprovalRecoveryBlockedError();
    } catch (error) {
      if (error instanceof ApprovalNotFoundError) throw error;
      throw new ApprovalRecoveryBlockedError();
    }
  }
  /** The saved answer goes back to the conversation that asked, then the request is closed. */
  async function publishDatabase(
    request: ApprovalRecord,
    owner: string,
    result: NonNullable<ApprovalRecord["result"]>,
    dependencies: Pick<ApprovalResumeDependencies, "continue" | "refusal">,
  ) {
    // A Bot the deployment no longer lets run is not continued, even with an answer saved earlier.
    const refused = dependencies.refusal
      ? await dependencies.refusal(request.action)
      : null;
    const continuation = request.action.continuation;
    if (!refused && continuation)
      await dependencies.continue({
        approvalId: request.id,
        messageId: `approval:${request.id}`,
        continuation,
        result,
      });
    await store.finish(owner, request.id);
  }
  async function freshOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApprovalFreshError && error.kind === "blocked")
        throw new ApprovalRecoveryBlockedError();
      throw new ApprovalRecoveryUnknownError();
    }
  }
  async function recoverSaved(
    request: ApprovalRecord,
    owner: string,
    mode: "resume" | "abandon",
  ): Promise<void> {
    if (
      !options.continuationRecovery ||
      !store.getRecoveryContext ||
      !request.result
    )
      throw new ApprovalRecoveryBlockedError();
    let context: ApprovalRecoveryContext;
    try {
      context = await store.getRecoveryContext(owner, request.id);
      validateApprovalRecoveryContext(
        context,
        owner,
        request.id,
        currentTenant(),
      );
      if (
        !context.request.result ||
        !isDeepStrictEqual(context.request.result, request.result)
      )
        throw new ApprovalRecoveryBlockedError();
    } catch (error) {
      if (error instanceof ApprovalNotFoundError) throw error;
      throw new ApprovalRecoveryBlockedError();
    }
    let outcome: ApprovalRecoveryOutcome;
    try {
      outcome = await options.continuationRecovery.recover({
        context,
        mode,
        result: context.request.result,
      });
    } catch {
      throw new ApprovalRecoveryUnknownError();
    }
    if (outcome.kind === "busy") throw new ApprovalRecoveryBusyError();
    if (outcome.kind === "blocked") throw new ApprovalRecoveryBlockedError();
    if (outcome.kind !== "completed") throw new ApprovalRecoveryUnknownError();
    // The trusted protocol port committed receipt + approval.finish atomically.
    // Never call ordinary store.finish a second time here.
  }
  /**
   * A personal "allow" rule closes the requests it now covers that were only waiting on the person's
   * default or their own rules. Safety hand-offs, team rules and auto-review stops are left alone.
   */
  async function withdrawAllowed(ownerUserId: string, rule: ApprovalRule) {
    if (rule.behaviour !== "allow" || !store.policy) return;
    await store.policy.withdrawPending(
      ownerUserId,
      WITHDRAWN_RULE_ALLOWS,
      (action) =>
        (!action.policy ||
          action.policy.source === "default" ||
          action.policy.source === "personal_rule") &&
        ruleMatches(rule, action),
    );
  }
  /** Safety, rules, auto-review and the person's default, settled once per action and audited. */
  async function evaluate(
    candidate: ApprovalCandidate,
  ): Promise<ApprovalPolicyOutcome | undefined> {
    const policy = store.policy;
    if (!policy) return undefined;
    /*
     * The Bot owner's side is read in the owner's frame whoever acts (SEC1 D9). A failure to read it
     * is not "no owner rules": it throws, and the action is not carried out (fail closed).
     */
    const [preferences, team, teamRules, personal, employee] =
      await Promise.all([
        policy.preferences(candidate.actorId),
        policy.teamSettings(),
        policy.teamRules(),
        store.rules(candidate.actorId),
        policy.employee?.(candidate.botId),
      ]);
    const continuation = candidate.continuation ?? currentApprovalContext();
    const outcome = await decideAction({
      candidate,
      messages: continuation?.messages,
      team: teamRules,
      personal,
      // The owner's own rules are already their personal rules when the owner is the one acting.
      ...(employee?.ownerUserId && employee.ownerUserId !== candidate.actorId
        ? { owner: employee.rules }
        : {}),
      customRulesEnabled: team.customRulesEnabled,
      autoReview: preferences.autoReview || team.enforceAutoReview,
      askBeforeChanges: preferences.enabled,
      ...(options.review ? { model: options.review } : {}),
      ...(employee ? { security: employee.security } : {}),
      enforceDangerousCommands: team.enforceDangerousCommands,
      hostCommandsCap: team.hostCommandsCap,
    });
    // An unremarkable read is not a verdict anybody asked for; everything else is on the trail.
    if (
      outcome.review ||
      outcome.behaviour !== "allow" ||
      outcome.source !== "default"
    )
      await policy.recordDecision({
        ownerUserId: candidate.actorId,
        botId: candidate.botId,
        toolRef: candidate.toolRef,
        effect: candidate.effect,
        scope: candidate.scope,
        outcome,
        target: candidate.target,
        ...(continuation?.initiator
          ? { initiator: continuation.initiator }
          : {}),
      });
    return outcome;
  }
  return {
    store,
    async frontendAction(ownerUserId: string, botId: string, input: unknown) {
      if (!frontend)
        throw new ApprovalRefusedError(
          "Computer approvals are unavailable in this deployment.",
        );
      const snapshot = parseApprovalContinuation(input);
      snapshot.initiator = PERSON_INITIATOR;
      if (!snapshot.toolName.startsWith("computer_"))
        throw new ApprovalRefusedError(
          "That tool cannot be called through this computer request.",
        );
      const call = snapshot.messages
        .flatMap((message) =>
          message.role === "assistant" ? (message.toolCalls ?? []) : [],
        )
        .find((call) => call.id === snapshot.toolCallId);
      if (
        !call ||
        call.function.name !== snapshot.toolName ||
        !isDeepStrictEqual(
          JSON.parse(call.function.arguments),
          snapshot.args,
        ) ||
        snapshot.messages.some(
          (message) =>
            message.role === "tool" && message.toolCallId === call.id,
        )
      )
        throw new ApprovalRefusedError(
          "The action does not match an unanswered tool call in this conversation.",
        );
      return withApprovalContext(snapshot, () =>
        frontend(ownerUserId, botId, snapshot),
      );
    },
    async validateReentry(
      action: ApprovalAction,
      execute: () => Promise<unknown>,
    ): Promise<ApprovalAction> {
      const continuation = parseApprovalContinuation(action.continuation);
      const probe: { action?: ApprovalAction } = {};
      try {
        await withApprovalContext(continuation, () =>
          validationProbe.run(probe, execute),
        );
      } catch (error) {
        if (!(error instanceof ApprovalValidated)) throw error;
      }
      if (!probe.action)
        throw new ApprovalRefusedError(
          "That action is no longer available for approval.",
        );
      return probe.action;
    },
    async gate(
      candidate: ApprovalCandidate,
    ): Promise<ApprovalPermit | undefined> {
      const probe = validationProbe.getStore();
      if (probe) {
        probe.action = approvalAction(candidate);
        throw new ApprovalValidated();
      }
      // The approved action itself, being executed by `resume`. Decided already; never re-asked.
      const authority = executionAuthority.getStore();
      if (authority) {
        const approved = approvalAction(candidate);
        if (
          authority.owner === approved.actorId &&
          authority.digest === approved.actionDigest
        )
          return;
      }
      /*
       * The person's own earlier answer in this conversation comes first, before any policy that
       * might now allow the action: a declined action and its equivalents are not tried again until
       * the person has spoken since, and an action already waiting is not asked about twice.
       */
      const policy = store.policy;
      const continuation = candidate.continuation ?? currentApprovalContext();
      /*
       * A TASK STARTED FROM A CHECK-IN ASKS BEFORE EVERYTHING BUT A TRUSTED READ, whatever the
       * person's own switch or rules would allow: the work came from something a Bot noticed, not
       * something the person wrote out, so they see each step before it happens. The one thing it
       * does unasked is read an app the person connected with their own account, with a tool a
       * reviewed read list names (`ownConnectionRead`). A tool only labelled a read, by its server or
       * a broker, asks; so does a read chat would run freely (a page, a search on the deployment's
       * key). A stricter answer (a hand-off, a refusal) still stands.
       */
      const inTask =
        continuation?.threadId !== undefined &&
        (await store.asksEveryChange?.(
          candidate.actorId,
          continuation.threadId,
        )) === true;
      const trustedRead = inTask && candidate.ownConnectionRead === true;
      const taskAsks = inTask && !trustedRead;
      const equivalence =
        policy &&
        (candidate.effect !== "read" || taskAsks) &&
        continuation?.threadId
          ? equivalenceOf(candidate)
          : undefined;
      const userTurns = userTurnsOf(continuation);
      if (policy && equivalence && continuation) {
        const prior = await policy.findEquivalent({
          ownerUserId: candidate.actorId,
          threadId: continuation.threadId,
          equivalence,
          excludeToolCallId: continuation.toolCallId,
        });
        if (prior?.status === "pending")
          throw new ApprovalRefusedError(ALREADY_WAITING);
        if (
          prior?.decision === "deny" &&
          (prior.action.userTurns ?? 0) >= userTurns
        ) {
          await policy.recordDecision({
            ownerUserId: candidate.actorId,
            botId: candidate.botId,
            toolRef: candidate.toolRef,
            effect: candidate.effect,
            scope: candidate.scope,
            outcome: {
              behaviour: "deny",
              source: "person_declined",
              reason: DECLINED_BY_PERSON,
            },
            target: candidate.target,
            ...(continuation.initiator
              ? { initiator: continuation.initiator }
              : {}),
          });
          throw new ApprovalRefusedError(DECLINED_BY_PERSON);
        }
      }
      /*
       * A trusted read in a task is judged as the read it is, the way a check-in judges it: the
       * person's and the team's rules about reads still apply, and the switch that asks before
       * changes does not, though chat classifies the tool as a change.
       */
      const evaluated = await evaluate(
        trustedRead ? { ...candidate, effect: "read" } : candidate,
      );
      /*
       * EVERY ASK IN A TASK IS THE TASK'S, whichever layer would have asked anyway. An ask the
       * person's own switch or rule raised would otherwise keep `default` or `personal_rule`, and
       * those are exactly what "Always allow here", turning the switch off and saving an allow rule
       * answer: the card would offer a rule the next task ignores, and the switch or the rule would
       * withdraw what the task is waiting on. Only a stricter answer, a hand-off or a refusal,
       * keeps its own source.
       */
      const outcome: ApprovalPolicyOutcome | undefined =
        taskAsks &&
        evaluated?.behaviour !== "hand_off" &&
        evaluated?.behaviour !== "deny"
          ? {
              behaviour: "ask",
              source: "task",
              reason: TASK_ASKS,
              ...(evaluated?.review ? { review: evaluated.review } : {}),
            }
          : evaluated;
      if (outcome) {
        if (outcome.behaviour === "allow") return;
        // Disabled: refused here, after its audit row, with nothing opened and nothing to approve.
        if (outcome.behaviour === "deny")
          throw new ApprovalRefusedError(outcome.reason);
      } else if (
        // No policy to raise the desktop floor: a sensitive (or unconfirmed) window is still asked.
        candidate.effect === "read"
          ? !desktopFloor(candidate)
          : trustedRead || !(await store.enabled(candidate.actorId))
      )
        return;
      const { ownConnectionRead: _trust, ...asked } = candidate;
      const action: ApprovalAction = {
        ...approvalAction(asked),
        ...(outcome ? { policy: outcome } : {}),
        ...(equivalence ? { equivalence, userTurns } : {}),
      };
      const request = await store.open(action);
      if (request.decision === "handled")
        return { replay: HANDLED_BY_PERSON, complete: async () => undefined };
      if (request.result) {
        if (request.result.error)
          throw new ApprovalAlreadyAnsweredError(request.result.error);
        let replay: unknown;
        try {
          replay = JSON.parse(request.result.content);
        } catch {
          replay = request.result.content;
        }
        return { replay, complete: async () => undefined };
      }
      if (request.status === "denied")
        throw new ApprovalAlreadyAnsweredError(DECLINED_BY_PERSON);
      if (
        request.status === "approved" &&
        (await store.consume(action.actorId, request.id, action.actionDigest))
      )
        return {
          complete: async (output) => {
            const content =
              typeof output === "string" ? output : JSON.stringify(output);
            if (content === undefined)
              throw new ApprovalRefusedError(
                "The approved action returned no result.",
              );
            await store.saveResult(action.actorId, request.id, { content });
            await store.finish(action.actorId, request.id);
          },
        };
      if (request.status !== "pending")
        throw new ApprovalAlreadyAnsweredError(
          "This approval has already been used or revoked. The action was not repeated.",
        );
      const handOff = request.action.policy?.behaviour === "hand_off";
      throw new HeadlessToolSuspension(
        handOff
          ? `This needs you: ${request.action.policy?.reason} Do it yourself, then mark it done on the Bot's page in OpenBot.`
          : "This action is waiting for your approval.",
        {
          kind: "approval",
          approvalId: request.id,
          requestId: request.id,
          ...(handOff ? { handoff: true } : {}),
          continuation: action.continuation,
        },
      );
    },
    async decide(ownerUserId: string, id: string, decision: ApprovalDecision) {
      if (!["allow_once", "allow_always", "deny", "handled"].includes(decision))
        throw new ApprovalRefusedError(
          "Choose allow once, allow always, deny, or done.",
        );
      return store.decide(ownerUserId, id, decision);
    },
    revoke: (ownerUserId: string, id: string) => store.revoke(ownerUserId, id),
    async answerQuestion(
      ownerUserId: string,
      id: string,
      response: string,
      options?: { inConversation?: boolean },
    ) {
      if (!questions)
        throw new ApprovalRefusedError(
          "Questions are unavailable in this deployment.",
        );
      return questions.respond(ownerUserId, id, response, options);
    },
    async dismissQuestion(ownerUserId: string, id: string) {
      if (!questions)
        throw new ApprovalRefusedError(
          "Questions are unavailable in this deployment.",
        );
      return questions.dismiss(ownerUserId, id);
    },
    /**
     * One of this person's own requests, in the inbox's shape, or ApprovalNotFoundError. The inbox
     * carries only the newest hundred, and a board card can be parked on an older one: the card has
     * to learn the request's policy (a hand-off is answered 已处理, not 批准) from somewhere.
     */
    async request(ownerUserId: string, id: string) {
      return publicApproval(await store.get(ownerUserId, id));
    },
    async inbox(ownerUserId: string) {
      const requests = await store.list(ownerUserId);
      const policy = store.policy;
      const [preferences, team, teamRules] = policy
        ? await Promise.all([
            policy.preferences(ownerUserId),
            policy.teamSettings(),
            policy.teamRules(),
          ])
        : [undefined, undefined, []];
      return {
        enabled: await store.enabled(ownerUserId),
        requests: requests.map(publicApproval),
        rules: await store.rules(ownerUserId),
        teamRules,
        ...(preferences && team
          ? {
              preferences,
              team,
              hostCommands: effectiveHostCommandPolicy(
                preferences.hostCommands,
                team.hostCommandsCap,
              ),
            }
          : {}),
        questions: (await questions?.list(ownerUserId)) ?? [],
      };
    },
    /**
     * Which tools to leave out of what the model is offered for this person and Bot (SEC1 D4): those
     * a `deny` disables outright in any layer the gate weighs, the team's, the Bot owner's and the
     * person's own, filtered exactly as the gate filters them. The gate still refuses each of them
     * (the second half of D4), so this only decides what the model is shown. A read that fails
     * throws, as the gate's own would.
     */
    async disabledTools(
      actorId: string,
      botId: string,
    ): Promise<(toolRef: string) => boolean> {
      const policy = store.policy;
      if (!policy) return () => false;
      const [team, teamRules, personal, employee] = await Promise.all([
        policy.teamSettings(),
        policy.teamRules(),
        store.rules(actorId),
        policy.employee?.(botId),
      ]);
      const layers = applicableRules({
        personal,
        ...(employee?.ownerUserId && employee.ownerUserId !== actorId
          ? { owner: employee.rules }
          : {}),
        customRulesEnabled: team.customRulesEnabled,
      });
      const rules = [teamRules, layers.owner, layers.personal];
      return (toolRef) => toolDisabled({ botId, toolRef }, rules);
    },
    /**
     * Why this action would be refused outright, whichever way it turns out to change things: a
     * disabled tool, or the team's host-command cap of `never` (SEC1 D4, D5). Asked before the work of
     * finding out (a local app's tool list starts the app on the machine), so a refused call starts
     * nothing; the gate still decides the action in full afterwards. Undefined: not refused outright.
     */
    async refusal(candidate: ApprovalCandidate): Promise<string | undefined> {
      const policy = store.policy;
      if (!policy) return undefined;
      const [team, teamRules, personal, employee] = await Promise.all([
        policy.teamSettings(),
        policy.teamRules(),
        store.rules(candidate.actorId),
        policy.employee?.(candidate.botId),
      ]);
      let outcome: ApprovalPolicyOutcome | undefined;
      for (const effect of ["read", "write"]) {
        const refused = refusedOutright({
          candidate: { ...candidate, effect },
          team: teamRules,
          personal,
          ...(employee?.ownerUserId &&
          employee.ownerUserId !== candidate.actorId
            ? { owner: employee.rules }
            : {}),
          customRulesEnabled: team.customRulesEnabled,
          hostCommandsCap: team.hostCommandsCap,
        });
        if (!refused) return undefined;
        outcome = refused;
      }
      if (!outcome) return undefined;
      // On the decision log like the gate's own refusal, so a disabled tool is counted either way.
      const continuation = candidate.continuation ?? currentApprovalContext();
      await policy.recordDecision({
        ownerUserId: candidate.actorId,
        botId: candidate.botId,
        toolRef: candidate.toolRef,
        effect: candidate.effect,
        scope: candidate.scope,
        outcome,
        ...(continuation?.initiator
          ? { initiator: continuation.initiator }
          : {}),
      });
      return outcome.reason;
    },
    /** Commands on this person's own computer, after the team cap: the stricter setting applies. */
    async hostCommandPolicy(ownerUserId: string): Promise<HostCommandPolicy> {
      const policy = store.policy;
      if (!policy) return "ask";
      const [preferences, team] = await Promise.all([
        policy.preferences(ownerUserId),
        policy.teamSettings(),
      ]);
      return effectiveHostCommandPolicy(
        preferences.hostCommands,
        team.hostCommandsCap,
      );
    },
    async setPreferences(
      ownerUserId: string,
      input: Partial<ApprovalPreferences>,
    ) {
      if (!store.policy)
        throw new ApprovalRefusedError("Custom rules are unavailable here.");
      if (input.enabled !== undefined)
        await store.setEnabled(ownerUserId, input.enabled);
      const saved = await store.policy.setPreferences(ownerUserId, input);
      // Requests that were only asked because of this switch would otherwise wait for ever.
      if (input.enabled === false)
        await store.policy.withdrawPending(
          ownerUserId,
          WITHDRAWN_APPROVALS_OFF,
          (action) => !action.policy || action.policy.source === "default",
        );
      return saved;
    },
    async createRule(ownerUserId: string, input: ApprovalRuleInput) {
      const policy = store.policy;
      if (!policy)
        throw new ApprovalRefusedError("Custom rules are unavailable here.");
      if (!(await policy.teamSettings()).customRulesEnabled)
        throw new ApprovalRefusedError(
          "Your workspace has switched custom rules off, so personal rules cannot be edited.",
        );
      const rule = await policy.createRule(ownerUserId, input);
      await withdrawAllowed(ownerUserId, rule);
      return rule;
    },
    async updateRule(
      ownerUserId: string,
      id: string,
      input: Partial<ApprovalRuleInput>,
    ) {
      const policy = store.policy;
      if (!policy)
        throw new ApprovalRefusedError("Custom rules are unavailable here.");
      if (!(await policy.teamSettings()).customRulesEnabled)
        throw new ApprovalRefusedError(
          "Your workspace has switched custom rules off, so personal rules cannot be edited.",
        );
      const rule = await policy.updateRule(ownerUserId, id, input);
      await withdrawAllowed(ownerUserId, rule);
      return rule;
    },
    async updateTeamRule(
      by: string,
      id: string,
      input: Partial<ApprovalRuleInput>,
    ) {
      if (!store.policy)
        throw new ApprovalRefusedError("Team rules are unavailable here.");
      return store.policy.updateTeamRule(by, id, input);
    },
    async setTeamSettings(by: string, input: Partial<ApprovalTeamSettings>) {
      if (!store.policy)
        throw new ApprovalRefusedError("Team rules are unavailable here.");
      return store.policy.setTeamSettings(by, input);
    },
    async createTeamRule(by: string, input: ApprovalRuleInput) {
      if (!store.policy)
        throw new ApprovalRefusedError("Team rules are unavailable here.");
      return store.policy.createTeamRule(by, input);
    },
    /**
     * One Bot's permissions page (SEC1 §4.5): the tool modes and floors its owner set, the team's
     * locked rows that name it, and whether the person asking may change them (only the owner may).
     *
     * Somebody else using the Bot sees the owner's settings read-only, because they apply to them
     * too (D9): that is the semantic change the page labels "员工所有者设定".
     */
    async employeePermissions(actorId: string, botId: string) {
      const policy = store.policy;
      if (!policy?.employee)
        throw new ApprovalRefusedError(
          "Employee permissions are unavailable here.",
        );
      // Another person's private Bot is not found, rather than having its owner's settings read out.
      if (policy.botVisible && !(await policy.botVisible(botId)))
        throw new ApprovalNotFoundError();
      const [employee, team, teamRules] = await Promise.all([
        policy.employee(botId),
        policy.teamSettings(),
        policy.teamRules(),
      ]);
      const forThisBot = (rule: {
        botId: string;
        effect: string;
        scope: string;
      }) => rule.botId === botId && rule.effect === "*" && rule.scope === "*";
      return {
        botId,
        editable: employee.ownerUserId === actorId,
        ownedByAnother:
          employee.ownerUserId !== null && employee.ownerUserId !== actorId,
        modes: employee.rules.filter(forThisBot).map((rule) => ({
          id: rule.id,
          toolRef: rule.toolRef,
          behaviour: rule.behaviour,
        })),
        teamRules: teamRules
          .filter((rule) =>
            ruleMatches(
              rule,
              {
                actorId,
                botId,
                toolRef: rule.toolRef,
                effect: rule.effect,
                scope: rule.scope,
                args: null,
              },
              "team_rule",
            ),
          )
          .map((rule) => ({
            id: rule.id,
            toolRef: rule.toolRef,
            effect: rule.effect,
            scope: rule.scope,
            behaviour: rule.behaviour,
          })),
        security: employee.security,
        defaultSensitivePaths: [...DEFAULT_SENSITIVE_PATHS],
        enforceDangerousCommands: team.enforceDangerousCommands,
        customRulesEnabled: team.customRulesEnabled,
      };
    },
    /**
     * The owner sets one tool on one of their Bots to run directly, ask, or be disabled (SEC1 §4.5),
     * or back to no rule. Saved as the owner's own rule `{botId, toolRef, effect: *, scope: *}`.
     *
     * The new rule is written before the old one is revoked, so for the moment both exist the
     * stricter of the two applies and the tool is never briefly looser than either setting. With
     * custom rules off only a tightening mode may be chosen (D6): "run directly" is refused.
     */
    async setEmployeeToolMode(
      ownerUserId: string,
      botId: string,
      toolRef: string,
      mode: EmployeeToolMode | "default",
    ) {
      const policy = store.policy;
      if (!policy?.employee)
        throw new ApprovalRefusedError(
          "Employee permissions are unavailable here.",
        );
      const employee = await policy.employee(botId);
      if (employee.ownerUserId !== ownerUserId)
        throw new ApprovalRefusedError(
          "Only this Bot's owner can change what it may do.",
        );
      if (
        mode === "direct" &&
        !(await policy.teamSettings()).customRulesEnabled
      )
        throw new ApprovalRefusedError(
          "Your workspace has switched custom rules off, so a tool can be set to ask or disabled, but not to run directly.",
        );
      const previous = (await store.rules(ownerUserId)).filter(
        (rule) =>
          rule.botId === botId &&
          rule.toolRef === toolRef &&
          rule.effect === "*" &&
          rule.scope === "*",
      );
      const rule =
        mode === "default"
          ? undefined
          : await policy.createRule(ownerUserId, {
              botId,
              toolRef,
              effect: "*",
              scope: "*",
              behaviour: EMPLOYEE_TOOL_BEHAVIOUR[mode],
            });
      for (const old of previous) await store.revoke(ownerUserId, old.id);
      if (rule) await withdrawAllowed(ownerUserId, rule);
      return rule ?? null;
    },
    /** The owner changes one of their Bots' floors. Row security refuses anybody else's. */
    async setEmployeeSecurity(
      ownerUserId: string,
      botId: string,
      input: Partial<EmployeeSecuritySettings>,
    ) {
      const policy = store.policy;
      if (!policy?.employee || !policy.setEmployeeSecurity)
        throw new ApprovalRefusedError(
          "Employee permissions are unavailable here.",
        );
      if ((await policy.employee(botId)).ownerUserId !== ownerUserId)
        throw new ApprovalRefusedError(
          "Only this Bot's owner can change what it may do.",
        );
      return policy.setEmployeeSecurity(ownerUserId, botId, input);
    },
    async revokeTeamRule(by: string, id: string) {
      if (!store.policy)
        throw new ApprovalRefusedError("Team rules are unavailable here.");
      return store.policy.revokeTeamRule(by, id);
    },
    async resume(
      ownerUserId: string,
      id: string,
      dependencies: ApprovalResumeDependencies,
    ): Promise<void> {
      const request = await store.get(ownerUserId, id);
      if (request.status === "completed") return;
      if (request.status === "pending")
        throw new ApprovalRefusedError(
          "This action is still waiting for your decision.",
        );
      // The server's own settlement checks the row's binding before anything else is read.
      if (databaseSettled) await assertDatabaseBinding(request, ownerUserId);
      // Otherwise the default remains closed. A trusted producer must verify an
      // EXISTING frozen seed before validation, execution or any result write.
      // The no-result/no-producer case is decided first so a blocked retry
      // reads no recovery option or store capability at all.
      else if (
        (!request.result && !fresh) ||
        !options.continuationRecovery ||
        !store.getRecoveryContext
      )
        throw new ApprovalRecoveryBlockedError();
      const prepared =
        !request.result && fresh
          ? await freshOperation(() => fresh.prepare(request, ownerUserId))
          : undefined;
      let executionClaimed = false;
      const saveFresh = async (
        value: NonNullable<ApprovalRecord["result"]>,
        disposition: "continue" | "final" = "continue",
      ) => {
        // Compare-and-set on the SQL NULL result: one answer is kept, and only its saver goes on.
        if (databaseSettled) return store.saveResult(ownerUserId, id, value);
        if (!prepared) throw new ApprovalRecoveryBlockedError();
        return freshOperation(() =>
          prepared.commit(
            value,
            disposition,
            executionClaimed ? "consumed" : request.status,
          ),
        );
      };
      const continuation = request.action.continuation;
      if (!continuation)
        throw new ApprovalRefusedError(
          "The interrupted conversation is unavailable.",
        );
      let result = request.result;
      const refused =
        (!result || databaseSettled) && dependencies.refusal
          ? await dependencies.refusal(request.action)
          : null;
      if (refused && databaseSettled) {
        /*
         * Final: the Bot cannot answer, so nothing is continued. An answer already saved is kept;
         * otherwise only the process that saves the refusal ends the request. A run that was
         * started is not described as not done.
         */
        const answer =
          request.status === "consumed" ? APPROVAL_OUTCOME_UNKNOWN : refused;
        if (
          !result &&
          !(await saveFresh({ content: answer, error: answer }, "final"))
        )
          return;
        await store.finish(ownerUserId, id);
        return;
      }
      if (refused) {
        // Only the process that saves the refusal ends the request.
        if (
          !(await saveFresh(
            {
              content: refused,
              error: refused,
            },
            "final",
          ))
        )
          return;
        if (!fresh) throw new ApprovalRecoveryBlockedError();
        await freshOperation(() => fresh.publish(request, ownerUserId));
        return;
      }
      if (!result && request.status === "consumed") {
        /*
         * Started, and the process running it stopped before saving what happened. Repeating it
         * could do it twice, and refusing to answer left the conversation waiting forever, so the
         * Bot is told. Only the process that saves this answer continues the conversation.
         */
        const reason = APPROVAL_OUTCOME_UNKNOWN;
        if (!(await saveFresh({ content: reason, error: reason }))) return;
        result = { content: reason, error: reason };
      } else if (!result) {
        if (request.status === "denied")
          result = { content: DECLINED_BY_PERSON, error: DECLINED_BY_PERSON };
        else if (request.decision === "handled")
          result = { content: HANDLED_BY_PERSON };
        else {
          /*
           * A re-check that refuses is an answer, not a failure to retry. Thrown, the sweep retried
           * it until its attempts ran out, nothing was saved, and the conversation hung with the
           * request stuck in `approved`. Told to the Bot, the run continues. Anything else (a
           * database or network failure) still throws, so the sweep retries it.
           */
          let current: ApprovalAction | undefined;
          let refusal: string | undefined;
          try {
            current = await dependencies.validate(request.action);
            if (
              current.actorId !== ownerUserId ||
              current.actionDigest !== request.action.actionDigest
            )
              throw new ApprovalRefusedError(
                "The approved action or resolved target has changed.",
              );
            if (!(await store.consume(ownerUserId, id, current.actionDigest))) {
              // Still `approved`: an "Always allow" whose rule was revoked before it ran. Anything
              // else means another replica took the request, and it continues the conversation.
              const latest = await store.get(ownerUserId, id);
              if (latest.status !== "approved" || latest.result) return;
              throw new ApprovalRefusedError(
                "The rule that allowed this was removed before it ran.",
              );
            }
            executionClaimed = true;
          } catch (error) {
            if (!(error instanceof ApprovalRefusedError) && !isPermanent(error))
              throw error;
            refusal = notDoneOnRecheck(
              error instanceof ApprovalRefusedError
                ? error.message
                : permanentReason(error),
            );
          }
          if (refusal !== undefined || !current) {
            const reason = refusal ?? NOT_DONE;
            result = { content: reason, error: reason };
          } else {
            const approved = current;
            try {
              const output = await withApprovalContext(continuation, () =>
                executionAuthority.run(
                  {
                    approvalId: id,
                    digest: approved.actionDigest,
                    owner: ownerUserId,
                  },
                  () => dependencies.execute(approved),
                ),
              );
              const content =
                typeof output === "string" ? output : JSON.stringify(output);
              if (content === undefined)
                throw new Error("The approved action returned no result.");
              result = { content };
            } catch (error) {
              const reason =
                error instanceof Error ? error.message : String(error);
              result = { content: reason, error: reason };
            }
          }
        }
        // Saved by one process only: whichever saves the answer is the one that continues.
        if (!(await saveFresh(result))) return;
      }
      if (databaseSettled) {
        if (!result) throw new ApprovalRecoveryBlockedError();
        // Saved before it is published: a retry after a crash here re-sends this answer, never the action.
        await publishDatabase(request, ownerUserId, result, dependencies);
        return;
      }
      const published = fresh
        ? await freshOperation(() => fresh.publish(request, ownerUserId))
        : { request, final: false };
      if (!published.final)
        await recoverSaved(published.request, ownerUserId, "resume");
    },
    async abandon(
      ownerUserId: string,
      id: string,
      reason: string,
      dependencies: Pick<ApprovalResumeDependencies, "continue" | "refusal">,
    ): Promise<void> {
      const request = await store.get(ownerUserId, id);
      if (request.status === "completed" || request.status === "pending")
        return;
      if (databaseSettled) {
        /*
         * The work item ran out of tries. The action is never run from here: the Bot is told it
         * could not be carried out (or, if it was started, that its outcome is unknown), and only
         * the process that saves that answer continues the conversation.
         */
        await assertDatabaseBinding(request, ownerUserId);
        let result = request.result;
        if (!result) {
          const content =
            request.status === "consumed"
              ? APPROVAL_OUTCOME_UNKNOWN
              : `This action could not be carried out: ${reason.slice(0, 300)}. It was not run by this recovery attempt.`;
          result = { content, error: content };
          if (!(await store.saveResult(ownerUserId, id, result))) return;
        }
        await publishDatabase(request, ownerUserId, result, dependencies);
        return;
      }
      if (!request.result) {
        if (
          !fresh ||
          !options.continuationRecovery ||
          !store.getRecoveryContext
        )
          throw new ApprovalRecoveryBlockedError();
        const prepared = await freshOperation(() =>
          fresh.prepare(request, ownerUserId),
        );
        const content =
          request.status === "consumed"
            ? APPROVAL_OUTCOME_UNKNOWN
            : `This action could not be carried out: ${reason}. It was not run by this recovery attempt.`;
        if (
          !(await freshOperation(() =>
            prepared.commit({ content, error: content }),
          ))
        )
          return;
      }
      const published = fresh
        ? await freshOperation(() => fresh.publish(request, ownerUserId))
        : { request, final: false };
      if (!published.final)
        await recoverSaved(published.request, ownerUserId, "abandon");
    },
  };
}

/**
 * Failures the re-check will meet again on every try: the connector was removed, a saved argument no
 * longer parses, or a private-share check is waiting again. Retried, they only delayed the moment the
 * work item died and the conversation hung.
 */
function isPermanent(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ZodError" || error.name === "CatalogueEntryUnknownError")
    return true;
  return (
    error instanceof HeadlessToolSuspension &&
    !(error instanceof ApprovalValidated)
  );
}
function permanentReason(error: unknown): string {
  if (error instanceof HeadlessToolSuspension)
    return "it is waiting for another decision first.";
  if (error instanceof Error && error.name === "ZodError")
    return "the saved request no longer has a valid shape.";
  return "the app it needs is no longer available.";
}
function publicApproval(request: ApprovalRecord) {
  const { action, ...record } = request;
  return {
    ...record,
    result: request.result ? { error: request.result.error } : null,
    action: {
      botId: action.botId,
      toolRef: action.toolRef,
      effect: action.effect,
      scope: action.scope,
      threadId: action.threadId,
      // The owner's own call id, so the conversation can draw this request where the action was.
      toolCallId: action.toolCallId,
      args: approvalArgsPreview(action),
      target: approvalPreview(action.target),
      // 卡片点名的账号：「send email（Gmail 账号 dana@work.example）」。
      ...(action.account ? { account: action.account } : {}),
      ...(action.policy
        ? {
            policy: {
              behaviour: action.policy.behaviour,
              source: action.policy.source,
              reason: action.policy.reason,
            },
          }
        : {}),
    },
  };
}
