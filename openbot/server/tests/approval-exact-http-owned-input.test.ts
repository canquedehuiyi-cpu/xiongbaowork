import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import {
	getOwnedHttpEntryV1,
	preserveExactHttpRunInputV1,
} from "../src/approvals/exact-http-owned-input";

// Definitions only. Native Fetch/streams, no authorization or SDK mocks.
const CAP = 1_048_576;
const URL = "https://example.invalid/internal-run?keep=1";
const INVALID = '{"code":"EXACT_HTTP_INPUT_INVALID"}';
const LARGE = '{"code":"EXACT_HTTP_INPUT_TOO_LARGE"}';
const utf8 = (s: string) => new TextEncoder().encode(s);

function post(body: BodyInit, options: RequestInit = {}): Request {
	// Native Node Fetch needs duplex for stream bodies; it is a structural extra,
	// not a cast or fake Request. Other Fetch implementations may ignore it.
	const duplex: "half" = "half";
	const init = { method: "POST", body, duplex, ...options };
	return new Request(URL, init);
}
function chunks(parts: readonly Uint8Array[], cancelled?: () => void) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
		cancel() { cancelled?.(); },
	});
}
async function rejects(request: Request, status: 400 | 413, secret = "SECRET_SENTINEL") {
	let caught: unknown;
	try { await preserveExactHttpRunInputV1(request); } catch (error) { caught = error; }
	expect(caught).toBeInstanceOf(Response);
	if (!(caught instanceof Response)) throw new Error("missing fixed Response");
	expect(caught.status).toBe(status);
	const body = await caught.text();
	expect(body).toBe(status === 413 ? LARGE : INVALID);
	expect(body.includes(secret)).toBe(false);
	expect(Object.hasOwn(caught, "cause")).toBe(false);
	expect(getOwnedHttpEntryV1(request)).toBeUndefined();
	return caught;
}
function nativeSignal(request: Request): AbortSignal {
	const getter = Object.getOwnPropertyDescriptor(Request.prototype, "signal")?.get;
	if (!getter) throw new Error("missing Fetch signal getter");
	return getter.call(request);
}

test("replay preserves original bytes, whitespace and complete unknown fields", async () => {
	const raw = utf8(' \n{"unknown":{"z":1,"a":[true,null]},"state":null,"forwardedProps":null} \t');
	const request = post(raw);
	const replay = await preserveExactHttpRunInputV1(request);
	expect(new Uint8Array(await replay.arrayBuffer())).toEqual(raw);
	expect(getOwnedHttpEntryV1(replay)).toEqual({
		value: { unknown: { z: 1, a: [true, null] }, state: null, forwardedProps: null },
		rawByteLength: raw.byteLength,
	});
});

test("absent fields remain absent while explicit null remains own and frozen", async () => {
	const a = await preserveExactHttpRunInputV1(post('{"state":null}'));
	const b = await preserveExactHttpRunInputV1(post('{}'));
	const av = getOwnedHttpEntryV1(a)?.value;
	const bv = getOwnedHttpEntryV1(b)?.value;
	expect(av).toEqual({ state: null });
	expect(bv).toEqual({});
	if (av === null || typeof av !== "object" || bv === null || typeof bv !== "object") throw new Error("object expected");
	expect(Object.hasOwn(av, "state")).toBe(true);
	expect(Object.hasOwn(bv, "state")).toBe(false);
	expect(Object.hasOwn(av, "forwardedProps")).toBe(false);
	expect(Object.isFrozen(av)).toBe(true);
	expect(Reflect.set(av, "extra", 1)).toBe(false);
});

test("slot and nested containers are frozen and expose no mutable byte arrays", async () => {
	const replay = await preserveExactHttpRunInputV1(post('{"nested":{"list":[1]}}'));
	const entry = getOwnedHttpEntryV1(replay);
	expect(Object.isFrozen(entry)).toBe(true);
	expect(entry && Object.keys(entry).sort()).toEqual(["rawByteLength", "value"]);
	const value = entry?.value;
	if (value === null || typeof value !== "object") throw new Error("object expected");
	const nested = Object.getOwnPropertyDescriptor(value, "nested")?.value;
	expect(Object.isFrozen(nested)).toBe(true);
	expect(Object.isFrozen(Object.getOwnPropertyDescriptor(nested, "list")?.value)).toBe(true);
});

test("only exact returned Request receives slot; original, clone and reconstruction do not", async () => {
	const original = post('{"x":1}');
	const replay = await preserveExactHttpRunInputV1(original);
	expect(getOwnedHttpEntryV1(original)).toBeUndefined();
	expect(getOwnedHttpEntryV1(replay)).toBeDefined();
	expect(getOwnedHttpEntryV1(replay.clone())).toBeUndefined();
	expect(getOwnedHttpEntryV1(new Request(replay))).toBeUndefined();
});

