/**
 * Envelope resource precondition: a trusted upstream non-Proxy materializer must
 * guarantee, BEFORE construction growth, at most FIVE total own keys, including
 * nonenumerable and Symbol keys. A valid envelope still has exactly four fields;
 * the fifth permits a bounded extra-field negative control, not acceptance.
 *
 * Reflect.ownKeys allocates its complete snapshot before the four-field check.
 * That allocation relies on the upstream bound; a TS type or ordinary/non-Proxy
 * object alone does not establish it. The actual production materializer is
 * UNIMPLEMENTED. No trusted boolean/token or business wiring is supplied here.
 * This AEAD envelope bound is separate from the JSON codec node/key preconditions.
 */
export const EXACT_OBJECT_AEAD_VERSION = "OPENBOT_APPROVAL_EXACT_AEAD_V1";

export type Envelope = Readonly<{
	version: typeof EXACT_OBJECT_AEAD_VERSION;
	algorithm: "AES-256-GCM";
	nonce: Uint8Array;
	ciphertextAndTag: Uint8Array;
}>;

type Failure = "EXACT_AEAD_INPUT" | "EXACT_AEAD_KEY" | "EXACT_AEAD_ENV" | "EXACT_AEAD_CRYPTO";
type Owned = { bytes: Uint8Array; buffer: ArrayBuffer };
const MAX_PLAINTEXT = 1_048_576;
const MAX_AAD = 32_768;

function fail(code: Failure): never {
	const error = new Error(code);
	error.name = "ExactObjectCryptoError";
	throw error;
}

// Internal non-Proxy, trusted ordinary typed-byte/envelope inputs only. This is
// not a JS sandbox, a key provider, business admission, vault or DB wire format.
// Producer must bind stage/version/scope/id/plaintext SHA in callerAad. Arbitrary
// AAD and key metadata do not confer authority; native operations check the key.
function snapshot(value: Uint8Array, minimum: number, maximum: number): Owned {
	try {
		if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) fail("EXACT_AEAD_INPUT");
		const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
		const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
		const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
		if (!bufferGetter || !lengthGetter) fail("EXACT_AEAD_INPUT");
		const source = bufferGetter.call(value);
		if (!(source instanceof ArrayBuffer)) fail("EXACT_AEAD_INPUT");
		const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable");
		if (resizable?.get?.call(source) === true) fail("EXACT_AEAD_INPUT");
		// A detached buffer rejects even a zero-length view; no source read/copy yet.
		new Uint8Array(source, 0, 0);
		const length = lengthGetter.call(value);
		if (typeof length !== "number" || !Number.isInteger(length) || length < minimum || length > maximum) fail("EXACT_AEAD_INPUT");
		const buffer = new ArrayBuffer(length);
		const bytes = new Uint8Array(buffer);
		bytes.set(value);
		return { bytes, buffer };
	} catch {
		fail("EXACT_AEAD_INPUT");
	}
}

function frame(aad: Owned): Owned {
	const prefix = EXACT_OBJECT_AEAD_VERSION;
	const buffer = new ArrayBuffer(prefix.length + 5 + aad.bytes.byteLength);
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < prefix.length; i++) bytes[i] = prefix.charCodeAt(i);
	bytes[prefix.length] = 0;
	new DataView(buffer).setUint32(prefix.length + 1, aad.bytes.byteLength, false);
	bytes.set(aad.bytes, prefix.length + 5);
	return { bytes, buffer };
}

function requiredKey(key: CryptoKey | null | undefined): CryptoKey {
	try {
		if (!key) fail("EXACT_AEAD_KEY");
		if (key.type !== "secret" || key.extractable !== false || key.algorithm.name !== "AES-GCM") fail("EXACT_AEAD_KEY");
		const algorithm = key.algorithm;
		if (!("length" in algorithm) || algorithm.length !== 256 || !key.usages.includes("encrypt") || !key.usages.includes("decrypt")) fail("EXACT_AEAD_KEY");
		return key;
	} catch {
		fail("EXACT_AEAD_KEY");
	}
}

