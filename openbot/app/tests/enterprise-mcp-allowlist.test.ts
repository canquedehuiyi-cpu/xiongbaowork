import { describe, expect, test } from "bun:test";
import {
  isMcpServerApproved,
  withMcpServerApproval,
} from "../src/lib/enterprise/queries";

/**
 * The MCP allowlist switches on Admin > Enterprise controls.
 *
 * The list offers one entry per app, keyed by the name a tool call uses (`notion`). Since G01-E a
 * curated connector's row is `team:notion`, and the screen used to save that row id, so a deployment
 * may already hold it: the switch has to read it as approving `notion`, and turning it off has to
 * take it out too, or the app stays approved with its switch showing off.
 */
const notion = { id: "notion", rowIds: ["team:notion"] };
const custom = { id: "my-custom", rowIds: ["my-custom"] };

describe("which apps the MCP allowlist approves", () => {
  test("an app is approved by its key or by a row id saved before", () => {
    expect(isMcpServerApproved(["notion"], notion)).toBe(true);
    expect(isMcpServerApproved(["team:notion"], notion)).toBe(true);
    expect(isMcpServerApproved(["my-custom"], custom)).toBe(true);
    expect(isMcpServerApproved(["team:linear"], notion)).toBe(false);
    expect(isMcpServerApproved([], notion)).toBe(false);
  });

  test("approving saves the app key, once", () => {
    expect(withMcpServerApproval([], notion, true)).toEqual(["notion"]);
    expect(withMcpServerApproval(["team:notion"], notion, true)).toEqual([
      "team:notion",
    ]);
    expect(withMcpServerApproval(["notion"], notion, true)).toEqual(["notion"]);
  });

  test("turning an app off removes its key and every row id it was saved under", () => {
    expect(
      withMcpServerApproval(
        ["team:notion", "notion", "my-custom"],
        notion,
        false,
      ),
    ).toEqual(["my-custom"]);
  });
});
