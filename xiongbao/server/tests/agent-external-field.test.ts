import { describe, expect, test } from "bun:test";
import { externalField } from "../src/agents/profile-store";
import { externalFor } from "../src/agents/routes";

/*
 * 外部员工 Task 11: what the generic agent DTO says about an external employee (`device_acp`), so its
 * badge, card, header and settings can be drawn: its computer, agent, folder and rules, by reference.
 */
describe("externalField", () => {
  test("a device_acp Bot publishes its computer, agent, folder and rules", () => {
    expect(
      externalField({
        type: "device_acp",
        configuration: {
          deviceId: "dev-mac",
          harness: "codex",
          workdirRef: "fld_web",
          permissions: { push: "direct", runCommand: "dangerous" },
        },
      }),
    ).toEqual({
      externalRun: {
        harness: "codex",
        deviceId: "dev-mac",
        workdirRef: "fld_web",
        rules: {
          editInside: "direct",
          touchOutside: "ask",
          runCommand: "dangerous",
          network: "ask",
          push: "direct",
        },
      },
    });
  });

  test("a custom agent carries its own agent and the hirer's acknowledgement", () => {
    expect(
      externalField({
        type: "device_acp",
        configuration: {
          deviceId: "dev-mac",
          harness: "custom",
          workdirRef: "fld_web",
          appRef: "app_mine",
          noPermissionAcknowledged: true,
          // A value a rule cannot take reads as ask, as the permission bridge reads it.
          permissions: { editInside: "dangerous" },
        },
      }).externalRun,
    ).toMatchObject({
      harness: "custom",
      appRef: "app_mine",
      noPermissionAcknowledged: true,
      rules: { editInside: "ask" },
    });
  });

  test("any other Bot, or a broken configuration, publishes none", () => {
    expect(
      externalField({ type: "built_in", configuration: { harness: "codex" } }),
    ).toEqual({});
    expect(
      externalField({
        type: "device_acp",
        configuration: { harness: "codex", workdirRef: "fld_web" },
      }),
    ).toEqual({});
    expect(
      externalField({
        type: "device_acp",
        configuration: {
          deviceId: "dev-mac",
          harness: "grok",
          workdirRef: "fld_web",
        },
      }),
    ).toEqual({});
  });
});

describe("externalFor", () => {
  const run = externalField({
    type: "device_acp",
    configuration: {
      deviceId: "dev-mac",
      harness: "codex",
      workdirRef: "fld_web",
      permissions: {},
    },
  }).externalRun;

  test("its hirer reads the whole run", () => {
    expect(
      externalFor(
        { id: "hirer", role: "user" },
        { ownerUserId: "hirer", externalRun: run },
      ),
    ).toEqual({ external: run });
  });

  test("anybody else, an administrator included, reads only which agent it is", () => {
    for (const actor of [
      { id: "admin", role: "admin" as const },
      { id: "someone", role: "user" as const },
    ])
      expect(
        externalFor(actor, { ownerUserId: "hirer", externalRun: run }),
      ).toEqual({ external: { harness: "codex" } });
  });

  test("any other Bot says nothing", () => {
    expect(
      externalFor({ id: "hirer", role: "user" }, { ownerUserId: "hirer" }),
    ).toEqual({});
  });
});
