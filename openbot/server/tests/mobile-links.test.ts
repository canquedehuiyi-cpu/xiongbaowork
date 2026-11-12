import { expect, test } from "bun:test";
import { notificationDestination } from "../../mobile/src/links";

test("native push opens only known screens and preserves canonical owner-scoped conversation IDs", () => {
  expect(
    notificationDestination({
      url: "xiongbao://conversation?channelId=channel",
    }),
  ).toEqual({ pathname: "/conversation", params: { channelId: "channel" } });
  expect(
    notificationDestination({
      url: "xiongbao://approvals?channelId=channel&requestId=q1",
    }),
  ).toEqual({
    pathname: "/approvals",
    params: { channelId: "channel", requestId: "q1" },
  });
  for (const url of [
    "https://evil.test",
    "xiongbao://attacker?channelId=c",
    "xiongbao://conversation/evil?channelId=c",
    "xiongbao://conversation",
    "xiongbao://user:password@conversation?channelId=c",
  ])
    expect(notificationDestination({ url })).toBeNull();
});

test("a ping opens the Needs you list, and a malformed Needs you link opens nothing", () => {
  expect(notificationDestination({ url: "xiongbao://needs-you" })).toEqual(
    { pathname: "/needs-you", params: {} },
  );
  for (const url of [
    "xiongbao://needs-you/evil",
    "xiongbao://needs-you?channelId=c",
    "xiongbao://needs-you#top",
    "xiongbao://user:password@needs-you",
    "xiongbao://needs-you:8080",
    "https://needs-you",
    "xiongbao://needs-yours",
  ])
    expect(notificationDestination({ url })).toBeNull();
});