test("native URL, method, headers and Fetch/session fields survive replay", async () => {
	const request = post('{}', {
		headers: { authorization: "session-secret", "x-custom": "opaque", "content-type": "application/json" },
		credentials: "include", cache: "no-store", redirect: "manual",
		referrer: "https://example.invalid/origin", referrerPolicy: "no-referrer",
		integrity: "", keepalive: false, mode: "cors",
	});
	const replay = await preserveExactHttpRunInputV1(request);
	for (const key of ["url", "method", "credentials", "cache", "redirect", "referrer", "referrerPolicy", "integrity", "keepalive", "mode"] as const) expect(replay[key]).toBe(request[key]);
	expect([...replay.headers]).toEqual([...request.headers]);
});

test("returned signal follows later abort without granting new slot identities", async () => {
	const controller = new AbortController();
	const replay = await preserveExactHttpRunInputV1(post('{}', { signal: controller.signal }));
	expect(replay.signal.aborted).toBe(false);
	controller.abort("SECRET_SENTINEL");
	expect(replay.signal.aborted).toBe(true);
	expect(getOwnedHttpEntryV1(replay)?.value).toEqual({});
});

test("captured native getters ignore request shadow getters and clone/json/text overrides", async () => {
	const request = post('{}');
	let calls = 0;
	for (const key of ["url", "method", "headers", "signal", "body", "clone", "json", "text"]) Object.defineProperty(request, key, { get() { calls++; throw new Error("SECRET_SENTINEL"); } });
	const replay = await preserveExactHttpRunInputV1(request);
	expect(calls).toBe(0);
	expect(await replay.text()).toBe('{}');
});

test("fake Request with adversarial getters is refused without reading them", async () => {
	let calls = 0;
	const fake = Object.create(null);
	for (const key of ["method", "url", "headers", "body", "signal"]) Object.defineProperty(fake, key, { get() { calls++; throw new Error("SECRET_SENTINEL"); } });
	let caught: unknown;
	try { await Reflect.apply(preserveExactHttpRunInputV1, undefined, [fake]); } catch (error) { caught = error; }
	expect(caught).toBeInstanceOf(Response);
	if (!(caught instanceof Response)) throw new Error("missing response");
	expect(caught.status).toBe(400);
	expect(await caught.text()).toBe(INVALID);
	expect(calls).toBe(0);
	expect(Reflect.apply(getOwnedHttpEntryV1, undefined, [fake])).toBeUndefined();
});

test("non POST is fixed400 and never receives a slot", async () => {
	await rejects(new Request(URL), 400);
	await rejects(new Request(URL, { method: "PUT", body: '{}' }), 400);
});

test("null body and empty EOF both reject, not an invented empty object", async () => {
	await rejects(new Request(URL, { method: "POST" }), 400);
	const stream = chunks([]);
	await rejects(post(stream), 400);
	expect(stream.locked).toBe(false);
});

test("exact1MiB whitespace plus null is accepted without string or node budget interference", async () => {
	const raw = utf8(' '.repeat(CAP - 4) + 'null');
	const replay = await preserveExactHttpRunInputV1(post(raw));
	expect(getOwnedHttpEntryV1(replay)).toEqual({ value: null, rawByteLength: CAP });
	expect(new Uint8Array(await replay.arrayBuffer())).toEqual(raw);
});

test("cap plus one is413 even when all JSON payload semantics remain tiny", async () => {
	await rejects(post(' '.repeat(CAP - 3) + 'null'), 413);
});

test("large single chunk rejects413, actively cancels an open stream and unlocks", async () => {
	let cancelled = 0;
	const stream = new ReadableStream<Uint8Array>({
		start(c) { c.enqueue(utf8(' '.repeat(CAP * 2) + 'null')); },
		cancel() { cancelled++; },
	});
	await rejects(post(stream), 413);
	expect(cancelled).toBe(1);
	expect(stream.locked).toBe(false);
});

test("chunk segmentation and empty chunks cannot change the exact raw replay", async () => {
	const parts = [utf8(''), utf8('{"熊":'), utf8('[1,'), utf8('null]}'), utf8('')];
	const stream = chunks(parts);
	const replay = await preserveExactHttpRunInputV1(post(stream));
	expect(await replay.text()).toBe('{"熊":[1,null]}');
	expect(getOwnedHttpEntryV1(replay)?.value).toEqual({ 熊: [1, null] });
	expect(stream.locked).toBe(false);
});

test("a small Content-Length does not bypass actual total byte cap", async () => {
	await rejects(post(' '.repeat(CAP - 3) + 'null', { headers: { "content-length": "1" } }), 413);
});

test("wellformed decimal oversize Content-Length early rejects and cancels", async () => {
	for (const length of [String(CAP + 1), "0001048577", "9".repeat(80)]) {
		let cancelled = 0;
		const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
		await rejects(post(stream, { headers: { "content-length": length } }), 413);
		expect(cancelled).toBe(1);
		expect(stream.locked).toBe(false);
	}
});

test("absent, equal, zero-padded and malformed Content-Length do not define reserve or parsed value", async () => {
	for (const headers of [{}, { "content-length": "4" }, { "content-length": "0004" }, { "content-length": "1e20" }]) {
		const replay = await preserveExactHttpRunInputV1(post('null', { headers }));
		expect(getOwnedHttpEntryV1(replay)).toEqual({ value: null, rawByteLength: 4 });
	}
});

