import { canonicalExactInputJsonV1 } from "./exact-input-json";

/** JSON data only; this type is neither provenance nor business authority. */
export type FrozenJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly FrozenJsonValue[]
	| { readonly [key: string]: FrozenJsonValue };

const RAW_BYTES = 1_048_576;
const STRING_BYTES = 262_144;
const CONSTRUCTION_NODES = 20_001;
const CONTAINER_KEYS = 10_002;
const TOTAL_KEYS = 40_001;
const DEPTH = 32;

// Trusted, unmodified realm intrinsics are a precondition. Never inspect caller
// properties, prototypes, iterators or toJSON to establish the input brand.
const viewIsView = ArrayBuffer.isView;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag)?.get;
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, "buffer")?.get;
const typedOffset = Object.getOwnPropertyDescriptor(typedPrototype, "byteOffset")?.get;
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, "byteLength")?.get;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const bufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const nativeSet = Uint8Array.prototype.set;

function reject(): never {
	const error = new Error("Exact input JSON materialization rejected");
	error.name = "ExactInputJsonMaterializerError";
	throw error;
}

function width(point: number): number {
	return point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
}

function textSnapshot(text: string): Uint8Array {
	if (typeof text !== "string" || text.length > RAW_BYTES) reject();
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		let point = text.charCodeAt(i);
		if (point >= 0xd800 && point <= 0xdbff) {
			const low = text.charCodeAt(++i);
			if (!(low >= 0xdc00 && low <= 0xdfff)) reject();
			point = 0x10000 + ((point - 0xd800) << 10) + low - 0xdc00;
		} else if (point >= 0xdc00 && point <= 0xdfff) reject();
		const size = width(point);
		if (bytes > RAW_BYTES - size) reject();
		bytes += size;
	}
	// Encoding happens only after the full scalar count has bounded allocation.
	return new TextEncoder().encode(text);
}

function byteSnapshot(input: Uint8Array): Uint8Array {
	if (!viewIsView(input) || !typedTag || !typedBuffer || !typedOffset || !typedLength || !bufferLength) reject();
	if (typedTag.call(input) !== "Uint8Array") reject();
	const buffer: ArrayBuffer = typedBuffer.call(input);
	const offset: number = typedOffset.call(input);
	const size: number = typedLength.call(input);
	// The ArrayBuffer getter rejects SharedArrayBuffer. RABs are not snapshots.
	const capacity: number = bufferLength.call(buffer);
	if (bufferResizable?.call(buffer) === true) reject();
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || !Number.isSafeInteger(capacity) || offset < 0 || size < 0 || size > RAW_BYTES || offset > capacity || size > capacity - offset) reject();
	// Even a zero-length detached view must fail this native construction.
	const visible = new Uint8Array(buffer, offset, size);
	const owned = new Uint8Array(size);
	nativeSet.call(owned, visible);
	return owned;
}

class BoundedJsonReader {
	private at = 0;
	private nodes = 0;
	private keys = 0;
	constructor(private readonly bytes: Uint8Array) {}

	private byte(): number {
		const byte = this.bytes[this.at];
		if (byte === undefined) reject();
		return byte;
	}

	private whitespace(): void {
		while (this.at < this.bytes.length) {
			const byte = this.byte();
			if (byte !== 0x20 && byte !== 9 && byte !== 10 && byte !== 13) return;
			this.at++;
		}
	}

	private key(local: number): number {
		if (local >= CONTAINER_KEYS || this.keys >= TOTAL_KEYS) reject();
		this.keys++;
		return local + 1;
	}

	private hex(): number {
		const byte = this.byte();
		this.at++;
		if (byte >= 48 && byte <= 57) return byte - 48;
		if (byte >= 65 && byte <= 70) return byte - 55;
		if (byte >= 97 && byte <= 102) return byte - 87;
		return reject();
	}

	private codeUnit(): number {
		let unit = 0;
		for (let i = 0; i < 4; i++) unit = unit * 16 + this.hex();
		return unit;
	}

