/**
 * Component precondition: an upstream trusted, non-Proxy plain JSON materializer
 * must bound construction BEFORE growth: at most 20_001 value/container nodes,
 * 10_002 total own keys per container, and 40_001 total own keys in the input.
 * Own-key bounds include array.length, nonenumerable keys and symbols; invalid
 * shapes still reject here. No such production materializer is implemented or
 * certified by this component. An unknown parameter is not an admission proof.
 *
 * Reflect.ownKeys allocates a complete snapshot BEFORE defensive shape/count
 * checks. This encoder cannot pre-cap that reflection allocation for arbitrary
 * unknown inputs. Only its managed output and UTF8 key buffers are budgeted
 * before growth. No total peak-memory measurement or hostile-Proxy isolation
 * is claimed. Do not wire this component into business admission on its own.
 */
export const EXACT_INPUT_JSON_VERSION = "OPENBOT_EXACT_INPUT_JSON_V1";

const MAX_BYTES = 1_048_576;
const MAX_STRING = 262_144;
const MAX_NODES = 20_000;
const MAX_DEPTH = 32;
const MAX_ITEMS = 10_000;

function fail(): never {
	const error = new Error("Exact input JSON rejected");
	error.name = "ExactInputJsonError";
	throw error;
}

/**
 * Encode a value satisfying the bounded-materializer precondition above.
 * Not a raw HTTP parser, schema/unknown-field admission, or sandbox: reflection
 * can invoke Proxy traps. Own-key snapshots are bounded by the caller contract,
 * not by a pre-allocation check inside Reflect.ownKeys.
 */
export function canonicalExactInputJsonV1(value: unknown): Uint8Array {
	const output = new Uint8Array(MAX_BYTES);
	let offset = 0;
	let nodes = 0;
	const seen = new WeakSet<object>();
	const encoder = new TextEncoder();
	function byte(value: number): void {
		if (offset >= MAX_BYTES) fail();
		output[offset++] = value;
	}
	function ascii(value: string): void {
		if (value.length > MAX_BYTES - offset) fail();
		for (let i = 0; i < value.length; i++) byte(value.charCodeAt(i));
	}
	function stringBytes(value: string): number {
		let bytes = 0;
		for (let i = 0; i < value.length; i++) {
			const code = value.charCodeAt(i);
			let width: number;
			if (code >= 0xd800 && code <= 0xdbff) {
				const low = value.charCodeAt(++i);
				if (!(low >= 0xdc00 && low <= 0xdfff)) fail();
				width = 4;
			} else {
				if (code >= 0xdc00 && code <= 0xdfff) fail();
				width = code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
			}
			if (bytes > MAX_STRING - width) fail();
			bytes += width;
		}
		return bytes;
	}
	function quoted(value: string): void {
		stringBytes(value);
		byte(34);
		for (let i = 0; i < value.length; i++) {
			const code = value.charCodeAt(i);
			if (code === 34 || code === 92) {
				byte(92);
				byte(code);
			} else if (code < 32) {
				const short = code === 8 ? "b" : code === 9 ? "t" : code === 10 ? "n" : code === 12 ? "f" : code === 13 ? "r" : undefined;
				ascii(short === undefined ? `\\u${code.toString(16).padStart(4, "0")}` : `\\${short}`);
			} else {
				let point = code;
				if (code >= 0xd800 && code <= 0xdbff) {
					point = 0x10000 + ((code - 0xd800) << 10) + (value.charCodeAt(++i) - 0xdc00);
				}
				if (point < 0x80) byte(point);
				else if (point < 0x800) {
					byte(0xc0 | (point >> 6)); byte(0x80 | (point & 63));
				} else if (point < 0x10000) {
					byte(0xe0 | (point >> 12)); byte(0x80 | ((point >> 6) & 63)); byte(0x80 | (point & 63));
				} else {
					byte(0xf0 | (point >> 18)); byte(0x80 | ((point >> 12) & 63)); byte(0x80 | ((point >> 6) & 63)); byte(0x80 | (point & 63));
				}
			}
		}
		byte(34);
	}
	function descriptor(object: object, key: string): PropertyDescriptor {
		const result = Object.getOwnPropertyDescriptor(object, key);
		if (!result) fail();
		if (!result.enumerable || !("value" in result)) fail();
		return result;
	}
	function visit(current: unknown, depth: number): void {
		if (depth > MAX_DEPTH || nodes >= MAX_NODES) fail();
		nodes++;
		if (current === null) { ascii("null"); return; }
		if (typeof current === "boolean") { ascii(current ? "true" : "false"); return; }
		if (typeof current === "string") { quoted(current); return; }
		if (typeof current === "number") {
			if (!Number.isFinite(current) || Object.is(current, -0) || (Number.isInteger(current) && !Number.isSafeInteger(current))) fail();
			const encoded = JSON.stringify(current);
			if (typeof encoded !== "string") fail();
			ascii(encoded); return;
		}
		if (typeof current !== "object") fail();
		if (seen.has(current)) fail();
		seen.add(current);
		if (Array.isArray(current)) {
			if (Object.getPrototypeOf(current) !== Array.prototype) fail();
			const length = Object.getOwnPropertyDescriptor(current, "length");
			if (!length || !("value" in length) || typeof length.value !== "number" || !Number.isInteger(length.value) || length.value < 0 || length.value > MAX_ITEMS) fail();
			const count: number = length.value;
			const keys = Reflect.ownKeys(current);
			if (keys.length !== count + 1) fail();
			for (const key of keys) {
				if (key === "length") continue;
				if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= count) fail();
				descriptor(current, key);
			}
			byte(91);
			for (let i = 0; i < count; i++) {
				if (i) byte(44);
				visit(descriptor(current, String(i)).value, depth + 1);
			}
			byte(93); return;
		}
		const prototype = Object.getPrototypeOf(current);
		if (prototype !== Object.prototype && prototype !== null) fail();
		const keys = Reflect.ownKeys(current);
		if (keys.length > MAX_ITEMS) fail();
		const entries: { key: string; bytes: Uint8Array; data: PropertyDescriptor }[] = [];
		let keyBytes = 0;
		for (const key of keys) {
			if (typeof key !== "string") fail();
			const data = descriptor(current, key);
			const size = stringBytes(key);
			if (size > MAX_BYTES - offset - keyBytes) fail();
			keyBytes += size;
			entries.push({ key, bytes: encoder.encode(key), data });
		}
		entries.sort((a, b) => {
			const size = Math.min(a.bytes.length, b.bytes.length);
			for (let i = 0; i < size; i++) {
				const left = a.bytes[i];
				const right = b.bytes[i];
				if (left === undefined || right === undefined) fail();
				if (left !== right) return left - right;
			}
			return a.bytes.length - b.bytes.length;
		});
		byte(123);
		let first = true;
		for (const entry of entries) {
			if (!first) byte(44);
			first = false;
			quoted(entry.key); byte(58); visit(entry.data.value, depth + 1);
		}
		byte(125);
	}
	try { visit(value, 0); } catch { fail(); }
	return output.slice(0, offset);
}