test("strict UTF8 rejects overlong, truncated and stray continuation bytes", async () => {
	for (const raw of [new Uint8Array([0x22, 0xc0, 0xaf, 0x22]), new Uint8Array([0x22, 0xe7, 0x22]), new Uint8Array([0x22, 0x80, 0x22])]) await rejects(post(raw), 400);
});

test("multibyte UTF8 can span HTTP chunks without re-decoding or replacement", async () => {
	const replay = await preserveExactHttpRunInputV1(post(chunks([
		new Uint8Array([0x22, 0xe7]), new Uint8Array([0x86]), new Uint8Array([0x8a, 0x22]),
	])));
	expect(getOwnedHttpEntryV1(replay)?.value).toBe("熊");
	expect(new Uint8Array(await replay.arrayBuffer())).toEqual(new Uint8Array([0x22, 0xe7, 0x86, 0x8a, 0x22]));
});

test("duplicate keys, unsafe integer, negative zero and non JSON cannot become eligible by stripping", async () => {
	for (const raw of ['{"x":1,"x":2}', '{"x":9007199254740992}', '-0', '{"x":undefined}', 'null trailing', '{']) await rejects(post(raw), 400);
});

test("read failure is sanitized, unlocks and removes helper listener even without abort", async () => {
	const controller = new AbortController();
	const stream = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("SECRET_SENTINEL")); } });
	const request = post(stream, { signal: controller.signal });
	const signal = nativeSignal(request);
	const before = getEventListeners(signal, "abort");
	await rejects(request, 400);
	expect(stream.locked).toBe(false);
	expect(getEventListeners(signal, "abort")).toEqual(before);
});

test("pending read abort settles, actively cancels, releases and leaves no entry", async () => {
	const controller = new AbortController();
	let entered: (() => void) | undefined;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	let cancelled = 0;
	const stream = new ReadableStream<Uint8Array>({ pull() { entered?.(); }, cancel() { cancelled++; } });
	const request = post(stream, { signal: controller.signal });
	const pending = rejects(request, 400);
	await ready;
	controller.abort("SECRET_SENTINEL");
	await pending;
	expect(cancelled).toBe(1);
	expect(stream.locked).toBe(false);
	expect(getEventListeners(nativeSignal(request), "abort")).toEqual([]);
});

test("abort does not await a never settling underlying cancel promise", async () => {
	const controller = new AbortController();
	let entered: (() => void) | undefined;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	let cancelled = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull() { entered?.(); },
		cancel() { cancelled++; return new Promise<void>(() => undefined); },
	});
	const request = post(stream, { signal: controller.signal });
	const pending = rejects(request, 400);
	await ready;
	controller.abort();
	await pending;
	expect(cancelled).toBe(1);
	expect(stream.locked).toBe(false);
});

test("already aborted and partial-body then abort never create a successful empty slot", async () => {
	const stopped = new AbortController(); stopped.abort("SECRET_SENTINEL");
	const first = post('{}', { signal: stopped.signal });
	await rejects(first, 400);
	const controller = new AbortController();
	let queued: (() => void) | undefined;
	const ready = new Promise<void>((resolve) => { queued = resolve; });
	let count = 0;
	const stream = new ReadableStream<Uint8Array>({ pull(c) { if (count++ === 0) c.enqueue(utf8('{"x":')); else queued?.(); } });
	const request = post(stream, { signal: controller.signal });
	const pending = rejects(request, 400);
	await ready;
	controller.abort();
	await pending;
	expect(stream.locked).toBe(false);
});

test("already locked stream is refused without releasing somebody elses reader", async () => {
	const stream = chunks([utf8('{}')]);
	const request = post(stream);
	const owner = stream.getReader();
	await rejects(request, 400);
	expect(stream.locked).toBe(true);
	owner.releaseLock();
});

test("non Uint8Array stream chunk is a fixed400 not a string coercion", async () => {
	const stream = new ReadableStream<string>({ start(c) { c.enqueue("SECRET_SENTINEL"); c.close(); } });
	await rejects(post(stream), 400);
	expect(stream.locked).toBe(false);
});

test("unsupported native keepalive stays absent and caller shadow getters are never read", async () => {
	const request = post("null", { keepalive: false });
	const native = Object.getOwnPropertyDescriptor(Request.prototype, "keepalive");
	expect(native === undefined || typeof native.get === "function").toBe(true);
	const nativeValue = native?.get?.call(request);
	let traps = 0;
	Object.defineProperty(request, "keepalive", {
		get() { traps++; throw new Error("SECRET_SENTINEL"); },
	});
	const replay = await preserveExactHttpRunInputV1(request);
	expect(traps).toBe(0);
	if (native?.get) expect(native.get.call(replay)).toBe(nativeValue);
	else expect(Object.hasOwn(replay, "keepalive")).toBe(false);
	expect(getOwnedHttpEntryV1(replay)?.value).toBe(null);
});
