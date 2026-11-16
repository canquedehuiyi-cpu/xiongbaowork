/**
 * What a Bot is told when a step it asked for was not carried out by it, and what the person sees
 * for the same step.
 *
 * The sentences below are written to the model: they say who decided, and what to do next, so the
 * Bot reports it truthfully and does not go looking for another way round. The same text came back
 * as the step's result and was drawn as it stood, in the transcript beside "Ran a command" and in
 * the Computer panel's Activity, so a person read "Do not try this action ... again" about their own
 * decision. They live here, beside {@link outcomeForPerson}, so the app can translate exactly the
 * sentences the server sends, and a change to one cannot leave the other behind.
 *
 * EVERY SENTENCE THE SERVER ANSWERS A STEP WITH IS EXPORTED FROM HERE, the fixed ones as constants
 * and the ones that carry a reason as functions. `server/tests/approval-outcomes-for-person.test.ts`
 * walks these exports and the approval service's, and fails on any that a person would still read in
 * the words written for the Bot, so a sentence added later cannot leak by being forgotten here.
 */

/**
 * What the Bot is told when the person says no. Plain, and distinct from a policy or boundary
 * refusal, so the model reports it truthfully and does not go looking for another way round it.
 */
export const DECLINED_BY_PERSON =
  "The person declined this action when you asked for their approval, so it was not done. This was their decision, not a policy or a boundary. Do not try this action, or anything equivalent, again in this conversation unless the person asks you to in words; tell them you did not do it because they declined.";
/** What a Bot retrying an action that is still waiting is told, instead of opening a second request. */
export const ALREADY_WAITING =
  "An identical request is already waiting for the person's decision on the Bot's page in the app, so this was not done and no second request was made. Do not repeat it; wait for their answer.";
/**
 * ONE VOICE FOR EVERY STEP THAT DID NOT RUN: what happened, then the same two ways on.
 *
 * Three of these used to point three ways: "Do not assume it succeeded", "Run it again if it is
 * still needed" and "Carry on without it". A Bot told only not to assume did nothing with the gap,
 * and one told to carry on left it out of its answer without a word. Every "not run" answer now says
 * what happened and then the same thing: run it again if it is still needed, or say in the answer
 * that it could not be had. `why` is one sentence, with its full stop.
 */
export function notRun(why: string): string {
  return `Not run: ${why} Run it again if you still need it, or say in your answer that you could not get it.`;
}

export const WITHDRAWN_APPROVALS_OFF = notRun(
  "this request was withdrawn because the person switched off asking before changes.",
);
export const WITHDRAWN_RULE_ALLOWS = notRun(
  "this request was withdrawn because a rule the person saved now allows it without asking.",
);
/**
 * What a hand-off answers the Bot with once the person has done it themselves.
 *
 * Not a refusal, and the one sentence here that is not "not done": the thing was done, by the
 * person. See {@link doneByPerson}.
 */
export const HANDLED_BY_PERSON =
  "The person did this themselves. Do not repeat it; continue from what they have done.";
/**
 * An approved step that started, on a process that stopped before saving what happened. Repeating it
 * could do it twice, so it is not repeated, and the Bot is told to find out.
 */
export const OUTCOME_UNKNOWN =
  "This action was started but its outcome is unknown. It was not repeated. Check whether it happened before asking the person again.";
/** An approved step that was turned away by the check just before it ran, with no reason of its own. */
export const NOT_DONE = "Not done.";
/**
 * A step asked for in the same breath as one that waited for the person, which the turn stopped
 * before running. The turn picks up again with an answer for every step it asked for, so a Bot that
 * waits for all of them before it goes on (the Claude Agent SDK's does) is not left waiting for ever.
 */
export const NOT_RUN_WHILE_WAITING = notRun(
  "the turn stopped before this step to wait for the person on another step asked for at the same time.",
);

/**
 * An approved step that the check just before it ran turned away. `why` is one sentence, with its
 * full stop, written for whoever reads it ("The rule that allowed this was removed before it ran.").
 */
export function notDoneOnRecheck(why: string): string {
  return `Not done: ${why} Ask the person again if it is still needed.`;
}

