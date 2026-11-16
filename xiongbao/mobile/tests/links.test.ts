import { expect, test } from "bun:test";
import { notificationDestination } from "../src/links";

test("briefing push opens the briefing page", () => {
  expect(
    notificationDestination({ kind: "briefing", url: "xiongbao://briefing" }),
  ).toEqual({ webPath: "/briefing" });
});
test("overdue push opens that card", () => {
  expect(
    notificationDestination({
      kind: "overdue",
      taskId: "t 1",
      url: "xiongbao://tasks/t%201",
    }),
  ).toEqual({ webPath: "/tasks/t%201" });
  expect(
    notificationDestination({ kind: "overdue", url: "xiongbao://tasks/abc-1" }),
  ).toEqual({ webPath: "/tasks/abc-1" });
});
test("overdue without a usable card id falls back to the briefing", () => {
  expect(
    notificationDestination({ kind: "overdue", url: "xiongbao://tasks/" }),
  ).toEqual({ webPath: "/briefing" });
  expect(
    notificationDestination({ kind: "overdue", url: "xiongbao://briefing" }),
  ).toEqual({ webPath: "/briefing" });
  expect(notificationDestination({ kind: "overdue" })).toEqual({
    webPath: "/briefing",
  });
  expect(
    notificationDestination({ kind: "overdue", taskId: "a/../b" }),
  ).toEqual({ webPath: "/briefing" });
});
test("existing pushes resolve as before", () => {
  expect(
    notificationDestination({ url: "xiongbao://needs-you", kind: "attention" }),
  ).toEqual({ pathname: "/needs-you", params: {} });
  expect(
    notificationDestination({
      url: "xiongbao://conversation?channelId=c1",
    }),
  ).toEqual({ pathname: "/conversation", params: { channelId: "c1" } });
  expect(
    notificationDestination({
      url: "xiongbao://approvals?channelId=c1&requestId=r1",
    }),
  ).toEqual({
    pathname: "/approvals",
    params: { channelId: "c1", requestId: "r1" },
  });
  expect(
    notificationDestination({ url: "xiongbao://conversation" }),
  ).toBeNull();
  expect(
    notificationDestination({ url: "xiongbao://needs-you?x=1" }),
  ).toBeNull();
});
test("unknown or malformed data is ignored safely", () => {
  for (const value of [
    null,
    undefined,
    "x",
    {},
    { kind: "mystery" },
    { kind: "mystery", url: "xiongbao://mystery" },
    { url: "https://evil.example/briefing" },
    { url: "xiongbao://briefing/extra" },
    { url: "xiongbao://briefing?x=1" },
    { url: "xiongbao://tasks/a?x=1" },
    { url: "xiongbao://u:p@briefing" },
    { url: "xiongbao://tasks/%E0%A4%A" },
    { url: 5 },
  ])
    expect(() => notificationDestination(value)).not.toThrow();
  expect(notificationDestination({ kind: "mystery" })).toBeNull();
  expect(
    notificationDestination({ url: "https://evil.example/briefing" }),
  ).toBeNull();
  expect(
    notificationDestination({ url: "xiongbao://briefing/extra" }),
  ).toBeNull();
});
