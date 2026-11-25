/**
 * Whether an answer ends on a promise of work instead of the work.
 *
 * FOUND ON A TEAMMATE'S ROUTINE. About twenty lookups across Linear and Notion; the Bot fanned out,
 * then ended its turn "I'll fetch the rest now" with no call after it, and the run was over. Every
 * model does this sometimes (Anthropic documents it: the model "describes what it would do next
 * instead of doing it"), and prompt wording alone roughly halves it, so the harness catches the rest:
 * the check Claude Code's Stop hooks make. Kept deliberately plain: a first-person announcement of an
 * action in the answer's last two sentences, or anywhere with "now" or "next" on it, that is not a
 * question, not waiting on the person and not deferred to another day.
 *
 * A false positive costs one model call, because the nudge it triggers offers the way out ("or
 * finish with the result and what is missing"). A miss costs the run. So the bias is toward firing.
 */

const APOSTROPHE = "['’]";

/** "I'll", "Let me", "Next, I will", "I'm going to", and the rest of the ways a model announces. */
const ANNOUNCES = new RegExp(
  [
    `\\bI${APOSTROPHE}ll\\b`,
    "\\bI will\\b",
    "\\bI shall\\b",
    `\\bI${APOSTROPHE}m (?:now )?(?:going|about) to\\b`,
    "\\bI am (?:now )?(?:going|about) to\\b",
    "\\blet me\\b",
    `\\blet${APOSTROPHE}s\\b`,
  ].join("|"),
  "gi",
);

/** Filler a model puts between the announcement and its verb. */
const FILLER =
  /^(?:\s+(?:now|next|then|just|quickly|also|first|go ahead and|go and|go|start by|continue by|proceed to|try to))*\s+(\p{L}+)/iu;

/**
 * What follows "I'll" or "let me" without being an action this run could take: "let me know",
 * "I'll be here", "I'll keep an eye on it", "I'll let you know", "let's see".
 */
const NOT_ACTIONS = new Set([
  "know",
  "be",
  "need",
  "wait",
  "keep",
  "remember",
  "leave",
  "stop",
  "assume",
  "note",
  "let",
  "hold",
  "stand",
  "see",
  "say",
  "mention",
  "admit",
  "repeat",
]);

/**
 * Doing it now, without the "I", as the sentence's first words: "Fetching the rest now.", "Now
 * checking Notion." Only first, because "the sync is running now" is a report, not a promise.
 */
const GERUND =
  "(?:fetching|checking|pulling|looking up|searching|reading|retrying|grabbing|loading|retrieving|querying|doing|starting|continuing|moving on|proceeding|opening|compiling|gathering|collecting)";
const UNDER_WAY = new RegExp(
  `^(?:now,?\\s+${GERUND}\\b|${GERUND}\\b[^.!?\\n]{0,80}?\\b(?:now|next)\\b)`,
  "i",
);

