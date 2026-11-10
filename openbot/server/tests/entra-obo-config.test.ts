import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * The deployment settings X6 adds or tightens for Entra on-behalf-of (review I-2).
 *
 * MICROSOFT_OAUTH_OBO_RESOURCES is where the operator, not an OpenBot admin, says which company
 * systems a person's delegated token may be minted for and the one host each may be sent to.
 * OpenBot's own API and Microsoft's first-party resources are refused at start-up, and so is
 * OpenBot's own client id among the apps that may call in.
 */

const OPENBOT = "6e74172b-be56-4843-9ff4-e66a39bb12e3";
const APP = "1b4f7c2d-0000-4000-8000-000000000001";

const entra = (overrides: Record<string, string>) =>
  loadConfig(
    testEnvironment({
      MICROSOFT_OAUTH_CLIENT_ID: OPENBOT,
      MICROSOFT_OAUTH_CLIENT_SECRET: "entra-client-secret",
      MICROSOFT_OAUTH_TENANT_ID: "8f2c1e40-0000-0000-0000-000000000000",
      ...overrides,
    }),
  ).auth?.microsoft;

describe("MICROSOFT_OAUTH_OBO_RESOURCES", () => {
  test("unset, nothing is registered, and so nothing can be marked", () => {
    expect(entra({})).not.toHaveProperty("oboResources");
  });

  test("each entry binds one resource to one host, compared lower-case", () => {
    expect(
      entra({
        MICROSOFT_OAUTH_OBO_RESOURCES:
          "API://HR-API=HR.example.com, https://contoso.com/pay=pay.contoso.com",
      })?.oboResources,
    ).toEqual([
      { resource: "api://hr-api", host: "hr.example.com" },
      { resource: "https://contoso.com/pay", host: "pay.contoso.com" },
    ]);
  });

  test("OpenBot's own API cannot be registered, by client id, URI or a custom API scope", () => {
    expect(() =>
      entra({
        MICROSOFT_OAUTH_OBO_RESOURCES: `api://${OPENBOT}=hr.example.com`,
      }),
    ).toThrow("登记了 OpenBot 自己的 API");
    expect(() =>
      entra({ MICROSOFT_OAUTH_OBO_RESOURCES: `${OPENBOT}=hr.example.com` }),
    ).toThrow("登记了 OpenBot 自己的 API");
    expect(() =>
      entra({
        MICROSOFT_OAUTH_API_SCOPE: "api://openbot.example.com/access_as_user",
        MICROSOFT_OAUTH_OBO_RESOURCES:
          "api://openbot.example.com=hr.example.com",
      }),
    ).toThrow("登记了 OpenBot 自己的 API");
  });

  test("Microsoft Graph and other first-party resources cannot be registered", () => {
    for (const resource of [
      "https://graph.microsoft.com",
      "00000003-0000-0000-c000-000000000000",
      "https://contoso.sharepoint.com",
    ])
      expect(() =>
        entra({ MICROSOFT_OAUTH_OBO_RESOURCES: `${resource}=hr.example.com` }),
      ).toThrow("登记了 Microsoft 的第一方资源");
  });

  test("the same resource written twice stops the server at start-up, rather than one being ignored", () => {
    expect(() =>
      entra({
        MICROSOFT_OAUTH_OBO_RESOURCES:
          "api://hr-api=hr.example.com,api://hr-api=attacker.example",
      }),
    ).toThrow("MICROSOFT_OAUTH_OBO_RESOURCES 里 api://hr-api 写了不止一次");
  });

  test("an entry without a host, or with a URL for one, is refused", () => {
    expect(() =>
      entra({ MICROSOFT_OAUTH_OBO_RESOURCES: "api://hr-api" }),
    ).toThrow("写法不对");
    expect(() =>
      entra({
        MICROSOFT_OAUTH_OBO_RESOURCES: "api://hr-api=https://hr.example.com",
      }),
    ).toThrow("写法不对");
  });
});

describe("MICROSOFT_OAUTH_ALLOWED_CLIENTS", () => {
  test("never lists OpenBot itself, whose on-behalf-of tokens name it as azp", () => {
    expect(() =>
      entra({
        MICROSOFT_OAUTH_ALLOWED_CLIENTS: `${APP},${OPENBOT.toUpperCase()}`,
      }),
    ).toThrow("MICROSOFT_OAUTH_ALLOWED_CLIENTS 里有 OpenBot 自己的 client id");
    expect(
      entra({ MICROSOFT_OAUTH_ALLOWED_CLIENTS: APP })?.allowedClients,
    ).toEqual([APP]);
  });
});