/** An approved step whose work ran out of tries, with what stopped it. */
export function notCarriedOut(reason: string): string {
  return `Not done: this action could not be carried out (${reason.slice(0, 300)}). Check whether it happened before asking the person again.`;
}

/*
 * 下面是给人看的那一半：上面那些写给员工（模型）的英文句子保持原样，人读到的换成中文。
 */
const FOR_PERSON = new Map<string, string>([
  [DECLINED_BY_PERSON, "你拒绝了这一步。"],
  [ALREADY_WAITING, "这一步已经在等你答复了。"],
  [WITHDRAWN_APPROVALS_OFF, "已撤回：你关掉了「改动前先问我」。"],
  [WITHDRAWN_RULE_ALLOWS, "已撤回：你保存的一条规则现在允许这样做。"],
  [HANDLED_BY_PERSON, "你自己完成了这一步。"],
  [NOT_RUN_WHILE_WAITING, "没有执行：员工停下来等你处理另一步了。"],
  [OUTCOME_UNKNOWN, "已经开始执行，但熊宝无法确定它是否完成，没有再执行一次。"],
  [NOT_DONE, "没有执行。"],
]);

/** 「没有执行：」后面跟的原因。 */
const NOT_DONE_FOR_PERSON = "没有执行：";

/**
 * 「Not done: <why>」里已知的 why，换成人读的中文。它们来自服务端（`server/src/approvals/service.ts`
 * 的 `ApprovalRefusedError` 和 `permanentReason`）和 app 自己的审批工具，原句写给员工，保持英文不改；
 * 认不出的 why 原样跟在「没有执行：」后面。
 */
const WHY_FOR_PERSON = new Map<string, string>([
  [
    "The rule that allowed this was removed before it ran.",
    "允许它的规则在它执行前被删除了。",
  ],
  ["it is waiting for another decision first.", "它要先等另一个决定。"],
  [
    "the saved request no longer has a valid shape.",
    "保存下来的请求已经失效。",
  ],
  ["the app it needs is no longer available.", "它要用的应用已经不可用了。"],
  [
    "this conversation asks before every step, and this step couldn't be asked about here.",
    "这个对话每一步都要先问你，而这一步没法在这里问。",
  ],
]);

/**
 * The sentence a person reads for a step the Bot did not carry out. A known sentence is replaced
 * whole. Any other "Not done: <why>." or "Not run: <why>." keeps its first sentence and loses what
 * follows it, which is the Bot's next step ("Ask the person again if it is still needed."), and is
 * said as 「没有执行：<why>」, the why in Chinese where it is one of the known ones. Anything else is a
 * boundary or the computer speaking, already written for a person, and is returned as it is.
 */
export function outcomeForPerson(text: string): string {
  const known = FOR_PERSON.get(text.trim());
  if (known) return known;
  if (!text.startsWith("Not done:") && !text.startsWith("Not run:"))
    return text;
  const end = firstSentenceEnd(text);
  const why = (end === -1 ? text : text.slice(0, end + 1))
    .slice("Not done:".length)
    .trim();
  // notCarriedOut: "this action could not be carried out (<reason>)."
  const carried = /^this action could not be carried out \((.*)\)\.$/s.exec(
    why,
  );
  if (carried) return `${NOT_DONE_FOR_PERSON}这一步没能完成（${carried[1]}）。`;
  return `${NOT_DONE_FOR_PERSON}${WHY_FOR_PERSON.get(why) ?? why}`;
}

/**
 * Whether a step's answer says the person did it themselves. That step was done, by them, and is
 * drawn as done, not as refused: nothing was turned away.
 */
export function doneByPerson(text: string): boolean {
  return text.trim() === HANDLED_BY_PERSON;
}

/**
 * Whether a step's answer says the person declined it. Refused like a boundary's no, but the
 * person's own decision, so it is said as theirs.
 */
export function declinedByPerson(text: string): boolean {
  return text.trim() === DECLINED_BY_PERSON;
}

/** Where the first sentence ends: a full stop followed by a space, outside any parentheses. */
function firstSentenceEnd(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "." && depth === 0 && text[index + 1] === " ")
      return index;
  }
  return -1;
}
