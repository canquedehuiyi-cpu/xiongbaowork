import { expect, test } from "bun:test";
import {
	materializeExactJsonBytesV1,
	materializeExactJsonTextV1,
} from "../src/approvals/exact-input-json-materializer";

// These are definitions only in the SOURCE_ONLY package. No fixture or parser
// was executed while authoring. Expected bytes are manual protocol literals;
// neither the materializer nor the existing codec constructs the oracle.
function ascii(text: string): Uint8Array {
	const result = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code > 127) throw new Error("ASCII fixture required");
		result[i] = code;
	}
	return result;
}

function rejected(body: () => unknown): void {
	let error: unknown;
	try { body(); } catch (caught) { error = caught; }
	expect(error).toBeInstanceOf(Error);
	if (!(error instanceof Error)) throw new Error("Expected safe rejection");
	expect(error.name).toBe("ExactInputJsonMaterializerError");
	expect(error.message).toBe("Exact input JSON materialization rejected");
	expect(Object.hasOwn(error, "cause")).toBe(false);
	expect(Object.hasOwn(error, "value")).toBe(false);
	expect(Object.hasOwn(error, "canonicalBytes")).toBe(false);
}

function callBytes(value: unknown): unknown {
	return Reflect.apply(materializeExactJsonBytesV1, undefined, [value]);
}

function callText(value: unknown): unknown {
	return Reflect.apply(materializeExactJsonTextV1, undefined, [value]);
}

test("manual complete canonical bytes sort keys and preserve nested values", () => {
	const result = materializeExactJsonTextV1(' { "z": [true,false,null,1.5], "a": {"b":"x"} }\n');
	expect(result.canonicalBytes).toEqual(ascii('{"a":{"b":"x"},"z":[true,false,null,1.5]}'));
	expect(Object.getPrototypeOf(result.value)).toBe(null);
});

test("all scalar root kinds have independent literal oracles", () => {
	for (const [input, output] of [["null", "null"], ["true", "true"], ["false", "false"], ['"x"', '"x"'], ["1.25e1", "12.5"]]) {
		if (input === undefined || output === undefined) throw new Error("Fixture incomplete");
		expect(materializeExactJsonTextV1(input).canonicalBytes).toEqual(ascii(output));
	}
});

test("materialization retains complete result-dependent data without projection or stripping", () => {
	// These are data, not a branded PreparedExecutionInput or trusted authority.
	const literal = '{"configRefs":{"model":"versioned-ref"},"forwardedProps":{"bearer":"fixture-only","nested":{"encryptedValue":"opaque","metadata":[1,null]}},"messages":[{"content":[{"text":"result text","type":"text"}],"role":"tool"}],"parentRunId":"parent","persistedMessages":[],"resume":true,"result":{"output":{"private":"retained"}},"sourceBinding":{"actualRun":"actual"},"state":{"subagentRunId":"child"},"toolRefs":["tool-v1"],"transformRefs":["transform-v1"]}';
	expect(materializeExactJsonTextV1(literal).canonicalBytes).toEqual(ascii(literal));
});

test("manual UTF8 and escaped surrogate pair yield identical complete bytes", () => {
	const expected = new Uint8Array([34, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80, 34]);
	expect(materializeExactJsonBytesV1(expected).canonicalBytes).toEqual(expected);
	expect(materializeExactJsonTextV1('"\\u00e9\\ud83d\\ude00"').canonicalBytes).toEqual(expected);
});

test("control escapes and slash have a manual full canonical oracle", () => {
	const input = new Uint8Array([34, 92, 98, 92, 116, 92, 110, 92, 102, 92, 114, 92, 117, 48, 48, 48, 48, 92, 47, 92, 92, 92, 34, 34]);
	const result = materializeExactJsonBytesV1(input);
	expect(result.canonicalBytes).toEqual(new Uint8Array([34, 92, 98, 92, 116, 92, 110, 92, 102, 92, 114, 92, 117, 48, 48, 48, 48, 47, 92, 92, 92, 34, 34]));
});

