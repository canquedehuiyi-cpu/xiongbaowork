import { expect, test } from "bun:test";
import {
	assertExactCapturePreparedHeaderPairV1,
	buildExactObjectHeaderAadV1,
	EXACT_OBJECT_HEADER_VERSION,
	type CaptureHeaderRow,
	type PreparedHeaderRow,
} from "../src/approvals/exact-object-header";

// Definitions only, 0 run on delivery. These ordinary bounded fixtures do not
// implement or certify the missing trusted production materializer/registry.
// Independent complete ASCII UTF8 oracles, manually ordered by unsigned UTF8
// key bytes; neither builder nor JSON.stringify is used to issue an oracle.
const C_EXPECTED = '{"actionDigest":"action","actorUserId":"actor","agentId":"agent","approvalId":"approval","approvalRunId":"approval-run","codecVersion":"OPENBOT_EXACT_INPUT_JSON_V1","domainId":"00000000-0000-0000-0000-000000000002","envelopeWireVersion":"OPENBOT_APPROVAL_EXACT_WIRE_V1","headerVersion":"OPENBOT_APPROVAL_EXACT_HEADER_V1","keyVersion":"key-c","objectId":"00000000-0000-0000-0000-000000000001","ownerUserId":"owner","plaintextSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sourceActualRunId":"source-run","sourceBinding":{},"sourceBindingVersion":"OPENBOT_APPROVAL_EXACT_SOURCE_BINDING_V1","stage":"capture","tenantId":"tenant","threadId":"thread","toolCallId":"tool"}';
const P_EXPECTED = '{"actionDigest":"action","actorUserId":"actor","admissionId":"admission","agentId":"agent","approvalId":"approval","approvalRunId":"approval-run","captureId":"00000000-0000-0000-0000-000000000001","captureSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","codecVersion":"OPENBOT_EXACT_INPUT_JSON_V1","domainId":"00000000-0000-0000-0000-000000000002","envelopeWireVersion":"OPENBOT_APPROVAL_EXACT_WIRE_V1","headerVersion":"OPENBOT_APPROVAL_EXACT_HEADER_V1","inputDigest":"opaque-input","keyVersion":"key-p","objectId":"00000000-0000-0000-0000-000000000003","ownerUserId":"owner","plaintextSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","planIdentity":"plan","planRunId":"plan-run","savedResultDigest":"opaque-result","sourceActualRunId":"source-run","sourceBinding":{},"sourceBindingVersion":"OPENBOT_APPROVAL_EXACT_SOURCE_BINDING_V1","stage":"prepared","targetRunId":"target-run","tenantId":"tenant","threadId":"thread","toolCallId":"tool"}';
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
function capture(): CaptureHeaderRow {
	return {
		id: "00000000-0000-0000-0000-000000000001", stage: "capture",
		codecVersion: "OPENBOT_EXACT_INPUT_JSON_V1", approvalId: "approval",
		tenantId: "tenant", ownerUserId: "owner", actorUserId: "actor",
		domainId: "00000000-0000-0000-0000-000000000002", threadId: "thread",
		agentId: "agent", approvalRunId: "approval-run", sourceActualRunId: "source-run",
		toolCallId: "tool", actionDigest: "action", sourceBinding: {},
		sourceBindingVersion: "OPENBOT_APPROVAL_EXACT_SOURCE_BINDING_V1",
		plaintextSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		keyVersion: "key-c", envelopeWireVersion: "OPENBOT_APPROVAL_EXACT_WIRE_V1",
	};
}
function prepared(): PreparedHeaderRow {
	return {
		...capture(), id: "00000000-0000-0000-0000-000000000003", stage: "prepared",
		plaintextSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		keyVersion: "key-p", captureId: "00000000-0000-0000-0000-000000000001",
		captureSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		savedResultDigest: "opaque-result", admissionId: "admission", inputDigest: "opaque-input",
		planIdentity: "plan", planRunId: "plan-run", targetRunId: "target-run",
	};
}
function rejectBuild(value: unknown): void {
	expect(() => Reflect.apply(buildExactObjectHeaderAadV1, undefined, [value])).toThrow("Exact object header rejected");
}
function rejectPair(left: unknown, right: unknown): void {
	expect(() => Reflect.apply(assertExactCapturePreparedHeaderPairV1, undefined, [left, right])).toThrow("Exact object header rejected");
}