function environment(): Crypto {
	try {
		const crypto = globalThis.crypto;
		if (!crypto || typeof crypto.getRandomValues !== "function" || !crypto.subtle || typeof crypto.subtle.encrypt !== "function" || typeof crypto.subtle.decrypt !== "function") fail("EXACT_AEAD_ENV");
		return crypto;
	} catch {
		fail("EXACT_AEAD_ENV");
	}
}

export async function sealExactObjectV1(
	key: CryptoKey | null | undefined,
	plaintext: Uint8Array,
	callerAad: Uint8Array,
): Promise<Envelope> {
	// All caller-owned byte views are copied synchronously before the first await.
	const data = snapshot(plaintext, 1, MAX_PLAINTEXT);
	const aad = frame(snapshot(callerAad, 1, MAX_AAD));
	const checkedKey = requiredKey(key);
	const crypto = environment();
	const nonceBuffer = new ArrayBuffer(12);
	const nonce = new Uint8Array(nonceBuffer);
	try {
		crypto.getRandomValues(nonce);
		const result = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonceBuffer, additionalData: aad.buffer, tagLength: 128 }, checkedKey, data.buffer);
		if (!(result instanceof ArrayBuffer) || result.byteLength !== data.bytes.byteLength + 16) fail("EXACT_AEAD_CRYPTO");
		// Object.freeze does not freeze typed-array memory. Output arrays are owned,
		// mutable byte records, with no caller-input alias or global uniqueness claim.
		return Object.freeze({ version: EXACT_OBJECT_AEAD_VERSION, algorithm: "AES-256-GCM", nonce, ciphertextAndTag: new Uint8Array(result) });
	} catch {
		fail("EXACT_AEAD_CRYPTO");
	}
}

/**
 * Open an envelope satisfying the five-own-key construction precondition above.
 * Defensive exact-shape rejection follows the bounded reflection snapshot; it
 * is not a reflection pre-allocation limit for arbitrary unknown JS objects.
 */
export async function openExactObjectV1(
	key: CryptoKey | null | undefined,
	envelope: Envelope,
	callerAad: Uint8Array,
): Promise<Uint8Array> {
	let nonce: Owned;
	let ciphertext: Owned;
	try {
		if (!envelope || (Object.getPrototypeOf(envelope) !== Object.prototype && Object.getPrototypeOf(envelope) !== null)) fail("EXACT_AEAD_INPUT");
		const keys = Reflect.ownKeys(envelope);
		if (keys.length !== 4 || keys.some((name) => typeof name !== "string" || !["version", "algorithm", "nonce", "ciphertextAndTag"].includes(name))) fail("EXACT_AEAD_INPUT");
		for (const name of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(envelope, name);
			if (!descriptor) fail("EXACT_AEAD_INPUT");
			if (!descriptor.enumerable || !("value" in descriptor)) fail("EXACT_AEAD_INPUT");
		}
		if (envelope.version !== EXACT_OBJECT_AEAD_VERSION || envelope.algorithm !== "AES-256-GCM") fail("EXACT_AEAD_INPUT");
		nonce = snapshot(envelope.nonce, 12, 12);
		ciphertext = snapshot(envelope.ciphertextAndTag, 17, MAX_PLAINTEXT + 16);
	} catch {
		fail("EXACT_AEAD_INPUT");
	}
	const aad = frame(snapshot(callerAad, 1, MAX_AAD));
	const checkedKey = requiredKey(key);
	const crypto = environment();
	try {
		const result = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce.buffer, additionalData: aad.buffer, tagLength: 128 }, checkedKey, ciphertext.buffer);
		if (!(result instanceof ArrayBuffer) || result.byteLength < 1 || result.byteLength > MAX_PLAINTEXT) fail("EXACT_AEAD_CRYPTO");
		return new Uint8Array(result);
	} catch {
		// Never expose native errors, causes or unauthenticated partial plaintext.
		fail("EXACT_AEAD_CRYPTO");
	}
}
