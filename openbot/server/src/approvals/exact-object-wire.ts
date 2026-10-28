import { EXACT_OBJECT_AEAD_VERSION, type Envelope } from "./exact-object-crypto";

export const EXACT_OBJECT_WIRE_VERSION = "OPENBOT_APPROVAL_EXACT_WIRE_V1";
export const EXACT_OBJECT_WIRE_HEADER_BYTES = EXACT_OBJECT_WIRE_VERSION.length + 1 + 12 + 4;
export const EXACT_OBJECT_WIRE_MAX_BYTES = EXACT_OBJECT_WIRE_HEADER_BYTES + 1_048_592;
const MIN_CIPHER_BYTES = 17;
const MAX_CIPHER_BYTES = 1_048_592;

/**
 * Internal binary conversion, not authentication, decryption or scope admission.
 * Trusted upstream non-Proxy materialization must bound envelope construction
 * BEFORE growth to <=5 ALL own keys (including nonenumerable/Symbol keys).
 * Valid shape is still exactly four fields. Reflect.ownKeys allocates the full
 * snapshot before shape checks; TS/ordinary/non-Proxy alone provides no bound.
 * Actual production materializer is UNIMPLEMENTED; no business wiring or token
 * is supplied. Typed bytes also come from trusted ordinary non-Proxy inputs;
 * this is not an arbitrary-JS sandbox or a JSON/base64/legacy-sniffing parser.
 */
function fail(): never {
	const error = new Error("Exact object wire rejected");
	error.name = "ExactObjectWireError";
	throw error;
}

function snapshot(value: unknown, minimum: number, maximum: number): Uint8Array {
	if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) fail();
	const prototype = Object.getPrototypeOf(Uint8Array.prototype);
	const bufferGetter = Object.getOwnPropertyDescriptor(prototype, "buffer")?.get;
	const offsetGetter = Object.getOwnPropertyDescriptor(prototype, "byteOffset")?.get;
	const lengthGetter = Object.getOwnPropertyDescriptor(prototype, "byteLength")?.get;
	if (!bufferGetter || !offsetGetter || !lengthGetter) fail();
	const buffer = bufferGetter.call(value);
	const offset = offsetGetter.call(value);
	const length = lengthGetter.call(value);
	if (!(buffer instanceof ArrayBuffer)) fail();
	const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
	if (resizable?.call(buffer) === true) fail();
	const bufferLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
	if (!bufferLengthGetter) fail();
	const bufferLength = bufferLengthGetter.call(buffer);
	if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || typeof length !== "number" || !Number.isSafeInteger(length) || length < minimum || length > maximum || typeof bufferLength !== "number" || offset > bufferLength || length > bufferLength - offset) fail();
	// Detached backing buffers reject even a zero-length native view.
	new Uint8Array(buffer, 0, 0);
	// Bounds are checked before this owned allocation; native metadata ignores
	// shadow getters on the caller view. Copy only its exact visible byte range.
	const result = new Uint8Array(new ArrayBuffer(length));
	result.set(new Uint8Array(buffer, offset, length));
	return result;
}

export function encodeExactObjectWireV1(envelope: Envelope): Uint8Array {
	try {
		if (!envelope || (Object.getPrototypeOf(envelope) !== Object.prototype && Object.getPrototypeOf(envelope) !== null)) fail();
		const keys = Reflect.ownKeys(envelope);
		if (keys.length !== 4) fail();
		const fields = new Map<string, unknown>();
		for (const key of keys) {
			if (typeof key !== "string" || !["version", "algorithm", "nonce", "ciphertextAndTag"].includes(key)) fail();
			const descriptor = Object.getOwnPropertyDescriptor(envelope, key);
			if (!descriptor) fail();
			if (!descriptor.enumerable || !("value" in descriptor)) fail();
			fields.set(key, descriptor.value);
		}
		if (fields.get("version") !== EXACT_OBJECT_AEAD_VERSION || fields.get("algorithm") !== "AES-256-GCM") fail();
		const nonce = snapshot(fields.get("nonce"), 12, 12);
		const cipher = snapshot(fields.get("ciphertextAndTag"), MIN_CIPHER_BYTES, MAX_CIPHER_BYTES);
		const total = EXACT_OBJECT_WIRE_HEADER_BYTES + cipher.byteLength;
		if (!Number.isSafeInteger(total) || total > EXACT_OBJECT_WIRE_MAX_BYTES) fail();
		const buffer = new ArrayBuffer(total);
		const wire = new Uint8Array(buffer);
		for (let i = 0; i < EXACT_OBJECT_WIRE_VERSION.length; i++) wire[i] = EXACT_OBJECT_WIRE_VERSION.charCodeAt(i);
		wire[EXACT_OBJECT_WIRE_VERSION.length] = 0;
		wire.set(nonce, EXACT_OBJECT_WIRE_VERSION.length + 1);
		new DataView(buffer).setUint32(EXACT_OBJECT_WIRE_VERSION.length + 1 + 12, cipher.byteLength, false);
		wire.set(cipher, EXACT_OBJECT_WIRE_HEADER_BYTES);
		return wire;
	} catch {
		fail();
	}
}

export function decodeExactObjectWireV1(input: Uint8Array): Envelope {
	try {
		// Total-length cap precedes input snapshot and header parsing. Never allocate
		// from a declared u32 until all fixed bounds and exact total length match.
		const wire = snapshot(input, EXACT_OBJECT_WIRE_HEADER_BYTES + MIN_CIPHER_BYTES, EXACT_OBJECT_WIRE_MAX_BYTES);
		for (let i = 0; i < EXACT_OBJECT_WIRE_VERSION.length; i++) if (wire[i] !== EXACT_OBJECT_WIRE_VERSION.charCodeAt(i)) fail();
		const separator = EXACT_OBJECT_WIRE_VERSION.length;
		if (wire[separator] !== 0) fail();
		const cipherLength = new DataView(wire.buffer).getUint32(separator + 1 + 12, false);
		if (cipherLength < MIN_CIPHER_BYTES || cipherLength > MAX_CIPHER_BYTES || EXACT_OBJECT_WIRE_HEADER_BYTES + cipherLength !== wire.byteLength) fail();
		// Separate owned copies: neither aliases input, the snapshot, or the other.
		const nonce = wire.slice(separator + 1, separator + 1 + 12);
		const ciphertextAndTag = wire.slice(EXACT_OBJECT_WIRE_HEADER_BYTES);
		return Object.freeze({ version: EXACT_OBJECT_AEAD_VERSION, algorithm: "AES-256-GCM", nonce, ciphertextAndTag });
	} catch {
		fail();
	}
}