test("UTF8 key ordering is literal and does not normalize Unicode", () => {
	const input = new Uint8Array([123,34,0xc3,0xa9,34,58,49,44,34,101,0xcc,0x81,34,58,50,125]);
	const expected = new Uint8Array([123,34,101,0xcc,0x81,34,58,50,44,34,0xc3,0xa9,34,58,49,125]);
	expect(materializeExactJsonBytesV1(input).canonicalBytes).toEqual(expected);
});

test("proto constructor and toJSON remain ordinary nullproto data", () => {
	const result = materializeExactJsonTextV1('{"__proto__":{"polluted":true},"constructor":1,"toJSON":"data"}');
	expect(Object.getPrototypeOf(result.value)).toBe(null);
	expect(Object.getOwnPropertyDescriptor(result.value, "__proto__")?.value).toEqual({ polluted: true });
	expect(Object.getOwnPropertyDescriptor(result.value, "toJSON")?.value).toBe("data");
	expect(result.canonicalBytes).toEqual(ascii('{"__proto__":{"polluted":true},"constructor":1,"toJSON":"data"}'));
});

test("all nested containers and wrapper freeze while dense array length is counted", () => {
	const result = materializeExactJsonTextV1('{"a":[{"b":[]},null]}');
	const array: unknown = Object.getOwnPropertyDescriptor(result.value, "a")?.value;
	if (!Array.isArray(array)) throw new Error("Expected array");
	const object: unknown = array[0];
	if (typeof object !== "object" || object === null) throw new Error("Expected object");
	const empty: unknown = Object.getOwnPropertyDescriptor(object, "b")?.value;
	expect(Object.isFrozen(result)).toBe(true);
	expect(Object.isFrozen(result.value)).toBe(true);
	expect(Object.isFrozen(array)).toBe(true);
	expect(Object.isFrozen(object)).toBe(true);
	expect(Object.isFrozen(empty)).toBe(true);
	expect(Reflect.ownKeys(array)).toEqual(["0", "1", "length"]);
	expect(Object.getOwnPropertyDescriptor(array, "0")).toMatchObject({ enumerable: true, writable: false, configurable: false });
});

test("canonical bytes stay mutable but cannot alias input or another result", () => {
	const input = ascii('["x"]');
	const first = materializeExactJsonBytesV1(input);
	const second = materializeExactJsonBytesV1(input);
	expect(Object.isFrozen(first.canonicalBytes)).toBe(false);
	expect(first.canonicalBytes.buffer).not.toBe(input.buffer);
	expect(first.canonicalBytes.buffer).not.toBe(second.canonicalBytes.buffer);
	expect(first.canonicalBytes.byteOffset).toBe(0);
	expect(first.canonicalBytes.buffer.byteLength).toBe(first.canonicalBytes.byteLength);
	first.canonicalBytes[0] = 0;
	input[2] = 121;
	expect(second.canonicalBytes).toEqual(ascii('["x"]'));
	expect(first.value).toEqual(["x"]);
	expect(materializeExactJsonBytesV1(input).value).toEqual(["y"]);
});

test("visible offset range excludes invalid bytes outside the view", () => {
	const backing = new Uint8Array([255,123,34,97,34,58,49,125,255]);
	const view = new Uint8Array(backing.buffer, 1, 7);
	expect(materializeExactJsonBytesV1(view).canonicalBytes).toEqual(ascii('{"a":1}'));
});

test("native getters ignore shadow properties and symbol getter on a real view", () => {
	const input = ascii("null");
	let traps = 0;
	for (const key of ["buffer", "byteOffset", "byteLength", Symbol.toStringTag]) {
		Object.defineProperty(input, key, { get() { traps++; throw new Error("caller getter"); } });
	}
	Object.defineProperty(input, Symbol.iterator, { get() { traps++; throw new Error("iterator"); } });
	expect(materializeExactJsonBytesV1(input).canonicalBytes).toEqual(ascii("null"));
	expect(traps).toBe(0);
});

test("Proxy views and objects reject before any user trap or coercion", () => {
	let traps = 0;
	const handler: ProxyHandler<object> = {
		get() { traps++; throw new Error("get"); },
		getPrototypeOf() { traps++; throw new Error("prototype"); },
		ownKeys() { traps++; throw new Error("keys"); },
		getOwnPropertyDescriptor() { traps++; throw new Error("descriptor"); },
	};
	for (const input of [new Proxy(ascii("null"), handler), new Proxy({}, handler)]) rejected(() => callBytes(input));
	rejected(() => callText(new Proxy({}, handler)));
	expect(traps).toBe(0);
});

