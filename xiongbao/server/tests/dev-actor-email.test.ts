import { describe, expect, test } from "bun:test";
import {
  DEV_ACTOR,
  DEV_ACTOR_EMAIL,
  isDevActorEmail,
} from "../src/auth/dev-actor";

describe("demo account address", () => {
  test("the actor carries the current address", () => {
    expect(DEV_ACTOR_EMAIL).toBe("admin@xiongbao.local");
    expect(DEV_ACTOR.email).toBe("admin@xiongbao.local");
  });

  test("the address is the demo account, whatever the case", () => {
    expect(isDevActorEmail("admin@xiongbao.local")).toBe(true);
    expect(isDevActorEmail(" Admin@XiongBao.local ")).toBe(true);
  });

  test("a real person's address is not the demo account", () => {
    expect(isDevActorEmail("dev@xiongbao.local")).toBe(false);
    expect(isDevActorEmail("")).toBe(false);
    expect(isDevActorEmail(undefined)).toBe(false);
  });
});
