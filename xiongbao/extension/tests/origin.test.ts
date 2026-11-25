import { expect, test } from "bun:test";
import {
  isAllowedGatewayUrl,
  isRecordablePage,
  normaliseXiongBaoOrigin,
} from "../src/shared/origin";

test("accepts an HTTPS origin, with or without the trailing slash", () => {
  expect(normaliseXiongBaoOrigin("https://xiongbao.example.test")).toEqual({
    ok: true,
    origin: "https://xiongbao.example.test",
  });
  expect(normaliseXiongBaoOrigin("https://xiongbao.example.test/")).toEqual({
    ok: true,
    origin: "https://xiongbao.example.test",
  });
});

test("accepts HTTP only on a loopback address with a port", () => {
  expect(normaliseXiongBaoOrigin("http://127.0.0.1:7470")).toEqual({
    ok: true,
    origin: "http://127.0.0.1:7470",
  });
  expect(normaliseXiongBaoOrigin("http://[::1]:7470")).toEqual({
    ok: true,
    origin: "http://[::1]:7470",
  });
  expect(normaliseXiongBaoOrigin("http://127.0.0.1").ok).toBe(false);
});

test("refuses HTTP to any other host and says HTTPS is needed", () => {
  const result = normaliseXiongBaoOrigin("http://xiongbao.example.test");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("HTTPS");
  expect(normaliseXiongBaoOrigin("http://localhost:3000").ok).toBe(false);
});

test("refuses userinfo, a path, a query, garbage and other schemes", () => {
  expect(normaliseXiongBaoOrigin("https://u:p@x.test").ok).toBe(false);
  expect(normaliseXiongBaoOrigin("https://x.test/app?y=1").ok).toBe(false);
  expect(normaliseXiongBaoOrigin("https://x.test/app").ok).toBe(false);
  expect(normaliseXiongBaoOrigin("https://x.test/#frag").ok).toBe(false);
  expect(normaliseXiongBaoOrigin("not a url").ok).toBe(false);
  expect(normaliseXiongBaoOrigin("ftp://x.test").ok).toBe(false);
});

test("gateway URLs need WSS except on the loopback address", () => {
  expect(isAllowedGatewayUrl("wss://gw.example.test/client", null)).toBe(true);
  expect(isAllowedGatewayUrl("ws://127.0.0.1:7453/client", null)).toBe(true);
  expect(isAllowedGatewayUrl("ws://gw.example.test/client", null)).toBe(false);
  expect(isAllowedGatewayUrl("https://gw.example.test/client", null)).toBe(
    false,
  );
  expect(isAllowedGatewayUrl("nonsense", null)).toBe(false);
});

test("an allow list pins the gateway's origin", () => {
  const allowed = ["wss://gw.example.test"];
  expect(isAllowedGatewayUrl("wss://evil.test/client", allowed)).toBe(false);
  expect(isAllowedGatewayUrl("wss://gw.example.test/client", allowed)).toBe(
    true,
  );
  expect(isAllowedGatewayUrl("wss://gw.example.test/client", [])).toBe(false);
});

test("only http and https pages are recordable", () => {
  expect(isRecordablePage("https://x.test")).toBe(true);
  expect(isRecordablePage("http://x.test/a")).toBe(true);
  expect(isRecordablePage("chrome://newtab/")).toBe(false);
  expect(isRecordablePage("https://chromewebstore.google.com/")).toBe(false);
  expect(
    isRecordablePage("https://microsoftedge.microsoft.com/addons/detail/x"),
  ).toBe(false);
  expect(isRecordablePage("https://chrome.google.com/webstore/detail/x")).toBe(
    false,
  );
  expect(isRecordablePage("https://chrome.google.com/search")).toBe(true);
  expect(isRecordablePage("chrome-extension://abc/popup.html")).toBe(false);
  expect(isRecordablePage(undefined)).toBe(false);
  expect(isRecordablePage("")).toBe(false);
});