test("boxed strings and forged byte records reject without touching getters", () => {
	let calls = 0;
	const boxed = new String("null");
	Object.defineProperty(boxed, "toString", { get() { calls++; throw new Error("coercion"); } });
	const forged = { get byteLength() { calls++; return 4; }, get buffer() { calls++; return new ArrayBuffer(4); } };
	rejected(() => callText(boxed));
	rejected(() => callBytes(forged));
	expect(calls).toBe(0);
});

test("other native view brands reject instead of reinterpreting elements", () => {
	for (const input of [new Uint16Array([110,117,108,108]), new Int8Array([110,117,108,108]), new DataView(new ArrayBuffer(4)), new ArrayBuffer(4)]) rejected(() => callBytes(input));
});

test("SharedArrayBuffer views reject even when their visible bytes are valid", () => {
	if (typeof SharedArrayBuffer !== "function") throw new Error("SharedArrayBuffer fixture capability missing");
	const view = new Uint8Array(new SharedArrayBuffer(4));
	view.set([110,117,108,108]);
	rejected(() => materializeExactJsonBytesV1(view));
});

test("resizable ArrayBuffer views reject with explicit fixture capability", () => {
	const getter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
	if (!getter) throw new Error("Resizable ArrayBuffer fixture capability missing");
	const buffer = Reflect.construct(ArrayBuffer, [4, { maxByteLength: 8 }]);
	if (getter.call(buffer) !== true) throw new Error("Resizable fixture not created");
	const view = new Uint8Array(buffer);
	view.set([110,117,108,108]);
	rejected(() => materializeExactJsonBytesV1(view));
});

test("detached ordinary buffer rejects including zero visible byteLength", () => {
	if (typeof structuredClone !== "function") throw new Error("Transfer fixture capability missing");
	const buffer = new ArrayBuffer(4);
	const view = new Uint8Array(buffer);
	view.set([110,117,108,108]);
	structuredClone(buffer, { transfer: [buffer] });
	expect(view.byteLength).toBe(0);
	rejected(() => materializeExactJsonBytesV1(view));
});

test("raw UTF8 cap inclusive and plus one via whitespace independent of tree budgets", () => {
	const exact = " ".repeat(1_048_572) + "null";
	expect(materializeExactJsonTextV1(exact).canonicalBytes).toEqual(ascii("null"));
	expect(materializeExactJsonBytesV1(ascii(exact)).canonicalBytes).toEqual(ascii("null"));
	rejected(() => materializeExactJsonTextV1(` ${exact}`));
	rejected(() => materializeExactJsonBytesV1(ascii(` ${exact}`)));
});

test("UTF16 cheap length does not substitute for full UTF8 raw byte accounting", () => {
	// Four separately bounded strings: 262141 UTF8 bytes each, small framing.
	const part = "é".repeat(131070) + "a";
	const raw = `["${part}","${part}","${part}","${part}"]`;
	// 4*262141 + 13 = 1048577, despite far fewer UTF16 code units.
	expect(raw.length).toBeLessThan(1_048_576);
	rejected(() => materializeExactJsonTextV1(raw));
});

test("decoded value string UTF8 budget inclusive and plus one", () => {
	const exact = "a".repeat(262_144);
	expect(materializeExactJsonTextV1(`"${exact}"`).canonicalBytes).toEqual(ascii(`"${exact}"`));
	rejected(() => materializeExactJsonTextV1(`"${exact}a"`));
});

test("decoded key UTF8 budget inclusive and plus one", () => {
	const exact = "k".repeat(262_144);
	expect(materializeExactJsonTextV1(`{"${exact}":0}`).canonicalBytes).toEqual(ascii(`{"${exact}":0}`));
	rejected(() => materializeExactJsonTextV1(`{"${exact}k":0}`));
});

test("string scalar charges escaped and multibyte values without replacement", () => {
	const prefix = "a".repeat(262_140);
	const result = materializeExactJsonTextV1(`"${prefix}\\ud83d\\ude00"`);
	const expected = new Uint8Array(262_146);
	expected[0] = 34;
	expected.fill(97, 1, 262_141);
	expected.set([0xf0,0x9f,0x98,0x80,34], 262_141);
	expect(result.canonicalBytes).toEqual(expected);
	rejected(() => materializeExactJsonTextV1(`"${prefix}a\\ud83d\\ude00"`));
});