test("complete independent capture C20 bytes", () => {
	expect(EXACT_OBJECT_HEADER_VERSION).toBe("OPENBOT_APPROVAL_EXACT_HEADER_V1");
	expect(buildExactObjectHeaderAadV1(capture())).toEqual(bytes(C_EXPECTED));
});
test("complete independent prepared P28 bytes", () => {
	expect(buildExactObjectHeaderAadV1(prepared())).toEqual(bytes(P_EXPECTED));
});
test("different key versions, own IDs/SHA and all run roles remain legal", () => {
	expect(() => assertExactCapturePreparedHeaderPairV1(capture(), prepared())).not.toThrow();
	expect(buildExactObjectHeaderAadV1(prepared())).toEqual(bytes(P_EXPECTED));
});
test("pair rejects two prepared DTOs at runtime", () => {
	rejectPair(prepared(), prepared());
	const left = prepared();
	const right: PreparedHeaderRow = {
		...prepared(),
		id: "00000000-0000-0000-0000-000000000004",
		captureId: left.id,
		captureSha256: left.plaintextSha256,
	};
	expect(() => buildExactObjectHeaderAadV1(left)).not.toThrow();
	expect(() => buildExactObjectHeaderAadV1(right)).not.toThrow();
	rejectPair(left, right);
});
test("pair rejects two capture DTOs at runtime", () => rejectPair(capture(), capture()));
test("pair rejects exchanged runtime roles", () => rejectPair(prepared(), capture()));
test("every required DTO property is mandatory on both sides", () => {
	for (const original of [capture(), prepared()]) {
		for (const key of Object.keys(original)) {
			const changed = { ...original };
			Reflect.deleteProperty(changed, key);
			rejectBuild(changed);
			if (original.stage === "capture") rejectPair(changed, prepared());
			else rejectPair(capture(), changed);
		}
	}
});
test("all DTO fields are committed: single valid changes differ or invalid changes reject", () => {
	for (const original of [capture(), prepared()]) {
		const expected = original.stage === "capture" ? C_EXPECTED : P_EXPECTED;
		for (const key of Object.keys(original)) {
			if (["stage", "codecVersion", "sourceBindingVersion", "envelopeWireVersion"].includes(key)) {
				rejectBuild({ ...original, [key]: "wrong" });
				continue;
			}
			const value = key === "sourceBinding" ? { marker: "different" }
				: ["id", "domainId", "captureId"].includes(key) ? "00000000-0000-0000-0000-000000000009"
				: ["plaintextSha256", "captureSha256"].includes(key) ? "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" : "different";
			expect(Reflect.apply(buildExactObjectHeaderAadV1, undefined, [{ ...original, [key]: value }])).not.toEqual(bytes(expected));
		}
	}
});
test("headerVersion and excluded envelope/createdAt/hash fields cannot enter DTO", () => {
	for (const key of ["headerVersion", "objectId", "envelopeBytes", "createdAt", "headerSha256", "envelope"]) {
		rejectBuild({ ...capture(), [key]: "not-allowed" });
	}
});
test("bounded fifth/extra row keys, Symbols and nonenumerables reject", () => {
	const extra = { ...prepared(), extra: "x" }; //28 own keys, bounded but illegal.
	rejectBuild(extra);
	const symbol = { ...capture(), [Symbol("secret")]: "secret" };
	rejectBuild(symbol);
	const hidden = capture(); Object.defineProperty(hidden, "hidden", { value: "secret" }); rejectBuild(hidden);
});
test("row descriptors are audited without executing any getter", () => {
	let calls = 0;
	for (const key of ["stage", "tenantId", "sourceBinding"]) {
		const value = capture(); Object.defineProperty(value, key, { enumerable: true, get() { calls++; return "secret"; } }); rejectBuild(value);
	}
	expect(calls).toBe(0);
});
test("undefined, null, nonplain rows and invalid stage shapes reject", () => {
	for (const value of [null, undefined, [], new Date(), { ...capture(), tenantId: undefined }, { ...capture(), stage: "prepared" }, { ...prepared(), stage: "capture" }]) rejectBuild(value);
});
test("canonical UUID syntax is strict but adds no version or variant rule", () => {
	const c = { ...capture(), id: "ffffffff-ffff-ffff-ffff-ffffffffffff", domainId: "00000000-0000-0000-0000-000000000000" };
	expect(() => buildExactObjectHeaderAadV1(c)).not.toThrow();
	for (const key of ["id", "domainId", "captureId"]) for (const bad of ["not-uuid", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "00000000-0000-0000-0000-000000000001\n"]) rejectBuild({ ...prepared(), [key]: bad });
});
test("plain and capture hashes require exactly64 lowercase hex", () => {
	for (const key of ["plaintextSha256", "captureSha256"]) for (const bad of ["a".repeat(63), "a".repeat(65), "A".repeat(64), `${"a".repeat(64)}\n`]) rejectBuild({ ...prepared(), [key]: bad });
});
test("opaque prepared text may be empty and never gains UUID or SHA rules", () => {
	const p = { ...prepared(), savedResultDigest: "", admissionId: "", inputDigest: "", planIdentity: "", planRunId: "", targetRunId: "" };
	expect(() => assertExactCapturePreparedHeaderPairV1(capture(), p)).not.toThrow();
	for (const key of ["savedResultDigest", "admissionId", "inputDigest", "planIdentity", "planRunId", "targetRunId"]) rejectBuild({ ...p, [key]: 0 });
});
test("12text scope budget is inclusive1536 UTF8 bytes, excludes domain UUID", () => {
	const c = capture();
	const others = [c.tenantId, c.ownerUserId, c.actorUserId, c.threadId, c.agentId, c.approvalRunId, c.sourceActualRunId, c.toolCallId, c.actionDigest, c.sourceBindingVersion, c.codecVersion];
	const used = others.reduce((n, value) => n + bytes(value).byteLength, 0);
	expect(() => buildExactObjectHeaderAadV1({ ...c, approvalId: "x".repeat(1536 - used) })).not.toThrow();
	rejectBuild({ ...c, approvalId: "x".repeat(1537 - used) });
	rejectBuild({ ...c, tenantId: "" });
});
test("UTF8 scope accounting counts multibyte text without normalization", () => {
	const c = capture();
	rejectBuild({ ...c, approvalId: "熊".repeat(512) });
	expect(() => buildExactObjectHeaderAadV1({ ...c, tenantId: " \t" })).not.toThrow();
	rejectBuild({ ...c, tenantId: "\ud800" });
});
test("all13 common fields and capture id/hash correspond exactly", () => {
	for (const key of ["approvalId", "tenantId", "ownerUserId", "actorUserId", "domainId", "threadId", "agentId", "approvalRunId", "sourceActualRunId", "toolCallId", "actionDigest", "sourceBindingVersion", "codecVersion", "captureId", "captureSha256"]) {
		const value = ["domainId", "captureId"].includes(key) ? "00000000-0000-0000-0000-000000000009" : key === "captureSha256" ? "c".repeat(64) : "different";
		rejectPair(capture(), { ...prepared(), [key]: value });
	}
});
test("complete binding recursively compares config/tool/transform refs, not reference identity", () => {
	const c = { ...capture(), sourceBinding: { config: { ref: "v1" }, tool: { ref: "v1" }, transform: { ref: "v1" } } };
	const p = { ...prepared(), sourceBinding: { transform: { ref: "v1" }, tool: { ref: "v1" }, config: { ref: "v1" } } };
	expect(() => assertExactCapturePreparedHeaderPairV1(c, p)).not.toThrow();
	for (const key of ["config", "tool", "transform"]) rejectPair(c, { ...p, sourceBinding: { ...p.sourceBinding, [key]: { ref: "v2" } } });
});
test("binding must be a plain object with supported complete values", () => {
	for (const binding of [null, [], new Date(), { bad: undefined }, { bad: () => 1 }]) rejectBuild({ ...capture(), sourceBinding: binding });
	let calls = 0; const binding = {}; Object.defineProperty(binding, "x", { enumerable: true, get() { calls++; return "secret"; } }); rejectBuild({ ...capture(), sourceBinding: binding }); expect(calls).toBe(0);
});
test("insertion order cannot change independently specified full header bytes", () => {
	const c = capture(); const reversed = Object.fromEntries(Object.entries(c).reverse());
	expect(Reflect.apply(buildExactObjectHeaderAadV1, undefined, [reversed])).toEqual(bytes(C_EXPECTED));
});
test("32768byte header accepted,32769 rejected, pair checks both budgets", () => {
	const skeleton = C_EXPECTED.replace('"sourceBinding":{}', '"sourceBinding":{"pad":""}');
	const pad = "x".repeat(32768 - bytes(skeleton).byteLength);
	const c = { ...capture(), sourceBinding: { pad } };
	const literal = C_EXPECTED.replace('"sourceBinding":{}', `"sourceBinding":{"pad":"${pad}"}`);
	expect(bytes(literal).byteLength).toBe(32768);
	expect(buildExactObjectHeaderAadV1(c)).toEqual(bytes(literal));
	rejectBuild({ ...c, sourceBinding: { pad: `${pad}x` } });
	rejectPair(c, { ...prepared(), sourceBinding: { pad } }); //P extras exceed budget.
	rejectPair({ ...c, sourceBinding: { pad: `${pad}x` } }, prepared());
});
test("returned bytes are owned and later calls do not alias earlier outputs", () => {
	const c = capture(); const first = buildExactObjectHeaderAadV1(c); const second = buildExactObjectHeaderAadV1(c);
	first.fill(0); expect(second).toEqual(bytes(C_EXPECTED));
	expect(buildExactObjectHeaderAadV1(c)).toEqual(bytes(C_EXPECTED));
});
test("errors are fixed and do not carry secret values, causes or codec errors", () => {
	const secret = "SECRET_SENTINEL_NOT_IN_ERROR"; let caught: unknown;
	try { Reflect.apply(buildExactObjectHeaderAadV1, undefined, [{ ...capture(), extra: secret }]); } catch (error) { caught = error; }
	expect(caught).toBeInstanceOf(Error);
	if (!(caught instanceof Error)) throw new Error("missing rejection");
	expect(caught.name).toBe("ExactObjectHeaderError"); expect(caught.message).toBe("Exact object header rejected"); expect(caught.message.includes(secret)).toBe(false); expect(Object.hasOwn(caught, "cause")).toBe(false);
});