/** Waiting on the person, or for another day, and so not a promise this run broke. */
const DEFERRED =
  /\b(?:once you|when you|if you|after you|as soon as you|until you|unless you|tomorrow|next (?:run|time|week|month|firing|cycle|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|later today|on the next)\b/i;

/** Said about this run: the step is still to come. */
const IMMEDIATE =
  /\b(?:now|next|right away|immediately|in a moment|shortly|straight away)\b/i;

/**
 * Doing it now, in Chinese: "开工。" "这就去查。" "我马上修。" Same shape as the English
 * announce: a first-person (or zero-subject) commitment in the answer's last two sentences,
 * not a question, not waiting on the person and not deferred. A false positive costs one model
 * call, a miss costs the run; the bias is toward firing.
 *
 * The second line is how DeepSeek opens a step it then does not take: 「让我先查看一下项目结构。」
 * 「我将读取三个文件。」「我先跑一遍测试。」「我来修复。」「首先，我需要…」「下面开始…」「然后我会…」
 * 「我会先…」「马上开始…」. Several of them also open a report of work already done (「我先修复了
 * A」「我将结果保存到了 B」「首先，我修复了…」), or a summary (「让我总结一下：…」), which is why
 * what follows each one is read too ({@link ZH_NOT_ACTIONS}, {@link ZH_DONE}).
 */
const ZH_ANNOUNCES = new RegExp(
  [
    "(?<!已经|正在|已)开工|这就去|这就开始|这就动手|这就着手|这就接着|我这就|我马上|我立刻|我即刻|马上就去|立刻就去|即刻就去|接下来我|下一步我|现在我就|我就把|现在就把",
    "(?<![这那它他她请也])让我|(?<!由)我将|我先|(?<![对于由])我来(?!自|说)|首先[，,、\\s]*(?:我(?!们?的)|让我|需要|要|得|来|先)|首先(?=查看|检查|看看|看一下|读取|搜索|获取|分析|确认|打开|运行|列出|执行|安装|创建)|下面开始|然后我会|我会先|^马上|[，,]\\s*马上",
  ].join("|"),
  "g",
);

/**
 * What follows an opening that is not work this run could still do with a tool: a summary
 * (「让我总结一下」「我来说明」), the person's turn (「让我知道」), or a feeling (「这让我想到」).
 */
const ZH_NOT_ACTIONS =
  /^(?:先|再|来|也|就|简单|简要|快速|一起|地)*(?:总结|汇总|归纳|概括|小结|回顾|说明|解释|介绍|简述|汇报|报告|列出|列一下|说|讲|知道|想到|觉得|意识到|感到)/;

/**
 * Done already, in the clause an opening starts: 「已经」, 「已」 (not 「已有」「已知」), 「过了」, a 「了」
 * anywhere but at its very end, 「完毕」. A 「了」 that ends the clause is the particle of a request
 * or a plan as often as of a report (「我来把它修了。」), so it is not read as done.
 */
const ZH_DONE = /已经|已(?![有知])|过了|了(?![\s。！!….]*$)|完毕/;

/** Waiting on the person, or for another day, in Chinese. */
const ZH_DEFERRED =
  /(?:等你|等你确认|您确认|你确认后|一旦你|下次|下一轮|下轮|明天|后天|稍后|回头再|以后再|之后再|之后再说|晚点再)/;

/**
 * The sentence in `text` that promises work the run did not do, or undefined.
 *
 * Only for an answer that made no tool call: the caller decides that. An answer ending on a question
 * to the person is theirs to answer, not a promise, and is never one here.
 */
export function unkeptPromise(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || /[?？]$/.test(trimmed)) return undefined;
  const paragraphs = trimmed.split(/\n\s*\n/);
  // The last two sentences: where a run that stopped short says what it was about to do.
  for (const sentence of sentences(paragraphs.at(-1) ?? "").slice(-2))
    if (promises(sentence)) return sentence;
  for (const sentence of sentences(trimmed))
    if (IMMEDIATE.test(sentence) && promises(sentence)) return sentence;
  return undefined;
}

function promises(sentence: string): boolean {
  // A question is the person's to answer; a colon introduces what follows it, which is the work.
  if (
    /[?:？：]$/.test(sentence) ||
    DEFERRED.test(sentence) ||
    ZH_DEFERRED.test(sentence)
  )
    return false;
  if (UNDER_WAY.test(sentence)) return true;
  for (const match of sentence.matchAll(ZH_ANNOUNCES)) {
    // The clause the opening starts: up to the next comma or semicolon, or the sentence's end.
    const clause =
      sentence
        .slice((match.index ?? 0) + match[0].length)
        .split(/[，,；;]/)[0] ?? "";
    if (!ZH_NOT_ACTIONS.test(clause) && !ZH_DONE.test(clause)) return true;
  }
  for (const match of sentence.matchAll(ANNOUNCES)) {
    const after = sentence.slice((match.index ?? 0) + match[0].length);
    const verb = FILLER.exec(after)?.[1]?.toLowerCase();
    if (verb && !NOT_ACTIONS.has(verb)) return true;
  }
  return false;
}

/** The sentences of a paragraph, each trimmed, with line breaks and list items counted as ends. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|(?<=[。！？])|\n+/)
    .map((sentence) => sentence.replace(/^[^\p{L}\p{N}"'‘“]+/u, "").trim())
    .filter((sentence) => sentence.length > 0)
    .map((sentence) =>
      sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence,
    );
}