test("depth root zero accepts 32 and rejects 33 before child construction", () => {
	const exact = "[".repeat(32) + "0" + "]".repeat(32);
	expect(materializeExactJsonTextV1(exact).canonicalBytes).toEqual(ascii(exact));
	rejected(() => materializeExactJsonTextV1(`[${exact}]`));
});

test("array items 10000 succeed while construction allowance is not codec success", () => {
	const exact = `[${Array(10_000).fill("0").join(",")}]`;
	expect(materializeExactJsonTextV1(exact).canonicalBytes).toEqual(ascii(exact));
	// 10001 entries + length fits construction10002 but codecitems10000 rejects.
	rejected(() => materializeExactJsonTextV1(`[${Array(10_001).fill("0").join(",")}]`));
	// 10002 entries + length exceeds the construction own-key bound itself.
	rejected(() => materializeExactJsonTextV1(`[${Array(10_002).fill("0").join(",")}]`));
});

test("object items 10000 succeed and 10001 are not silently stripped", () => {
	// Fixed-width decimal names already have canonical byte order.
	const entries = Array.from({ length: 10_000 }, (_, i) => `"k${String(i).padStart(5,"0")}":0`);
	const exact = `{${entries.join(",")}}`;
	expect(materializeExactJsonTextV1(exact).canonicalBytes).toEqual(ascii(exact));
	rejected(() => materializeExactJsonTextV1(`{${entries.join(",")},"k10000":0}`));
	rejected(() => materializeExactJsonTextV1(`{${entries.join(",")},"k10000":0,"k10001":0,"k10002":0}`));
});

test("node boundary 20000 succeeds but construction node20001 is rejected by codec", () => {
	// root + two arrays + (9998+9999) leaves = 20000; depth2/items9999.
	const left = Array(9_998).fill("0").join(",");
	const right = Array(9_999).fill("0").join(",");
	const exact = `[[${left}],[${right}]]`;
	expect(materializeExactJsonTextV1(exact).canonicalBytes).toEqual(ascii(exact));
	rejected(() => materializeExactJsonTextV1(`[[${left},0],[${right}]]`));
	rejected(() => materializeExactJsonTextV1(`[[${left},0,0],[${right}]]`));
});

test("total own-key ceiling is structurally unreachable before node guard", () => {
	// JSON values form a tree: K=N-1+A <=2N-1. No configurable limits or
	// fake guard entry point exists. K40002 is NOT_SEPARATELY_REACHABLE.
	// Near-max keys without another earlier guard: 9999 empty arrays under each
	// of two arrays gives N20001/K40001, constructible but codecnode20000 rejects.
	const group = Array(9_999).fill("[]").join(",");
	const atConstruction = `[[${group}],[${group}]]`;
	rejected(() => materializeExactJsonTextV1(atConstruction));
	// Remove one emptyarray: N20000/A20000/K39999, actual successful maximum.
	const shorter = Array(9_998).fill("[]").join(",");
	const atSuccess = `[[${shorter}],[${group}]]`;
	expect(materializeExactJsonTextV1(atSuccess).canonicalBytes).toEqual(ascii(atSuccess));
});

test("canonical output cap inclusive and plus one while raw and strings fit", () => {
	// Four strings sum1048554; canonical quotes8+commas4+brackets2+number8=22.
	// Input uses 1e-6 (4B), output 0.000001 (8B), so raw is 1048572B.
	const a = "a".repeat(262_144);
	const d = "d".repeat(262_122);
	const input = `["${a}","${a}","${a}","${d}",1e-6]`;
	const expected = `["${a}","${a}","${a}","${d}",0.000001]`;
	expect(expected.length).toBe(1_048_576);
	expect(input.length).toBe(1_048_572);
	expect(materializeExactJsonTextV1(input).canonicalBytes).toEqual(ascii(expected));
	rejected(() => materializeExactJsonTextV1(`["${a}","${a}","${a}","${d}d",1e-6]`));
});

