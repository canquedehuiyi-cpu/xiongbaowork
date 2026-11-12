import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testAgentConnection } from "../src/agents/connection-test";
import { desktopAuthPage } from "../src/auth/native-browser";
import {
  createOrganizationAuth,
  organizationAuthority,
} from "../src/auth/organization";
import { resetBrand, setBrand } from "../src/brand";
import { accessibilityTitle, identityGuidance } from "../src/copilot";
import { turnFailureMessage } from "../src/delivery/opentag-agent";
import { defaultPushTitle } from "../src/delivery/router";
import { createTwilioTransport } from "../src/delivery/twilio";
import {
  connectorApprovalGuidance,
  grantedToolGuidance,
} from "../src/plugins/tools";
import { brokerReturnUrl } from "../src/plugins/broker";
import { createVoiceProvider } from "../src/voice/provider";

// A deliberately non-default brand: copy that still says "OpenBot" or the default name would show
// up here as a leak instead of passing by coincidence.
beforeEach(() => setBrand({ productName: "甲", englishName: "Jia" }));
afterEach(() => resetBrand());

describe("server copy a customer can read takes its name from the brand", () => {
  test("desktop sign-in page names the product in title, heading and status line", async () => {
    const params = new URLSearchParams({
      provider: "google",
      state: "fixture-state-long",
      code_challenge: "a".repeat(43),
      redirect_uri: "http://127.0.0.1:43123/organization-auth/callback",
    });
    const html = await desktopAuthPage(
      new Request(`https://customer.example/api/auth/desktop?${params}`),
      ["google"],
    ).text();
    expect(html).toContain("<title>Sign in to Jia</title>");
    expect(html).toContain("<h1>Sign in to Jia</h1>");
    expect(html).toContain("to return to Jia.");
    expect(html).not.toContain("OpenBot");
  });

  test("a brand name with markup cannot break out of the sign-in page", async () => {
    setBrand({ productName: "甲", englishName: "<b>&" });
    const params = new URLSearchParams({
      provider: "google",
      state: "fixture-state-long",
      code_challenge: "a".repeat(43),
      redirect_uri: "http://127.0.0.1:43123/organization-auth/callback",
    });
    const html = await desktopAuthPage(
      new Request(`https://customer.example/api/auth/desktop?${params}`),
      ["google"],
    ).text();
    expect(html).toContain("<h1>Sign in to &#60;b&#62;&#38;</h1>");
  });

  test("organization sign-in origin refusal", () => {
    expect(() => organizationAuthority("http://customer.example/")).toThrow(
      "Organization sign-in requires an HTTPS Jia origin (HTTP is allowed only on loopback).",
    );
  });

  test("push title, turn failure text, identity sentence and accessibility title", () => {
    expect(defaultPushTitle()).toBe("甲");
    expect(turnFailureMessage()).toBe(
      "Jia could not complete this turn. Try again, or open the conversation in Jia.",
    );
    expect(identityGuidance("Helper")).toStartWith(
      "You are Helper, a Bot in Jia.",
    );
    expect(identityGuidance("Helper")).not.toContain("OpenBot");
    expect(accessibilityTitle()).toBe("甲");
  });

  test("organization sign-in: unreadable authority answer and unknown route", async () => {
    const authority = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ user: null }),
    });
    try {
      const auth = createOrganizationAuth({
        authorityUrl: authority.url.origin,
        materializeUser: async (user) => user,
      });
      const value = Buffer.from(
        JSON.stringify({
          authority: authority.url.origin,
          cookie: "better-auth.session_token=abc",
        }),
      ).toString("base64url");
      await expect(
        auth.verifySessionQuietly(`xiongbao.organization-session=${value}`),
      ).rejects.toThrow(
        "The organization gave an answer Jia could not read. Try again.",
      );
      const response = await auth.handler(
        new Request("https://customer.example/api/auth/no-such-route"),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "Use the Jia organization sign-in screen.",
      });
    } finally {
      authority.stop(true);
    }
  });

  test("connected-app approval guidance sent to the model", () => {
    const text = connectorApprovalGuidance();
    expect(text).toContain("Jia itself asks the person");
    expect(text).toContain("they are asked once, by Jia.");
    expect(text).not.toContain("OpenBot");
    expect(
      grantedToolGuidance([{ name: "mcp__demo__send" }] as never),
    ).toContain(connectorApprovalGuidance());
  });

  test("SMS truncation footer", async () => {
    const bodies: string[] = [];
    const twilio = createTwilioTransport({
      accountSid: "AC1",
      authToken: "secret",
      verifyServiceSid: "VA1",
      from: "+15550000000",
      webhookUrl: "https://o.test/sms",
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        return Response.json({ sid: "SM1", status: "queued" });
      },
    });
    await twilio.send({
      address: "+15551234567",
      text: "x".repeat(1600),
      id: "out1",
    });
    const body = new URLSearchParams(bodies[0]).get("Body") ?? "";
    expect(body.endsWith("\nOpen Jia to read the full message.")).toBe(true);
  });

  test("voice session instructions", async () => {
    let instructions = "";
    const provider = createVoiceProvider(
      {
        provider: "openai-realtime",
        model: "voice-model",
        apiKey: "voice-secret",
        voice: "marin",
      },
      async (_url, init) => {
        const form = init.body as FormData;
        instructions = JSON.parse(String(form.get("session"))).instructions;
        return new Response("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", {
          headers: { "content-type": "application/sdp" },
        });
      },
    );
    await provider.connect({
      sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
      agentName: "Helper",
      userId: "user-1",
      signal: new AbortController().signal,
    });
    expect(instructions).toContain(
      "speaking directly with the user in your Jia channel.",
    );
    expect(instructions).not.toContain("OpenBot");
  });

  test("connection-test probe message", async () => {
    let sent = "";
    await testAgentConnection("http://127.0.0.1:9/", {
      allowPrivateHosts: true,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        sent = String(init?.body);
        return new Response("", { status: 500 });
      }) as unknown as typeof fetch,
    });
    expect(JSON.parse(sent).messages[0].content).toBe(
      "This is an automated connection test from Jia. Reply with one short word.",
    );
  });

  test("broker return-address hint uses a neutral example host", () => {
    let message = "";
    try {
      brokerReturnUrl("openbot-app");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("https://example.com rather than example.com");
    expect(message).not.toContain("openbot.example.com");
  });
});
