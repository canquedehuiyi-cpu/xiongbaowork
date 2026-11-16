import { describe, expect, test } from "bun:test";
import type { Envelope } from "../src/approvals/exact-object-crypto";
import { decodeExactObjectWireV1, encodeExactObjectWireV1, EXACT_OBJECT_WIRE_HEADER_BYTES, EXACT_OBJECT_WIRE_MAX_BYTES, EXACT_OBJECT_WIRE_VERSION } from "../src/approvals/exact-object-wire";

// Definitions only, no crypto. Fixtures are not a production materializer.
// Caller must bound ALL envelope own keys<=5 before construction growth;
// Reflect's complete snapshot is not dynamically pre-capped by this module.
// Independent complete wire literal: ASCII OPENBOT_APPROVAL_EXACT_WIRE_V1,
// NUL at byte30; nonce bytes31..42; u32BE(17) bytes43..46; C||T bytes47..63.
const EXPECTED_HEX = "4f50454e424f545f415050524f56414c5f45584143545f574952455f563100000102030405060708090a0b00000011101112131415161718191a1b1c1d1e1f20";
function literalWire(): Uint8Array {
	const result = new Uint8Array(EXPECTED_HEX.length / 2);
	for (let i = 0; i < result.length; i++) result[i] = Number.parseInt(EXPECTED_HEX.slice(i * 2, i * 2 + 2), 16);
	return result;
}
function envelope(): Envelope {
	return {
		version: "OPENBOT_APPROVAL_EXACT_AEAD_V1",
		algorithm: "AES-256-GCM",
		nonce: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
		ciphertextAndTag: new Uint8Array([16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]),
	};
}
function rejected(operation: () => unknown): void {
	let error: unknown;
	try { operation(); } catch (caught) { error = caught; }
	expect(error).toBeInstanceOf(Error);
	if (!(error instanceof Error)) throw new Error("Expected wire rejection");
	expect(error.name).toBe("ExactObjectWireError");
	expect(error.message).toBe("Exact object wire rejected");
	expect(error.message).not.toContain("SECRET_SENTINEL");
	expect("cause" in error).toBe(false);
}

