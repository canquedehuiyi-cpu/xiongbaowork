import { expect, test } from "bun:test";
import { callerMastraContext } from "../src/copilot";

/*
 * An approval's continuation snapshot keeps the context a run was sent and replays it as-is. Entries
 * this server wrote under their names before the rename come back with it; a Mastra Bot only knows
 * the current names, so anything forwarded as the caller's context becomes its instructions.
 */
test("server entries under their earlier names never reach a Mastra Bot as the caller's context", () => {
  const replayed = [
    { description: "OpenBot standing role", value: "stale role" },
    { description: "OpenBot granted tools guidance", value: "stale guidance" },
    { description: "OpenBot Bot id", value: "bot-1" },
    { description: "OpenBot deployment tools", value: "[]" },
    { description: "OpenBot signed run assertion", value: "credential" },
    { description: "OpenBot learned skills", value: "stale catalog" },
    { description: "OpenBot personal memory", value: "QUOTED_MEMORY" },
  ];
  expect(callerMastraContext(replayed)).toEqual([]);
});

test("the caller's own context still goes through, and the current server entries are left to the server", () => {
  const caller = { description: "Customer tier", value: "gold" };
  expect(
    callerMastraContext([
      caller,
      { description: "XiongBao standing role", value: "role" },
      { description: "XiongBao signed run assertion", value: "credential" },
    ]),
  ).toEqual([caller]);
});
