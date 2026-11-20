import { describe, expect, test } from "bun:test";
import { serverTurnScope } from "../src/routines/run-turn";
import {
  adoptRunnerCard,
  fileRunnerCardAs,
} from "../src/threads/postgres-runner";
import {
  asPersonChat,
  clearPersonChat,
  onlyOnIdleThread,
  personChatRequested,
  roundHungByEntry,
  suppressRunnerCard,
  turnForCard,
} from "../src/threads/unattended-card";

/*
 * "A person's own chat" is marked on the request the browser sent, and the mark follows the async chain
 * from there. A turn the server starts from inside that request (a nudge, a hop to another employee, a
 * wake-up, a routine, a card's round) must not carry it: every entry that starts a turn of its own clears it.
 */
const entries: [string, (body: () => unknown) => unknown][] = [
  ["suppressRunnerCard", (body) => suppressRunnerCard(body)],
  ["roundHungByEntry", (body) => roundHungByEntry(body)],
  ["turnForCard", (body) => turnForCard("task-1", body)],
  ["onlyOnIdleThread", (body) => onlyOnIdleThread(body)],
  [
    "fileRunnerCardAs",
    (body) =>
      fileRunnerCardAs({ source: "routine", triggerSource: "wake_up" }, body),
  ],
  ["adoptRunnerCard", (body) => adoptRunnerCard("run-1", body)],
  ["clearPersonChat", (body) => clearPersonChat(body)],
  [
    "the headless turn scope, with a card of its own",
    (body) =>
      serverTurnScope(
        { cardOwnedByCaller: true, runRef: "r" } as never,
        body as never,
      ),
  ],
  [
    "the headless turn scope, without one",
    (body) =>
      serverTurnScope({ cardOwnedByCaller: false } as never, body as never),
  ],
];

describe("the person-chat marker", () => {
  test("is set inside asPersonChat and nowhere else", () => {
    expect(personChatRequested()).toBe(false);
    expect(asPersonChat(() => personChatRequested())).toBe(true);
    expect(personChatRequested()).toBe(false);
  });

  test.each(entries)(
    "%s starts a turn that is not the person's chat, even inside one",
    (_name, enter) => {
      let inside: boolean | undefined;
      asPersonChat(() =>
        enter(() => {
          inside = personChatRequested();
        }),
      );
      expect(inside).toBe(false);
    },
  );

  test("and it is cleared down the async chain too, not only in the first frame", async () => {
    let later: boolean | undefined;
    await asPersonChat(() =>
      onlyOnIdleThread(async () => {
        await Bun.sleep(1);
        later = personChatRequested();
      }),
    );
    expect(later).toBe(false);
    // While the chat's own request goes on seeing it.
    let own: boolean | undefined;
    await asPersonChat(async () => {
      await onlyOnIdleThread(async () => Bun.sleep(1));
      await Bun.sleep(1);
      own = personChatRequested();
    });
    expect(own).toBe(true);
  });
});
