import {
	materializeExactJsonBytesV1,
	type FrozenJsonValue,
} from "./exact-input-json-materializer";

/** Internal data provenance only: not authentication, registration or permission. */
export type OwnedHttpEntryV1 = Readonly<{
	value: FrozenJsonValue;
	rawByteLength: number;
}>;

const CAP = 1_048_576;
const INVALID = Symbol("invalid exact HTTP input");
const OVERSIZE = Symbol("oversize exact HTTP input");
const entries = new WeakMap<Request, OwnedHttpEntryV1>();
// Trusted, unmodified realm intrinsics are a precondition. Never read caller
// shadow properties, use clone/json/text, or inspect an arbitrary unknown tree.
const NativeRequest = Request;
const NativeResponse = Response;
const NativeHeaders = Headers;
const requestGetters = Object.getOwnPropertyDescriptors(Request.prototype);
const headersGet = Headers.prototype.get;
const headersEach = Headers.prototype.forEach;
const headersSet = Headers.prototype.set;
const getReader: (this: ReadableStream<Uint8Array>) => ReadableStreamDefaultReader<Uint8Array> = ReadableStream.prototype.getReader;
const readerRead = ReadableStreamDefaultReader.prototype.read;
const readerCancel = ReadableStreamDefaultReader.prototype.cancel;
const readerRelease = ReadableStreamDefaultReader.prototype.releaseLock;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const isView = ArrayBuffer.isView;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag)?.get;
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, "buffer")?.get;
const typedOffset = Object.getOwnPropertyDescriptor(typedPrototype, "byteOffset")?.get;
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, "byteLength")?.get;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const bufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const nativeSet = Uint8Array.prototype.set;

function field(request: Request, key: string): unknown {
	const getter = requestGetters[key]?.get;
	if (!getter) throw INVALID;
	return getter.call(request); // Native brand check; never request[key].
}

function isAborted(signal: AbortSignal): boolean {
	if (!signalAborted) throw INVALID;
	return signalAborted.call(signal) === true;
}

function snapshot(request: Request) {
	const method = field(request, "method");
	if (method !== "POST") throw INVALID;
	const url = field(request, "url");
	const headers = field(request, "headers");
	const signal = field(request, "signal");
	const body = field(request, "body");
	const credentials = field(request, "credentials");
	const cache = field(request, "cache");
	const redirect = field(request, "redirect");
	const referrer = field(request, "referrer");
	const referrerPolicy = field(request, "referrerPolicy");
	const integrity = field(request, "integrity");
	const keepalive = field(request, "keepalive");
	const mode = field(request, "mode");
	// These are native getter results. Explicit checks narrow actual Fetch types
// without casting an unknown caller into a Request/Headers/signal/stream.
	if (typeof url !== "string" || !(headers instanceof NativeHeaders)
		|| !(signal instanceof AbortSignal) || !(body instanceof ReadableStream)
		|| (credentials !== "omit" && credentials !== "same-origin" && credentials !== "include")
		|| (cache !== "default" && cache !== "no-store" && cache !== "reload" && cache !== "no-cache" && cache !== "force-cache" && cache !== "only-if-cached")
		|| (redirect !== "follow" && redirect !== "error" && redirect !== "manual")
		|| typeof referrer !== "string" || typeof integrity !== "string" || typeof keepalive !== "boolean"
		|| (referrerPolicy !== "" && referrerPolicy !== "no-referrer" && referrerPolicy !== "no-referrer-when-downgrade" && referrerPolicy !== "origin" && referrerPolicy !== "origin-when-cross-origin" && referrerPolicy !== "same-origin" && referrerPolicy !== "strict-origin" && referrerPolicy !== "strict-origin-when-cross-origin" && referrerPolicy !== "unsafe-url")
		|| (mode !== "cors" && mode !== "same-origin" && mode !== "no-cors")) throw INVALID;
	const ownedHeaders = new NativeHeaders();
	headersEach.call(headers, (value: string, key: string) => headersSet.call(ownedHeaders, key, value));
	return { method, url, headers: ownedHeaders, signal, body, credentials, cache,
		redirect, referrer, referrerPolicy, integrity, keepalive, mode };
}

function exceedsDeclaredCap(headers: Headers): boolean {
	const value = headersGet.call(headers, "content-length");
	if (value === null || !/^[0-9]+$/.test(value)) return false;
	const digits = value.replace(/^0+/, "") || "0";
	const cap = String(CAP);
	return digits.length > cap.length || (digits.length === cap.length && digits > cap);
}

