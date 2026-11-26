import { describe, expect, test } from "bun:test";
import { desktopTelemetryProperties } from "./desktop-telemetry";

describe("desktop runtime metadata", () => {
  test("leaves ordinary server deployments untagged", () => {
    expect(desktopTelemetryProperties({})).toEqual({});
    expect(
      desktopTelemetryProperties({ XIONGBAO_DISTRIBUTION: "server" }),
    ).toEqual({});
  });

  test("carries only the shell's bounded metadata", () => {
    expect(
      desktopTelemetryProperties({
        XIONGBAO_DISTRIBUTION: "desktop",
        XIONGBAO_VERSION: "0.0.9",
        XIONGBAO_PLATFORM: "macos",
        XIONGBAO_ARCH: "aarch64",
        XIONGBAO_OS_VERSION: "15.6.1",
        XIONGBAO_ENGINE: "podman",
        OPENAI_API_KEY: "synthetic-secret",
        TELEMETRY_ID: "identity-belongs-in-the-transport",
        HOME: "/Users/private-name",
        XIONGBAO_BASE_URL: "https://private.example",
      }),
    ).toEqual({
      xiongbao_distribution: "desktop",
      xiongbao_version: "0.0.9",
      xiongbao_platform: "macos",
      xiongbao_arch: "aarch64",
      xiongbao_os_version: "15.6.1",
      xiongbao_engine: "podman",
    });
  });

  test("keeps a release candidate's label on the app version only", () => {
    expect(
      desktopTelemetryProperties({
        XIONGBAO_DISTRIBUTION: "desktop",
        XIONGBAO_VERSION: "1.0.0-rc.5",
        XIONGBAO_OS_VERSION: "15.6.1-rc.5",
      }),
    ).toEqual({
      xiongbao_distribution: "desktop",
      xiongbao_version: "1.0.0-rc.5",
    });
    for (const value of ["1.0.0-beta", "0.3.4", "1.0.0-canary.12"]) {
      expect(
        desktopTelemetryProperties({
          XIONGBAO_DISTRIBUTION: "desktop",
          XIONGBAO_VERSION: value,
        }).xiongbao_version,
      ).toBe(value);
    }
  });

  test.each([
    "1.0.0-rc.x",
    "1.0.0-rc.5.6",
    "1.0.0-rc-private",
    "/Users/private-name",
    "private.example",
    "1.2-private-name",
    "1.2\nsecret",
    "1.2\n",
    "1.2.3.4.5",
    "1".repeat(40),
  ])("rejects arbitrary text in every metadata field: %s", (value) => {
    expect(
      desktopTelemetryProperties({
        XIONGBAO_DISTRIBUTION: "desktop",
        XIONGBAO_VERSION: value,
        XIONGBAO_OS_VERSION: value,
        XIONGBAO_PLATFORM: value,
        XIONGBAO_ARCH: value,
        XIONGBAO_ENGINE: value,
      }),
    ).toEqual({ xiongbao_distribution: "desktop" });
  });
});