test("decoded duplicate keys reject before insertion including escaped aliases", () => {
	for (const input of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"__proto__":1,"__proto__":2}', '{"x":{"b":0,"\\u0062":1}}']) rejected(() => materializeExactJsonTextV1(input));
});

test("strict malformed UTF8 rejects overlong surrogate out-of-range and truncation", () => {
	for (const bytes of [[34,0xc0,0xaf,34],[34,0xe0,0x80,0xaf,34],[34,0xed,0xa0,0x80,34],[34,0xf4,0x90,0x80,0x80,34],[34,0xf5,0x80,0x80,0x80,34],[34,0x80,34],[34,0xc2],[34,0xe2,0x28,0xa1,34],[34,0xf0,0x9f,0x98]]) rejected(() => materializeExactJsonBytesV1(new Uint8Array(bytes)));
});

test("strict escape syntax and lone surrogates reject in keys and values", () => {
	for (const input of ['"\\uD800"','"\\uDC00"','"\\uD800\\u0041"','"\\x41"','"\\u00xz"','"\\u123"','"\\"','"line\nfeed"','{"\\ud800":1}', '"\ud800"', '"\udc00"']) rejected(() => materializeExactJsonTextV1(input));
});

test("BOM comments non-JSON whitespace and second roots reject", () => {
	for (const input of ["\ufeffnull", "//x\nnull", "/*x*/null", "null\u00a0", "null\v", "null true", "{}[]", "null\u0000"]) rejected(() => materializeExactJsonTextV1(input));
	rejected(() => materializeExactJsonBytesV1(new Uint8Array([0xef,0xbb,0xbf,110,117,108,108])));
	expect(materializeExactJsonTextV1(" \t\r\nnull\r\n\t ").canonicalBytes).toEqual(ascii("null"));
});

test("incomplete roots trailing commas holes missing colon and trailing bytes reject", () => {
	for (const input of ["", " ", "[", "{", '"', "tru", "nul", "[1,]", "[,1]", "[1,,2]", '{"a":1,}', '{"a" 1}', '{"a":}', "[1 2]", "nullx"]) rejected(() => materializeExactJsonTextV1(input));
});

test("strict JSON numeric grammar rejects non-JSON spellings and unsafe values", () => {
	for (const input of ["+1", "01", "-01", ".1", "1.", "1e", "1e+", "--1", "NaN", "Infinity", "0x10", "-0", "-0.0", "-0e2", "9007199254740992", "1e400", "-1e-400"]) rejected(() => materializeExactJsonTextV1(input));
});

test("binary64 value semantics allow positive underflow and rounded safe decimal", () => {
	expect(materializeExactJsonTextV1("1e-400").canonicalBytes).toEqual(ascii("0"));
	expect(materializeExactJsonTextV1("9007199254740991.1").canonicalBytes).toEqual(ascii("9007199254740991"));
	expect(materializeExactJsonTextV1("1e-6").canonicalBytes).toEqual(ascii("0.000001"));
	expect(materializeExactJsonTextV1("-2.5e-1").canonicalBytes).toEqual(ascii("-0.25"));
});

test("failure returns no partial tree bytes or input-bearing diagnostic", () => {
	const secret = "private-bearer-marker";
	let returned: unknown = undefined;
	let error: unknown;
	try { returned = materializeExactJsonTextV1(`{"token":"${secret}","bad":`); } catch (caught) { error = caught; }
	expect(returned).toBeUndefined();
	if (!(error instanceof Error)) throw new Error("Expected safe error");
	expect(error.message).toBe("Exact input JSON materialization rejected");
	expect(error.message.includes(secret)).toBe(false);
	expect(Reflect.ownKeys(error).sort()).toEqual(["message", "name", "stack"].sort());
});

test("separate calls create fresh containers even for equal canonical content", () => {
	const first = materializeExactJsonTextV1('{"a":[]}');
	const second = materializeExactJsonTextV1('{"a":[]}');
	expect(first.value).not.toBe(second.value);
	expect(Object.getOwnPropertyDescriptor(first.value, "a")?.value).not.toBe(Object.getOwnPropertyDescriptor(second.value, "a")?.value);
	expect(first.canonicalBytes).toEqual(second.canonicalBytes);
});
