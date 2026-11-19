/**
 * What a conversation's turn leaves behind when it stops before it is done, shared by the server that
 * writes it and the screen that reads it (期九·四).
 *
 * A turn the server runs end to end can stop in two ways nobody asked for: its clock or its budget of
 * tool rounds ran out (`turn-limit`), or the process running it went away (`turn-interrupted`). Either
 * way the conversation says so in a sentence and carries one `CUSTOM` event in the turn's own stream
 * just before the run finishes, so the screen can offer the person a 「继续」 button instead of leaving
 * them to guess what to type. The event is stored with the turn's other events, so a reload replays it.
 */

/** The event a turn's clock or budget leaves in the conversation. */
export const TURN_LIMIT_EVENT = "turn-limit";

/** The event a turn that lost its process leaves in the conversation. */
export const TURN_INTERRUPTED_EVENT = "turn-interrupted";

/** Which limit a turn ran into: the clock, or the number of rounds of tool calls. */
export type TurnLimitReason = "time" | "segments";

/** What {@link TURN_LIMIT_EVENT} carries. */
export type TurnLimitPayload = { reason: TurnLimitReason };

/**
 * How long a person's turn may run, in minutes, as the screen says it. The server's own clock is
 * `TURN_LIMITS.workTurnTimeoutMs` in the toolkit; a server test holds the two together.
 */
export const TURN_TIME_LIMIT_MINUTES = 25;

/** The sentence in the conversation when the turn's clock ran out; `minutes` is the limit it ran under. */
export const timeUpNotice = (minutes: number) =>
  `这一轮已经跑满 ${minutes} 分钟，我先停在这里。已经做完的步骤都保留着，没做完的那一步没有执行；要接着做，请回复「继续」。`;

/** The sentence when the turn used up its rounds of tool calls. */
export const SEGMENTS_NOTICE =
  "这一轮我连续调用工具的次数已经到了上限，先停在这里。已经做完的步骤都保留着，没做完的那一步没有执行；要接着做，请回复「继续」。";

/** The sentence when the process running the turn went away. */
export const INTERRUPTED_NOTICE =
  "服务重启了，这一轮在中途被打断。已经做完的步骤都保留着；正在做的那一步可能已经执行了一部分，系统没有重新执行它，请先确认结果。要接着做，请回复「继续」。";

/** What a person's run says in its `forwardedProps` to have the server run its computer tools. */
export const COMPUTER_TOOLS_PROP = "computerTools";
export const SERVER_COMPUTER_TOOLS = "server";
