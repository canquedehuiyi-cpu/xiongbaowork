import { TURN_LIMITS } from "@xiongbao/toolkit/limits";
import type { TurnRunner } from "@xiongbao/toolkit/run-turn";
import { createTurnRunner } from "../routines/run-turn";
import { declaresServerComputerTools } from "./chat-server-tools";

/**
 * The runner an approval, a sign-in or a computer wait carries a turn on with, and the clock it runs
 * under (期九·三).
 *
 * Everything that is carried on after a person's answer runs on the light turn's clock, five minutes,
 * as the chat counts a conversation as carried on for a little after the decision. A chat whose
 * computer tools the server runs (期九·一: the run declared `computerTools: "server"`, and the
 * deployment has the switch on) is a long turn, up to twenty-five minutes and eighty rounds of tools,
 * and the part after an approval is the same turn: it must not be cut at five. So that one continuation
 * is told apart by what the run it continues was sent, which the snapshot carries, and is given the
 * working turn's clock. Every other continuation keeps its five minutes.
 */
export function createContinuationRunner(deps: {
  options: Parameters<typeof createTurnRunner>[0];
  /** The deployment's switch for chats whose computer tools the server runs. */
  serverComputerTools: boolean;
  /** The clock of such a chat's continuation. The working turn's, unless a test says otherwise. */
  serverChatTurnTimeoutMs?: number;
  /** Its rounds of tool calls. The working turn's, unless a test says otherwise. */
  serverChatSegments?: number;
  /** The light runner, when the caller has already built it from the same options. */
  light?: TurnRunner;
  /** The runner's factory, for a test that wants to see what it was built with. */
  make?: typeof createTurnRunner;
}): TurnRunner {
  const make = deps.make ?? createTurnRunner;
  const light = deps.light ?? make(deps.options);
  const long = make({
    ...deps.options,
    turnTimeoutMs:
      deps.serverChatTurnTimeoutMs ?? TURN_LIMITS.workTurnTimeoutMs,
    maxToolSegments: deps.serverChatSegments ?? TURN_LIMITS.workToolSegments,
  });
  return (input) =>
    deps.serverComputerTools &&
    declaresServerComputerTools(input.continuation?.snapshot.forwardedProps)
      ? long(input)
      : light(input);
}