describe("exact-object DB wire byte component, not authenticated admission", () => {
	test("exact version and sizes are independent literal expectations", () => {
		expect(EXACT_OBJECT_WIRE_VERSION).toBe("OPENBOT_APPROVAL_EXACT_WIRE_V1");
		expect(EXACT_OBJECT_WIRE_HEADER_BYTES).toBe(47); expect(EXACT_OBJECT_WIRE_MAX_BYTES).toBe(1_048_639);
	});
	test("encode equals complete hand-written wire bytes", () => {
		expect(encodeExactObjectWireV1(envelope())).toEqual(literalWire());
	});
	test("literal wire decodes to exact four-field internal record", () => {
		const decoded = decodeExactObjectWireV1(literalWire());
		expect(decoded).toEqual(envelope()); expect(Reflect.ownKeys(decoded)).toEqual(["version", "algorithm", "nonce", "ciphertextAndTag"]);
	});
	test("native u32 big-endian field is at literal offset43", () => {
		const wire = encodeExactObjectWireV1(envelope());
		expect(Array.from(wire.slice(43, 47))).toEqual([0, 0, 0, 17]);
		expect(new DataView(wire.buffer).getUint32(43, false)).toBe(17);
	});
	test("cipher17 and max1048592 are accepted without claiming GCM authentication", () => {
		for (const size of [17, 1_048_592]) {
			const original = { ...envelope(), ciphertextAndTag: new Uint8Array(size) };
			const wire = encodeExactObjectWireV1(original); expect(wire.byteLength).toBe(47 + size);
			expect(decodeExactObjectWireV1(wire)).toEqual(original);
		}
	});
	test("cipher lengths0/16/max+1 reject before output allocation", () => {
		for (const size of [0, 16, 1_048_593]) rejected(() => encodeExactObjectWireV1({ ...envelope(), ciphertextAndTag: new Uint8Array(size) }));
	});
	test("nonce must be exactly12 bytes", () => {
		for (const size of [0, 11, 13]) rejected(() => encodeExactObjectWireV1({ ...envelope(), nonce: new Uint8Array(size) }));
	});
	test("unknown internal version and algorithm reject", () => {
		for (const entry of [{ key: "version", value: "SECRET_SENTINEL" }, { key: "algorithm", value: "AES-GCM" }]) {
			const original = envelope(); Object.defineProperty(original, entry.key, { value: entry.value }); rejected(() => encodeExactObjectWireV1(original));
		}
	});
	test("every truncation of header and payload rejects", () => {
		const wire = literalWire();
		for (let length = 0; length < 64; length++) rejected(() => decodeExactObjectWireV1(wire.slice(0, length)));
	});
	test("declared lengths zero/short/long/u32overflow-shaped reject", () => {
		for (const length of [0, 16, 18, 1_048_593, 0xffff_ffff]) {
			const wire = literalWire(); new DataView(wire.buffer).setUint32(43, length, false); rejected(() => decodeExactObjectWireV1(wire));
		}
	});
	test("unknown magic and version bytes reject without legacy sniff", () => {
		const wrongPrefix = literalWire(); wrongPrefix[0] = 0;
		const wrongVersion = literalWire(); wrongVersion[29] = 50;
		rejected(() => decodeExactObjectWireV1(wrongPrefix)); rejected(() => decodeExactObjectWireV1(wrongVersion));
	});
	test("missing/wrong separator and inserted extra separator reject", () => {
		const wrong = literalWire(); wrong[30] = 32; rejected(() => decodeExactObjectWireV1(wrong));
		const original = literalWire(); const missing = new Uint8Array(63); missing.set(original.slice(0, 30)); missing.set(original.slice(31), 30); rejected(() => decodeExactObjectWireV1(missing));
		const extra = new Uint8Array(65); extra.set(original.slice(0, 31)); extra.set(original.slice(31), 32); rejected(() => decodeExactObjectWireV1(extra));
	});
	test("zero nonce bytes are payload, not extra consumed separators", () => {
		const original = { ...envelope(), nonce: new Uint8Array(12) };
		expect(decodeExactObjectWireV1(encodeExactObjectWireV1(original))).toEqual(original);
	});
	test("trailing byte and oversized total input reject", () => {
		const extra = new Uint8Array(65); extra.set(literalWire()); rejected(() => decodeExactObjectWireV1(extra));
		rejected(() => decodeExactObjectWireV1(new Uint8Array(1_048_640)));
	});
	test("encode subarrays capture exact nonzero offsets", () => {
		const original = envelope(); const n = new Uint8Array(14); n.set(original.nonce, 1); const c = new Uint8Array(19); c.set(original.ciphertextAndTag, 1);
		expect(encodeExactObjectWireV1({ ...original, nonce: n.subarray(1, 13), ciphertextAndTag: c.subarray(1, 18) })).toEqual(literalWire());
	});
	test("decode subarray does not parse backing prefix or suffix", () => {
		const backing = new Uint8Array(70); backing.fill(99); backing.set(literalWire(), 3);
		expect(decodeExactObjectWireV1(backing.subarray(3, 67))).toEqual(envelope());
	});
	test("native metadata getters ignore caller buffer/offset/length shadows", () => {
		let reads = 0; const original = envelope(); const wire = literalWire();
		for (const view of [original.nonce, original.ciphertextAndTag, wire]) for (const key of ["buffer", "byteOffset", "byteLength"]) Object.defineProperty(view, key, { get() { reads++; throw new Error("SECRET_SENTINEL"); } });
		expect(encodeExactObjectWireV1(original)).toEqual(literalWire());
		expect(decodeExactObjectWireV1(wire)).toEqual(envelope()); expect(reads).toBe(0);
	});
	test("exact four fields: missing field or fifth extra rejects", () => {
		const missing = envelope(); Reflect.deleteProperty(missing, "nonce"); rejected(() => encodeExactObjectWireV1(missing));
		const extra = envelope(); Object.defineProperty(extra, "extra", { value: 1, enumerable: true }); rejected(() => encodeExactObjectWireV1(extra));
	});
	test("nonenumerable or Symbol own fields reject within five-key precondition", () => {
		const hidden = envelope(); Object.defineProperty(hidden, "extra", { value: 1 }); rejected(() => encodeExactObjectWireV1(hidden));
		const symbol = envelope(); Object.defineProperty(symbol, Symbol("SECRET_SENTINEL"), { value: 1 }); rejected(() => encodeExactObjectWireV1(symbol));
		const hiddenRequired = envelope(); Object.defineProperty(hiddenRequired, "nonce", { enumerable: false }); rejected(() => encodeExactObjectWireV1(hiddenRequired));
	});
	test("accessor/toJSON not executed", () => {
		let reads = 0; const accessor = envelope(); Object.defineProperty(accessor, "nonce", { enumerable: true, get() { reads++; return new Uint8Array(12); } }); rejected(() => encodeExactObjectWireV1(accessor));
		const custom = envelope(); Object.defineProperty(custom, "toJSON", { value: () => { reads++; return {}; }, enumerable: true }); rejected(() => encodeExactObjectWireV1(custom)); expect(reads).toBe(0);
	});
	test("SAB view rejects in encode and decode", () => {
		rejected(() => encodeExactObjectWireV1({ ...envelope(), nonce: new Uint8Array(new SharedArrayBuffer(12)) }));
		rejected(() => encodeExactObjectWireV1({ ...envelope(), ciphertextAndTag: new Uint8Array(new SharedArrayBuffer(17)) }));
		rejected(() => decodeExactObjectWireV1(new Uint8Array(new SharedArrayBuffer(64))));
	});
	test("detached view rejects in encode and decode", () => {
		const n = new ArrayBuffer(12); const nonceView = new Uint8Array(n); structuredClone(n, { transfer: [n] }); rejected(() => encodeExactObjectWireV1({ ...envelope(), nonce: nonceView }));
		const b = new ArrayBuffer(64); const view = new Uint8Array(b); structuredClone(b, { transfer: [b] }); rejected(() => decodeExactObjectWireV1(view));
	});
	test("resizable inputs reject; unavailable fixture is not skipped", () => {
		const getter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
		if (!getter) throw new Error("Resizable ArrayBuffer fixture unavailable");
		const buffer = Reflect.construct(ArrayBuffer, [64, { maxByteLength: 128 }]); expect(getter.call(buffer)).toBe(true);
		const wire = new Uint8Array(buffer); wire.set(literalWire()); rejected(() => decodeExactObjectWireV1(wire));
		rejected(() => encodeExactObjectWireV1({ ...envelope(), nonce: wire.subarray(0, 12) }));
	});
	test("forged Uint8Array brand and custom prototypes reject", () => {
		const forged = Object.create(Uint8Array.prototype); rejected(() => decodeExactObjectWireV1(forged));
		class Custom extends Uint8Array {}
		rejected(() => encodeExactObjectWireV1({ ...envelope(), nonce: new Custom(12) }));
		const original = envelope(); Object.setPrototypeOf(original, { inherited: true }); rejected(() => encodeExactObjectWireV1(original));
	});
	test("encode result and source arrays have bidirectional mutation isolation", () => {
		const original = envelope(); const wire = encodeExactObjectWireV1(original); original.nonce.fill(99); original.ciphertextAndTag.fill(99); expect(wire).toEqual(literalWire());
		const stable = envelope(); const other = encodeExactObjectWireV1(stable); other.fill(0); expect(stable).toEqual(envelope());
		expect(wire.buffer).not.toBe(original.nonce.buffer); expect(wire.buffer).not.toBe(original.ciphertextAndTag.buffer);
	});
	test("decode outputs are independent from input and one another", () => {
		const wire = literalWire(); const decoded = decodeExactObjectWireV1(wire); wire.fill(99); expect(decoded).toEqual(envelope());
		const stable = literalWire(); const other = decodeExactObjectWireV1(stable); other.nonce.fill(99); expect(other.ciphertextAndTag).toEqual(envelope().ciphertextAndTag); other.ciphertextAndTag.fill(99); expect(stable).toEqual(literalWire());
		expect(other.nonce.buffer).not.toBe(other.ciphertextAndTag.buffer); expect(other.nonce.buffer).not.toBe(stable.buffer); expect(other.ciphertextAndTag.buffer).not.toBe(stable.buffer);
	});
});
