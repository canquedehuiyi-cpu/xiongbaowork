import { describe, expect, test } from "bun:test";
import { EXACT_OBJECT_AEAD_VERSION, openExactObjectV1, sealExactObjectV1, type Envelope } from "../src/approvals/exact-object-crypto";

// Definitions only in this source ticket. Positive cases use real native crypto
// with ephemeral nonextractable keys; no fixture proves producer/DB authority.
// Envelope fixtures rely on a separate upstream construction bound of FIVE total
// own keys, counting nonenumerable/Symbol keys. The extra-field case has five and
// must still reject: bounded snapshot is not valid shape. These fixtures neither
// implement nor certify a production materializer. Reflect.ownKeys itself takes
// the complete snapshot before shape rejection; TS type/non-Proxy is not a cap.
const aad = () => new Uint8Array([1, 2, 3]);
const data = () => new Uint8Array([4, 5, 6]);
const nonce = () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
// Independent literal bytes: ASCII version, NUL, u32BE(3), caller AAD(1,2,3).
const nativeAad = () => new Uint8Array([
	79, 80, 69, 78, 66, 79, 84, 95, 65, 80, 80, 82, 79, 86, 65, 76,
	95, 69, 88, 65, 67, 84, 95, 65, 69, 65, 68, 95, 86, 49,
	0, 0, 0, 0, 3, 1, 2, 3,
]);
function key(length = 256, extractable = false, usages: KeyUsage[] = ["encrypt", "decrypt"]): Promise<CryptoKey> {
	return globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length }, extractable, usages);
}
async function nativeEnvelope(secret: CryptoKey): Promise<Envelope> {
	const iv = nonce();
	const result = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: nativeAad(), tagLength: 128 }, secret, data());
	return { version: EXACT_OBJECT_AEAD_VERSION, algorithm: "AES-256-GCM", nonce: iv, ciphertextAndTag: new Uint8Array(result) };
}
async function rejected(promise: Promise<unknown>, code: string): Promise<void> {
	let error: unknown;
	try { await promise; } catch (caught) { error = caught; }
	expect(error).toBeInstanceOf(Error);
	if (!(error instanceof Error)) throw new Error("Expected AEAD rejection");
	expect(error.name).toBe("ExactObjectCryptoError");
	expect(error.message).toBe(code);
	expect(error.message).not.toContain("SECRET_SENTINEL");
	expect("cause" in error).toBe(false);
}