function visibleChunk(value: Uint8Array): Uint8Array<ArrayBuffer> {
	if (!isView(value) || !typedTag || !typedBuffer || !typedOffset || !typedLength || !bufferLength) throw INVALID;
	if (typedTag.call(value) !== "Uint8Array") throw INVALID;
	const buffer: ArrayBuffer = typedBuffer.call(value);
	const offset: number = typedOffset.call(value);
	const size: number = typedLength.call(value);
	const capacity: number = bufferLength.call(buffer); // Reject SharedArrayBuffer.
	if (bufferResizable?.call(buffer) === true || !Number.isSafeInteger(offset)
		|| !Number.isSafeInteger(size) || !Number.isSafeInteger(capacity)
		|| offset < 0 || size < 0 || size > capacity || offset > capacity - size) throw INVALID;
	return new Uint8Array(buffer, offset, size); // Also rejects detached buffers.
}

function refusal(status: 400 | 413): Response {
	return new NativeResponse(status === 413
		? '{"code":"EXACT_HTTP_INPUT_TOO_LARGE"}'
		: '{"code":"EXACT_HTTP_INPUT_INVALID"}', {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Future trusted caller selects the real platform POST run request/route.
 * Not wired to HTTP. MAT1 must be integrated before a consumer imports this.
 * The collector retains at most CAP+1 raw bytes. Network chunks, MAT1's owned
 * copy/canonical output and Fetch's replay storage have their own allocations;
 * this is NOT a total runtime/transport peak-memory claim.
 */
export async function preserveExactHttpRunInputV1(request: Request): Promise<Request> {
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let signal: AbortSignal | undefined;
	let listening = false;
	let failure: 400 | 413 | undefined;
	let output: Request | undefined;
	let entry: OwnedHttpEntryV1 | undefined;
	let rejectAbort: ((reason: unknown) => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
	// An already-aborted request can reject before the first race is awaited.
	void aborted.catch(() => undefined);
	const onAbort = () => rejectAbort?.(INVALID);
	try {
		const source = snapshot(request);
		signal = source.signal;
		reader = getReader.call(source.body);
		addListener.call(signal, "abort", onAbort, { once: true });
		listening = true;
		if (isAborted(signal)) throw INVALID;
		if (exceedsDeclaredCap(source.headers)) throw OVERSIZE;
		const storage = new Uint8Array(CAP + 1);
		let used = 0;
		while (true) {
			if (isAborted(signal)) throw INVALID;
			const next: ReadableStreamReadResult<Uint8Array> = await Promise.race([
				readerRead.call(reader), aborted,
			]);
			if (isAborted(signal)) throw INVALID;
			if (next.done) break;
			const chunk = visibleChunk(next.value);
			if (chunk.byteLength > CAP - used) throw OVERSIZE;
			nativeSet.call(storage, chunk, used);
			used += chunk.byteLength;
		}
		const raw = storage.subarray(0, used);
		const materialized = materializeExactJsonBytesV1(raw);
		if (isAborted(signal)) throw INVALID;
		output = new NativeRequest(source.url, {
			method: source.method, headers: source.headers, body: raw, signal,
			credentials: source.credentials, cache: source.cache, redirect: source.redirect,
			referrer: source.referrer, referrerPolicy: source.referrerPolicy,
			integrity: source.integrity, keepalive: source.keepalive, mode: source.mode,
		});
		entry = Object.freeze({ value: materialized.value, rawByteLength: used });
	} catch (error) {
		failure = error === OVERSIZE ? 413 : 400;
	} finally {
		if (reader) {
			if (failure !== undefined) {
				try {
					// Invoke cancel now, but do not let a hostile never-settling
					// underlying cancel promise prevent abort from completing.
					void readerCancel.call(reader).catch(() => undefined);
				} catch { failure = failure ?? 400; }
			}
			try { readerRelease.call(reader); } catch { failure = 400; }
		}
		if (signal && listening) {
			try { removeListener.call(signal, "abort", onAbort); } catch { failure = 400; }
		}
	}
	if (failure !== undefined) throw refusal(failure);
	if (!output || !entry || !signal || isAborted(signal)) throw refusal(400);
	entries.set(output, entry); // Commit slot only after EOF, validation and cleanup.
	return output;
}

/** Exact returned-object identity only. Clones/copies never inherit a slot. */
export function getOwnedHttpEntryV1(request: Request): OwnedHttpEntryV1 | undefined {
	return entries.get(request);
}