	private utf8(first: number): number {
		let remaining: number;
		let point: number;
		let minimum: number;
		if (first >= 0xc2 && first <= 0xdf) { remaining = 1; point = first & 31; minimum = 0x80; }
		else if (first >= 0xe0 && first <= 0xef) { remaining = 2; point = first & 15; minimum = 0x800; }
		else if (first >= 0xf0 && first <= 0xf4) { remaining = 3; point = first & 7; minimum = 0x10000; }
		else return reject();
		for (let i = 0; i < remaining; i++) {
			const next = this.byte();
			if (next < 0x80 || next > 0xbf) reject();
			this.at++;
			point = point * 64 + (next & 63);
		}
		if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) reject();
		return point;
	}

	private string(): string {
		if (this.byte() !== 34) reject();
		this.at++;
		let size = 0;
		let chunk = "";
		const chunks: string[] = [];
		while (true) {
			let point = this.byte();
			this.at++;
			if (point === 34) {
				chunks.push(chunk);
				return chunks.join("");
			}
			if (point === 92) {
				const escape = this.byte();
				this.at++;
				if (escape === 34 || escape === 92 || escape === 47) point = escape;
				else if (escape === 98) point = 8;
				else if (escape === 102) point = 12;
				else if (escape === 110) point = 10;
				else if (escape === 114) point = 13;
				else if (escape === 116) point = 9;
				else if (escape === 117) {
					point = this.codeUnit();
					if (point >= 0xd800 && point <= 0xdbff) {
						if (this.byte() !== 92) reject(); this.at++;
						if (this.byte() !== 117) reject(); this.at++;
						const low = this.codeUnit();
						if (low < 0xdc00 || low > 0xdfff) reject();
						point = 0x10000 + ((point - 0xd800) << 10) + low - 0xdc00;
					} else if (point >= 0xdc00 && point <= 0xdfff) reject();
				} else reject();
			} else {
				if (point < 32) reject();
				if (point >= 0x80) point = this.utf8(point);
			}
			const scalarBytes = width(point);
			if (size > STRING_BYTES - scalarBytes) reject();
			size += scalarBytes;
			// The scalar's complete UTF8 charge precedes its UTF16 allocation.
			chunk += String.fromCodePoint(point);
			if (chunk.length >= 256) { chunks.push(chunk); chunk = ""; }
		}
	}

	private number(): number {
		const start = this.at;
		if (this.byte() === 45) this.at++;
		if (this.byte() === 48) this.at++;
		else {
			if (this.byte() < 49 || this.byte() > 57) reject();
			do { this.at++; } while (this.at < this.bytes.length && this.byte() >= 48 && this.byte() <= 57);
		}
		if (this.at < this.bytes.length && this.byte() === 46) {
			this.at++;
			if (this.byte() < 48 || this.byte() > 57) reject();
			do { this.at++; } while (this.at < this.bytes.length && this.byte() >= 48 && this.byte() <= 57);
		}
		if (this.at < this.bytes.length && (this.byte() === 69 || this.byte() === 101)) {
			this.at++;
			if (this.byte() === 43 || this.byte() === 45) this.at++;
			if (this.byte() < 48 || this.byte() > 57) reject();
			do { this.at++; } while (this.at < this.bytes.length && this.byte() >= 48 && this.byte() <= 57);
		}
		// Token length is bounded by the already-owned raw buffer; no declared
		// numeric length controls allocation, and no decimal precision is promised.
		let chunk = "";
		const chunks: string[] = [];
		for (let i = start; i < this.at; i++) {
			const byte = this.bytes[i];
			if (byte === undefined) reject();
			chunk += String.fromCharCode(byte);
			if (chunk.length === 256) { chunks.push(chunk); chunk = ""; }
		}
		chunks.push(chunk);
		const value = Number(chunks.join(""));
		if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) reject();
		return value;
	}

	private literal(text: string, value: null | boolean): null | boolean {
		for (let i = 0; i < text.length; i++) {
			if (this.byte() !== text.charCodeAt(i)) reject();
			this.at++;
		}
		return value;
	}

	private value(depth: number): FrozenJsonValue {
		this.whitespace();
		if (depth > DEPTH || this.nodes >= CONSTRUCTION_NODES) reject();
		this.nodes++;
		const first = this.byte();
		if (first === 34) return this.string();
		if (first === 110) return this.literal("null", null);
		if (first === 116) return this.literal("true", true);
		if (first === 102) return this.literal("false", false);
		if (first === 45 || (first >= 48 && first <= 57)) return this.number();
		if (first === 91) {
			// length is a real nonenumerable own key, charged before construction.
			let local = this.key(0);
			const array: FrozenJsonValue[] = [];
			this.at++; this.whitespace();
			if (this.byte() === 93) { this.at++; return Object.freeze(array); }
			let index = 0;
			while (true) {
				local = this.key(local);
				const child = this.value(depth + 1);
				Object.defineProperty(array, String(index++), { value: child, enumerable: true, writable: false, configurable: false });
				this.whitespace();
				const separator = this.byte(); this.at++;
				if (separator === 93) return Object.freeze(array);
				if (separator !== 44) reject();
			}
		}
		if (first === 123) {
			const object: { [key: string]: FrozenJsonValue } = Object.create(null);
			const names = new Set<string>();
			let local = 0;
			this.at++; this.whitespace();
			if (this.byte() === 125) { this.at++; return Object.freeze(object); }
			while (true) {
				this.whitespace();
				const name = this.string();
				if (names.has(name)) reject();
				local = this.key(local);
				names.add(name);
				this.whitespace();
				if (this.byte() !== 58) reject(); this.at++;
				const child = this.value(depth + 1);
				Object.defineProperty(object, name, { value: child, enumerable: true, writable: false, configurable: false });
				this.whitespace();
				const separator = this.byte(); this.at++;
				if (separator === 125) return Object.freeze(object);
				if (separator !== 44) reject();
			}
		}
		return reject();
	}

	read(): FrozenJsonValue {
		const result = this.value(0);
		this.whitespace();
		if (this.at !== this.bytes.length) reject();
		return result;
	}
}

function materialize(owned: Uint8Array): Readonly<{ value: FrozenJsonValue; canonicalBytes: Uint8Array }> {
	const value = new BoundedJsonReader(owned).read();
	// All containers are fresh and frozen before this sole business dependency.
	// Its original output/node/items/depth/string guards remain authoritative.
	const canonicalBytes = canonicalExactInputJsonV1(value);
	return Object.freeze({ value, canonicalBytes });
}

/** Raw text admission only, not a domain schema, source-frame or permission. */
export function materializeExactJsonTextV1(text: string): Readonly<{ value: FrozenJsonValue; canonicalBytes: Uint8Array }> {
	try { return materialize(textSnapshot(text)); } catch { return reject(); }
}

/** Visible bytes only. Caller/HTTP allocations before this call are not capped. */
export function materializeExactJsonBytesV1(bytes: Uint8Array): Readonly<{ value: FrozenJsonValue; canonicalBytes: Uint8Array }> {
	try { return materialize(byteSnapshot(bytes)); } catch { return reject(); }
}

// canonicalBytes is intentionally mutable and exclusively owned by this result.
// A future producer must re-encode the frozen tree in its trusted synchronous
// stage, or validate and own a new byte copy before SHA. Neither TS readonly nor
// exposed bytes / a previous SHA supplies authority. No producer is wired here.
