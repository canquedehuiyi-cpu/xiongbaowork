import { expect, test } from "bun:test";

// Wiring/unit only. Run this file alone in a fresh Bun process, never the whole
// integration suite. Each case imports production source in its own child with
// an allowlisted environment, no .env loading, and all SDK modules mocked BEFORE
// import. No collector, provider, credentials, database or network is required.
const target = new URL("../src/telemetry/otel.ts", import.meta.url).pathname;
const setup = `
import { mock } from "bun:test";
import assert from "node:assert/strict";
const deny = () => { throw new Error("C2 network forbidden"); };
globalThis.fetch = deny;
Bun.connect = deny; Bun.listen = deny; Bun.serve = deny;
for (const name of ["http", "https", "net", "tls", "dns"]) {
  const blocked = { request: deny, get: deny, connect: deny,
    createConnection: deny, createServer: deny, lookup: deny, resolve: deny };
  mock.module(name, () => blocked);
  mock.module("node:" + name, () => blocked);
}
const state = { exporters: [], processors: [], providers: [], events: [],
  errors: [], shutdown: 0, flush: 0, failEmit: false,
  failConstruct: false, rejectShutdown: false };
console.error = (...args) => state.errors.push(args);
mock.module("@opentelemetry/api-logs", () => ({ SeverityNumber: { INFO: 9, WARN: 13 } }));
mock.module("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: class { constructor(config) {
    if (state.failConstruct) throw new Error("fixture construction failed");
    this.config = config; state.exporters.push(this);
  } }
}));
mock.module("@opentelemetry/resources", () => ({ resourceFromAttributes: attributes => ({ attributes }) }));
mock.module("@opentelemetry/sdk-logs", () => ({
  BatchLogRecordProcessor: class { constructor(config) {
    this.config = config; state.processors.push(this);
  } },
  LoggerProvider: class { constructor(config) { state.providers.push(config); }
    getLogger(name) { assert.equal(name, "openbot.audit"); return { emit(event) {
      if (state.failEmit) throw new Error("fixture emit failed");
      state.events.push(event);
    } }; }
    forceFlush() { state.flush++; return Promise.resolve(); }
    shutdown() { state.shutdown++;
      return state.rejectShutdown ? Promise.reject(new Error("fixture shutdown failed")) : Promise.resolve();
    }
  }
}));
const { createOtelEventExporter, otelConfigured } = await import(${JSON.stringify(target)});
const endpoint = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://collector.invalid/v1/logs" };
const event = { eventType: "computer.action_failed", targetType: "computer",
  initiatorKind: "person", payload: { command: "export API_TOKEN=fixture-only" } };
`;

function isolated(body: string) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--no-env-file", "--config=/dev/null", "-e", setup + body],
    cwd: import.meta.dir,
    env: { TZ: "UTC", HOME: "/nonexistent-c2-no-user-config" },
    stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
}

test("wiring/unit: off and absent/blank endpoints construct no SDK objects", () => isolated(`
for (const env of [{}, { OTEL_EXPORTER_OTLP_ENDPOINT: "  " },
  { ...endpoint, OPENBOT_OTEL_EXPORT: " OFF " }]) {
  assert.equal(otelConfigured(env), false);
  assert.equal(createOtelEventExporter(env), undefined);
}
assert.equal(state.exporters.length, 0); assert.equal(state.providers.length, 0);
`));

test("wiring/unit: enabled configuration connects exporter, batch processor and provider", () => isolated(`
const api = createOtelEventExporter({ ...endpoint, OTEL_EXPORTER_OTLP_ENDPOINT: "https://unused.invalid",
  OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-fixture=a%20b", OTEL_SERVICE_NAME: " fixture " });
assert.ok(api); assert.equal(state.exporters[0].config.url, endpoint.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT);
assert.deepEqual(state.exporters[0].config.headers, { "x-fixture": "a b" });
assert.equal(state.exporters[0].config.timeoutMillis, 10000);
assert.equal(state.processors[0].config.exporter, state.exporters[0]);
assert.equal(state.providers[0].processors[0], state.processors[0]);
assert.equal(state.providers[0].resource.attributes["service.name"], "fixture");
await api.shutdown(); assert.equal(state.shutdown, 1);
`));

test("wiring/unit: generic endpoint and headers use documented fallback", () => isolated(`
const api = createOtelEventExporter({ OTEL_EXPORTER_OTLP_ENDPOINT: " https://collector.invalid/ ",
  OTEL_EXPORTER_OTLP_HEADERS: "x-fixture=fallback" });
assert.equal(state.exporters[0].config.url, "https://collector.invalid/v1/logs");
assert.deepEqual(state.exporters[0].config.headers, { "x-fixture": "fallback" });
assert.equal(state.providers[0].resource.attributes["service.name"], "openbot");
await api.shutdown();
`));

test("wiring/unit: emit scrubs payload, classifies warnings and contains synchronous failures", () => isolated(`
const api = createOtelEventExporter(endpoint); api.emit(event);
assert.equal(state.events[0].severityNumber, 13);
assert.equal(state.events[0].attributes["openbot.surface"], "bot");
assert.equal(state.events[0].attributes["openbot.payload.command"], "export API_TOKEN=[REDACTED]");
state.failEmit = true; assert.doesNotThrow(() => api.emit(event));
assert.equal(JSON.parse(state.errors[0][0]).type, "otel-export-failed");
await api.shutdown();
`));

test("wiring/unit: shutdown delegates and propagates rejection; wrapper exposes no forceFlush", () => isolated(`
const api = createOtelEventExporter(endpoint);
assert.equal("forceFlush" in api, false);
state.rejectShutdown = true;
await assert.rejects(api.shutdown(), /fixture shutdown failed/);
assert.equal(state.shutdown, 1); assert.equal(state.flush, 0);
`));

test("wiring/unit: enabled construction and malformed header failures propagate", () => isolated(`
assert.throws(() => createOtelEventExporter({ ...endpoint,
  OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-fixture=%ZZ" }), URIError);
state.failConstruct = true;
assert.throws(() => createOtelEventExporter(endpoint), /fixture construction failed/);
`));
