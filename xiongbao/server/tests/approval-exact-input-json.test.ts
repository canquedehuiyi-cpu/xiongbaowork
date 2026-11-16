import { describe, expect, test } from "bun:test";
import { canonicalExactInputJsonV1, EXACT_INPUT_JSON_VERSION } from "../src/approvals/exact-input-json";

const bytes = (text: string) => new TextEncoder().encode(text);
// These are component fixtures, not a production materializer or admission
// proof. Construction must already satisfy the module's bounded, non-Proxy
// precondition. Reflection snapshots themselves are not pre-capped here.
// No test below certifies producer wiring, hostile Proxy isolation or peak RSS.
function exact(value: unknown, expected: string): void {
	expect(canonicalExactInputJsonV1(value)).toEqual(bytes(expected));
}
function rejected(value: unknown): void {
	let error: unknown;
	try { canonicalExactInputJsonV1(value); } catch (caught) { error = caught; }
	expect(error).toBeInstanceOf(Error);
	if (!(error instanceof Error)) throw new Error("Expected codec rejection");
	expect(error.name).toBe("ExactInputJsonError");
	expect(error.message).toBe("Exact input JSON rejected");
	expect(error.message).not.toContain("SECRET_SENTINEL");
}
function nested(depth: number): unknown {
	let value: unknown = null;
	for (let i = 0; i < depth; i++) value = [value];
	return value;
}