describe("exact object AEAD byte primitive, not AP4 admission", () => {
	test("real AES256GCM roundtrip and exact binary shape", async () => {
		const secret = await key(); const sealed = await sealExactObjectV1(secret, data(), aad());
		expect(Reflect.ownKeys(sealed)).toEqual(["version", "algorithm", "nonce", "ciphertextAndTag"]);
		expect(sealed.version).toBe("OPENBOT_APPROVAL_EXACT_AEAD_V1");
		expect(sealed.algorithm).toBe("AES-256-GCM"); expect(sealed.nonce.byteLength).toBe(12);
		expect(sealed.ciphertextAndTag.byteLength).toBe(19);
		expect(await openExactObjectV1(secret, sealed, aad())).toEqual(data());
	});
	test("native decrypt independently consumes seal with handwritten framing", async () => {
		const secret = await key(); const sealed = await sealExactObjectV1(secret, data(), aad());
		const result = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(sealed.nonce).buffer, additionalData: nativeAad(), tagLength: 128 }, secret, new Uint8Array(sealed.ciphertextAndTag).buffer);
		expect(new Uint8Array(result)).toEqual(new Uint8Array([4, 5, 6]));
	});
	test("open consumes independent native encrypt with fixed nonce and frame", async () => {
		const secret = await key(); const sealed = await nativeEnvelope(secret);
		expect(await openExactObjectV1(secret, sealed, aad())).toEqual(new Uint8Array([4, 5, 6]));
	});
	test("different AAD rejects", async () => {
		const secret = await key(); await rejected(openExactObjectV1(secret, await nativeEnvelope(secret), new Uint8Array([1, 2, 4])), "EXACT_AEAD_CRYPTO");
	});
	test("ciphertext bit change rejects, no partial plaintext", async () => {
		const secret = await key(); const sealed = await nativeEnvelope(secret);
		const original = sealed.ciphertextAndTag[0]; if (original === undefined) throw new Error("Missing fixture ciphertext");
		sealed.ciphertextAndTag[0] = original ^ 1; await rejected(openExactObjectV1(secret, sealed, aad()), "EXACT_AEAD_CRYPTO");
	});
	test("tag bit change rejects", async () => {
		const secret = await key(); const sealed = await nativeEnvelope(secret); const index = sealed.ciphertextAndTag.length - 1;
		const original = sealed.ciphertextAndTag[index]; if (original === undefined) throw new Error("Missing fixture tag");
		sealed.ciphertextAndTag[index] = original ^ 1; await rejected(openExactObjectV1(secret, sealed, aad()), "EXACT_AEAD_CRYPTO");
	});
	test("nonce bit change rejects", async () => {
		const secret = await key(); const sealed = await nativeEnvelope(secret); sealed.nonce[0] = 0;
		await rejected(openExactObjectV1(secret, sealed, aad()), "EXACT_AEAD_CRYPTO");
	});
	test("wrong actual key rejects", async () => {
		const first = await key(); const second = await key(); await rejected(openExactObjectV1(second, await nativeEnvelope(first), aad()), "EXACT_AEAD_CRYPTO");
	});
	test("version and algorithm mismatches reject", async () => {
		const secret = await key();
		for (const entry of [{ property: "version", value: "SECRET_SENTINEL" }, { property: "algorithm", value: "AES-GCM" }]) {
			const sealed = await nativeEnvelope(secret); Object.defineProperty(sealed, entry.property, { value: entry.value });
			await rejected(openExactObjectV1(secret, sealed, aad()), "EXACT_AEAD_INPUT");
		}
	});
	test("nonce requires exactly12 bytes", async () => {
		const secret = await key();
		for (const size of [0, 11, 13]) { const sealed = await nativeEnvelope(secret); await rejected(openExactObjectV1(secret, { ...sealed, nonce: new Uint8Array(size) }, aad()), "EXACT_AEAD_INPUT"); }
	});
	test("ciphertext input bounds17..1048592; malformed bounds reject", async () => {
		const secret = await key(); const sealed = await nativeEnvelope(secret);
		for (const size of [0, 16, 1_048_593]) await rejected(openExactObjectV1(secret, { ...sealed, ciphertextAndTag: new Uint8Array(size) }, aad()), "EXACT_AEAD_INPUT");
		await rejected(openExactObjectV1(secret, { ...sealed, ciphertextAndTag: new Uint8Array(17) }, aad()), "EXACT_AEAD_CRYPTO");
	});
	test("plaintext1 and1MiB inclusive and oversize rejected", async () => {
		const secret = await key();
		for (const size of [1, 1_048_576]) {
			const plain = new Uint8Array(size); plain[0] = 7;
			const sealed = await sealExactObjectV1(secret, plain, aad()); expect(sealed.ciphertextAndTag.length).toBe(size + 16);
			expect(await openExactObjectV1(secret, sealed, aad())).toEqual(plain);
		}
		await rejected(sealExactObjectV1(secret, new Uint8Array(0), aad()), "EXACT_AEAD_INPUT");
		await rejected(sealExactObjectV1(secret, new Uint8Array(1_048_577), aad()), "EXACT_AEAD_INPUT");
	});
	test("callerAAD1 and32768 inclusive; empty/32769 reject on both APIs", async () => {
		const secret = await key();
		for (const size of [1, 32768]) { const binding = new Uint8Array(size); const sealed = await sealExactObjectV1(secret, data(), binding); expect(await openExactObjectV1(secret, sealed, binding)).toEqual(data()); }
		const sealed = await nativeEnvelope(secret);
		for (const size of [0, 32769]) {
			await rejected(sealExactObjectV1(secret, data(), new Uint8Array(size)), "EXACT_AEAD_INPUT");
			await rejected(openExactObjectV1(secret, sealed, new Uint8Array(size)), "EXACT_AEAD_INPUT");
		}
	});
	test("missing key fails closed", async () => {
		const sealed = await nativeEnvelope(await key());
		for (const missing of [null, undefined]) {
			await rejected(sealExactObjectV1(missing, data(), aad()), "EXACT_AEAD_KEY"); await rejected(openExactObjectV1(missing, sealed, aad()), "EXACT_AEAD_KEY");
		}
	});
	test("AES128/extractable/missingusage keys fail closed", async () => {
		const sealed = await nativeEnvelope(await key());
		for (const secret of [await key(128), await key(256, true), await key(256, false, ["encrypt"]), await key(256, false, ["decrypt"])]) {
			await rejected(sealExactObjectV1(secret, data(), aad()), "EXACT_AEAD_KEY"); await rejected(openExactObjectV1(secret, sealed, aad()), "EXACT_AEAD_KEY");
		}
	});
	test("seal snapshots caller plaintext and AAD before first await", async () => {
		const secret = await key(); const plain = data(); const binding = aad();
		const pending = sealExactObjectV1(secret, plain, binding); plain.fill(99); binding.fill(99);
		const sealed = await pending;
		const native = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(sealed.nonce).buffer, additionalData: nativeAad(), tagLength: 128 }, secret, new Uint8Array(sealed.ciphertextAndTag).buffer);
		expect(new Uint8Array(native)).toEqual(new Uint8Array([4, 5, 6]));
	});
	test("open snapshots nonce/ciphertext/AAD before first await", async () => {
		const secret = await key(); const sealed = await nativeEnvelope(secret); const binding = aad();
		const pending = openExactObjectV1(secret, sealed, binding); sealed.nonce.fill(0); sealed.ciphertextAndTag.fill(0); binding.fill(0);
		expect(await pending).toEqual(new Uint8Array([4, 5, 6]));
	});
	test("returned bytes do not alias input views or each other", async () => {
		const secret = await key(); const plain = data(); const binding = aad(); const sealed = await sealExactObjectV1(secret, plain, binding);
		expect(sealed.nonce.buffer).not.toBe(plain.buffer); expect(sealed.nonce.buffer).not.toBe(binding.buffer); expect(sealed.nonce.buffer).not.toBe(sealed.ciphertextAndTag.buffer);
		expect(sealed.ciphertextAndTag.buffer).not.toBe(plain.buffer); expect(sealed.ciphertextAndTag.buffer).not.toBe(binding.buffer);
		const opened = await openExactObjectV1(secret, sealed, binding); expect(opened.buffer).not.toBe(sealed.ciphertextAndTag.buffer); expect(opened.buffer).not.toBe(sealed.nonce.buffer); expect(opened.buffer).not.toBe(binding.buffer);
		opened.fill(0); expect(await openExactObjectV1(secret, sealed, binding)).toEqual(data());
	});
	test("nonzero byte-offset views snapshot exact visible bytes", async () => {
		const secret = await key(); const plain = new Uint8Array([99, 4, 5, 6, 99]).subarray(1, 4); const binding = new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4);
		expect(await openExactObjectV1(secret, await sealExactObjectV1(secret, plain, binding), aad())).toEqual(data());
	});
	test("shared and detached inputs reject", async () => {
		const secret = await key(); await rejected(sealExactObjectV1(secret, new Uint8Array(new SharedArrayBuffer(1)), aad()), "EXACT_AEAD_INPUT");
		const buffer = new ArrayBuffer(3); const plain = new Uint8Array(buffer); structuredClone(buffer, { transfer: [buffer] });
		await rejected(sealExactObjectV1(secret, plain, aad()), "EXACT_AEAD_INPUT");
	});
	test("resizable input rejects; unavailable fixture is not silently green", async () => {
		const getter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
		if (!getter) throw new Error("Resizable buffer fixture unavailable");
		const buffer = Reflect.construct(ArrayBuffer, [1, { maxByteLength: 2 }]);
		expect(getter.call(buffer)).toBe(true);
		await rejected(sealExactObjectV1(await key(), new Uint8Array(buffer), aad()), "EXACT_AEAD_INPUT");
	});
	test("extra envelope field and accessor reject without invoking getter", async () => {
		const secret = await key(); const extra = await nativeEnvelope(secret); Object.defineProperty(extra, "SECRET_SENTINEL", { value: 1 });
		await rejected(openExactObjectV1(secret, extra, aad()), "EXACT_AEAD_INPUT");
		let reads = 0; const accessor = await nativeEnvelope(secret); Object.defineProperty(accessor, "nonce", { enumerable: true, get() { reads++; return nonce(); } });
		await rejected(openExactObjectV1(secret, accessor, aad()), "EXACT_AEAD_INPUT"); expect(reads).toBe(0);
	});
	test("metadata facade is not native key brand", async () => {
		const algorithm = { name: "AES-GCM", length: 256 };
		const facade: CryptoKey = { type: "secret", extractable: false, algorithm, usages: ["encrypt", "decrypt"] };
		await rejected(sealExactObjectV1(facade, data(), aad()), "EXACT_AEAD_CRYPTO");
	});
	test("unavailable environment closes without key generation or fallback", async () => {
		const secret = await key(); const sealed = await nativeEnvelope(secret);
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
		if (!descriptor?.configurable) throw new Error("Crypto environment fixture unavailable");
		try {
			Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
			await rejected(sealExactObjectV1(secret, data(), aad()), "EXACT_AEAD_ENV");
			await rejected(openExactObjectV1(secret, sealed, aad()), "EXACT_AEAD_ENV");
		} finally {
			Object.defineProperty(globalThis, "crypto", descriptor);
		}
	});
	test("shared AAD/nonce/ciphertext reject in open too", async () => {
		const secret = await key(); const sealed = await nativeEnvelope(secret);
		await rejected(sealExactObjectV1(secret, data(), new Uint8Array(new SharedArrayBuffer(3))), "EXACT_AEAD_INPUT");
		await rejected(openExactObjectV1(secret, sealed, new Uint8Array(new SharedArrayBuffer(3))), "EXACT_AEAD_INPUT");
		await rejected(openExactObjectV1(secret, { ...sealed, nonce: new Uint8Array(new SharedArrayBuffer(12)) }, aad()), "EXACT_AEAD_INPUT");
		await rejected(openExactObjectV1(secret, { ...sealed, ciphertextAndTag: new Uint8Array(new SharedArrayBuffer(19)) }, aad()), "EXACT_AEAD_INPUT");
	});
});
