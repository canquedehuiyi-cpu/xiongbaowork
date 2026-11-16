import { expect, test } from "bun:test";
import { firstConversationGreeting } from "../src/lib/auth/greeting";
import type { AuthenticatedUser } from "../src/lib/auth/queries";

const user: AuthenticatedUser = {
  id: "u",
  email: "user@example.test",
  name: "Sam Julien",
  role: "user",
  onboarding: null,
  needsName: false,
};
test("greets by the saved name only with a confirmed empty conversation list", () => {
  expect(firstConversationGreeting(user, true)).toBe(
    "Sam Julien，你好！今天想做点什么？",
  );
  expect(firstConversationGreeting(user, false)).toBe("开始一段对话");
});
test("does not greet with a missing or placeholder name", () => {
  for (const value of [
    undefined,
    null,
    { ...user, name: "" },
    { ...user, needsName: true },
    { ...user, name: user.email },
  ]) {
    expect(firstConversationGreeting(value, true)).toBe("开始一段对话");
  }
});