describe("OPENBOT_EXACT_INPUT_JSON_V1 component (not AP4 admission)", () => {
	test("literal version and primitive bytes", () => {
		expect(EXACT_INPUT_JSON_VERSION).toBe("OPENBOT_EXACT_INPUT_JSON_V1");
		exact(null, "null"); exact(true, "true"); exact(false, "false");
		exact(1.5, "1.5"); exact(1e-7, "1e-7"); exact(0, "0");
	});
	test("MAXSAFE inclusive signed integer bounds", () => {
		exact(9007199254740991, "9007199254740991");
		exact(-9007199254740991, "-9007199254740991");
		rejected(9007199254740992); rejected(-9007199254740992);
	});
	test("sorts UTF8 bytes rather than UTF16 or insertion order", () => {
		exact({ "𐀀": 1, "\ue000": 2, a: 3 }, '{"a":3,"\ue000":2,"𐀀":1}');
	});
	test("numeric-looking object keys use byte order", () => {
		exact({ "2": "two", "10": "ten" }, '{"10":"ten","2":"two"}');
	});
	test("recursive object order and array order", () => {
		exact({ z: [{ b: 2, a: 1 }, false], a: null }, '{"a":null,"z":[{"a":1,"b":2},false]}');
	});
	test("emoji and combining forms remain unnormalized", () => {
		exact(["😀", "é", "e\u0301"], '["😀","é","e\u0301"]');
	});
	test("JSON quote and control escaping", () => {
		exact('"\\\b\t\n\f\r\u0000\u001f/', '"\\"\\\\\\b\\t\\n\\f\\r\\u0000\\u001f/"');
	});
	test("explicit absent and null presence are distinct literal bytes", () => {
		exact({ state: { presence: "ABSENT" } }, '{"state":{"presence":"ABSENT"}}');
		exact({ state: { presence: "PRESENT_NULL" } }, '{"state":{"presence":"PRESENT_NULL"}}');
		expect(canonicalExactInputJsonV1({ state: { presence: "ABSENT" } })).not.toEqual(canonicalExactInputJsonV1({ state: { presence: "PRESENT_NULL" } }));
	});
	test("does not rewrite ordinary null or remove supported keys", () => {
		exact({ unknownToFutureSchema: null }, '{"unknownToFutureSchema":null}');
	});
	test("null-prototype and special names are ordinary own keys", () => {
		const object: Record<string, unknown> = Object.create(null);
		for (const key of ["__proto__", "constructor", "toJSON"]) {
			Object.defineProperty(object, key, { value: "data", enumerable: true });
		}
		exact(object, '{"__proto__":"data","constructor":"data","toJSON":"data"}');
	});
	test("rejects unsupported primitives without secret values", () => {
		for (const value of [undefined, 1n, Symbol("SECRET_SENTINEL"), () => "SECRET_SENTINEL", NaN, Infinity, -Infinity, -0]) rejected(value);
	});
	test("rejects undefined or executable property, never invokes toJSON", () => {
		let calls = 0;
		rejected({ toJSON: () => { calls++; return "SECRET_SENTINEL"; } });
		rejected({ data: undefined }); expect(calls).toBe(0);
	});
	test("rejects getter without reading it", () => {
		let calls = 0;
		const object = Object.defineProperty({}, "SECRET_SENTINEL", { enumerable: true, get() { calls++; return 1; } });
		rejected(object); expect(calls).toBe(0);
	});
	test("rejects setter-only descriptor and nonenumerable property", () => {
		rejected(Object.defineProperty({}, "x", { enumerable: true, set(_value: unknown) {} }));
		rejected(Object.defineProperty({}, "x", { value: 1 }));
	});
	test("rejects object and array symbol keys", () => {
		rejected({ [Symbol("SECRET_SENTINEL")]: 1 });
		const array = [1]; Object.defineProperty(array, Symbol("x"), { value: 2 }); rejected(array);
	});
	test("rejects lone surrogates in values and keys", () => {
		for (const value of ["\ud800", "\udc00", "x\ud800x", { "\ud800": 1 }]) rejected(value);
	});
	test("rejects nonplain prototypes and array subclass", () => {
		class CustomArray extends Array<number> {}
		for (const value of [new Date(0), new Map(), new Set(), new Uint8Array(1), Object.create({ x: 1 }), new CustomArray()]) rejected(value);
	});
	test("rejects holes and nonindex array extras", () => {
		rejected(new Array(1));
		const array = [1]; Object.defineProperty(array, "01", { value: 2, enumerable: true }); rejected(array);
		const other = [1]; Object.defineProperty(other, "extra", { value: 2 }); rejected(other);
	});
	test("rejects array index accessor without invocation", () => {
		let calls = 0; const array = [1];
		Object.defineProperty(array, "0", { enumerable: true, get() { calls++; return 1; } });
		rejected(array); expect(calls).toBe(0);
	});
	test("rejects array nonenumerable index", () => {
		const array = [1]; Object.defineProperty(array, "0", { enumerable: false }); rejected(array);
	});
	test("cycles and repeated object identity both reject", () => {
		const cycle: unknown[] = []; cycle.push(cycle); rejected(cycle);
		const shared = {}; rejected([shared, shared]);
		exact([{}, {}, "same", "same"], '[{},{},"same","same"]');
	});
	test("depth32 inclusive,33 rejected", () => {
		exact(nested(32), "[".repeat(32) + "null" + "]".repeat(32)); rejected(nested(33));
	});
	test("20000 nodes inclusive,20001 rejected", () => {
		// The accepted tree has 20_002 own keys including three array.length
		// properties: do not confuse the 20k value-node cap with total own keys.
		const a = Array.from({ length: 9999 }, () => null);
		const b = Array.from({ length: 9998 }, () => null);
		exact([a, b], "[[" + "null,".repeat(9998) + "null],[" + "null,".repeat(9997) + "null]]");
		rejected([a, Array.from({ length: 9999 }, () => null)]);
	});
	test("10000 array entries inclusive,10001 rejected", () => {
		exact(Array.from({ length: 10000 }, () => 0), "[" + "0,".repeat(9999) + "0]");
		rejected(Array.from({ length: 10001 }, () => 0));
	});
	test("10000 own keys inclusive,10001 rejected; keys are not nodes", () => {
		// 10_001 is inside the upstream 10_002 snapshot precondition but fails
		// this encoder's defensive MAX_ITEMS rule after taking the snapshot.
		const object: Record<string, number> = {};
		const parts: string[] = [];
		for (let i = 0; i < 10000; i++) {
			const key = `k${String(i).padStart(5, "0")}`; object[key] = 0; parts.push(`"${key}":0`);
		}
		exact(object, "{" + parts.join(",") + "}"); object.extra = 0; rejected(object);
	});
	test("string UTF8 256KiB inclusive,one byte over rejected", () => {
		const text = "é".repeat(131072); exact(text, '"' + text + '"'); rejected(text + "a");
	});
	test("key UTF8 256KiB inclusive,one byte over rejected", () => {
		const key = "a".repeat(262144); exact({ [key]: 0 }, '{"' + key + '":0}'); rejected({ [key + "a"]: 0 });
	});
	test("canonical output1MiB inclusive and+1 rejected", () => {
		const a = "a".repeat(262144); const last = "b".repeat(262131);
		exact([a, a, a, last], '["' + a + '","' + a + '","' + a + '","' + last + '"]');
		rejected([a, a, a, last + "b"]);
	});
	test("escaped output expansion also counts budget", () => {
		rejected("\u0000".repeat(174763));
	});
	test("aggregate key encoding is bounded before sorting", () => {
		const key = "a".repeat(262143);
		rejected({ [key + "1"]: 0, [key + "2"]: 0, [key + "3"]: 0, [key + "4"]: 0, [key + "5"]: 0 });
	});
});
