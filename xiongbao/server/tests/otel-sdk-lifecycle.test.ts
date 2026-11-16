import { expect, test } from "bun:test";

// Real SDK integration, isolated from the all-SDK-mock wiring suite. No OTLP
// records are sent: only the in-process fake exporter receives emitted logs.
const target = new URL("../src/telemetry/otel.ts", import.meta.url).pathname;
const setup = `
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
let networkAttempts = 0;
const deny = () => { networkAttempts++; throw new Error("C2-SDK network forbidden"); };
http.request = deny; http.get = deny; https.request = deny; https.get = deny;
net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny;
tls.connect = deny; dns.lookup = deny; dns.resolve = deny;
dns.promises.lookup = deny; dns.promises.resolve = deny;
syncBuiltinESMExports();
globalThis.fetch = deny; Bun.connect = deny; Bun.listen = deny; Bun.serve = deny;
const { LoggerProvider, BatchLogRecordProcessor } = await import("@opentelemetry/sdk-logs");
const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-http");
const { createOtelEventExporter } = await import(${JSON.stringify(target)});
`;

function isolated(body: string) {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--no-env-file",
      "--config=/dev/null",
      "-e",
      `${setup}\n${body}\nassert.equal(networkAttempts, 0); console.log("CPU_ONLY_NO_NETWORK_ATTEMPTS");`,
    ],
    cwd: new URL("..", import.meta.url).pathname,
    env: { HOME: "/nonexistent-c2-sdk-home", TZ: "UTC" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toContain(
    "CPU_ONLY_NO_NETWORK_ATTEMPTS",
  );
}

test("real SDK: emit, explicit flush, shutdown drain and once-only exporter shutdown", () =>
  isolated(`
const records = []; const order = []; let shutdowns = 0;
const sink = {
  export(batch, callback) { records.push(...batch); order.push("export"); callback({code: 0}); },
  forceFlush() { order.push("flush"); return Promise.resolve(); },
  shutdown() { shutdowns++; order.push("shutdown"); return Promise.resolve(); }
};
const processor = new BatchLogRecordProcessor({exporter: sink, scheduledDelayMillis: 60000});
const provider = new LoggerProvider({processors: [processor]});
const logger = provider.getLogger("c2.cpu");
try {
  logger.emit({body: "before-flush"});
  await provider.forceFlush();
  assert.deepEqual(records.map(x => x.body), ["before-flush"]);
  logger.emit({body: "before-shutdown"});
  await provider.shutdown();
  await provider.shutdown();
  assert.deepEqual(records.map(x => x.body), ["before-flush", "before-shutdown"]);
  assert.equal(shutdowns, 1);
  assert.equal(order.at(-1), "shutdown");
  logger.emit({body: "after-shutdown"});
  assert.equal(records.length, 2);
} finally { await provider.shutdown(); }
`));

test("real SDK: shutdown rejection propagates, without invoking sink shutdown twice", () =>
  isolated(`
const failure = new Error("fixture shutdown rejection"); let shutdowns = 0;
const sink = {
  export(batch, callback) { callback({code: 0}); },
  forceFlush() { return Promise.resolve(); },
  shutdown() { shutdowns++; return Promise.reject(failure); }
};
const provider = new LoggerProvider({processors: [new BatchLogRecordProcessor({exporter: sink})]});
await assert.rejects(provider.shutdown(), /fixture shutdown rejection/);
await assert.rejects(provider.shutdown(), /fixture shutdown rejection/);
assert.equal(shutdowns, 1);
`));

test("real OTLP exporter: inherited methods and no-header idle flush/shutdown remain offline", () =>
  isolated(`
const exporter = new OTLPLogExporter({url: "http://127.0.0.1:1/v1/logs"});
assert.equal(typeof exporter.export, "function");
assert.equal(typeof exporter.forceFlush, "function");
assert.equal(typeof exporter.shutdown, "function");
await exporter.forceFlush(); await exporter.shutdown();
`));

test("real production wrapper: off/absent config and enabled idle shutdown without headers", () =>
  isolated(`
assert.equal(createOtelEventExporter({}), undefined);
assert.equal(createOtelEventExporter({OPENBOT_OTEL_EXPORT: " OFF ", OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1"}), undefined);
const api = createOtelEventExporter({OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1"});
assert.ok(api); await api.shutdown();
`));

test("real production wrapper: malformed headers and invalid endpoint construction reject offline", () =>
  isolated(`
assert.throws(() => createOtelEventExporter({OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1", OTEL_EXPORTER_OTLP_HEADERS: "x-fixture=%ZZ"}), URIError);
assert.throws(() => createOtelEventExporter({OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "not a valid URL"}));
`));
