import { describe, expect, test } from "bun:test";
import {
  DEV_ACTOR,
  DEV_ACTOR_EMAIL,
  LEGACY_DEV_ACTOR_EMAILS,
  isDevActorEmail,
} from "../src/auth/dev-actor";

describe("demo account address", () => {
  test("the actor carries the current address and the legacy list names the old one", () => {
    expect(DEV_ACTOR_EMAIL).toBe("admin@xiongbao.local");
    expect(DEV_ACTOR.email).toBe("admin@xiongbao.local");
    expect(LEGACY_DEV_ACTOR_EMAILS).toEqual(["dev@openbot.local"]);
  });

  test("both the current and the legacy address are the demo account, whatever the case", () => {
    expect(isDevActorEmail("admin@xiongbao.local")).toBe(true);
    expect(isDevActorEmail("dev@openbot.local")).toBe(true);
    expect(isDevActorEmail("Dev@OpenBot.local")).toBe(true);
  });

  test("a real person's address is not the demo account", () => {
    expect(isDevActorEmail("admin@openbot.local")).toBe(false);
    expect(isDevActorEmail("dev@xiongbao.local")).toBe(false);
    expect(isDevActorEmail("")).toBe(false);
    expect(isDevActorEmail(undefined)).toBe(false);
  });
});
