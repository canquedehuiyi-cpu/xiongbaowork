import { canonicalExactInputJsonV1 } from "./exact-input-json";

export const EXACT_OBJECT_HEADER_VERSION = "OPENBOT_APPROVAL_EXACT_HEADER_V1";

type CommonRow = Readonly<{
	id: string;
	codecVersion: "OPENBOT_EXACT_INPUT_JSON_V1";
	approvalId: string;
	tenantId: string;
	ownerUserId: string;
	actorUserId: string;
	domainId: string;
	threadId: string;
	agentId: string;
	approvalRunId: string;
	sourceActualRunId: string;
	toolCallId: string;
	actionDigest: string;
	sourceBindingVersion: "OPENBOT_APPROVAL_EXACT_SOURCE_BINDING_V1";
	sourceBinding: Readonly<Record<string, unknown>>;
	plaintextSha256: string;
	keyVersion: string;
	envelopeWireVersion: "OPENBOT_APPROVAL_EXACT_WIRE_V1";
}>;
export type CaptureHeaderRow = CommonRow & Readonly<{ stage: "capture" }>;
export type PreparedHeaderRow = CommonRow & Readonly<{
	stage: "prepared";
	captureId: string;
	captureSha256: string;
	savedResultDigest: string;
	admissionId: string;
	inputDigest: string;
	planIdentity: string;
	planRunId: string;
	targetRunId: string;
}>;
export type ExactHeaderRow = CaptureHeaderRow | PreparedHeaderRow;

const COMMON = ["id", "codecVersion", "stage", "approvalId", "tenantId", "ownerUserId", "actorUserId", "domainId", "threadId", "agentId", "approvalRunId", "sourceActualRunId", "toolCallId", "actionDigest", "sourceBindingVersion", "sourceBinding", "plaintextSha256", "keyVersion", "envelopeWireVersion"];
const EXTRA = ["captureId", "captureSha256", "savedResultDigest", "admissionId", "inputDigest", "planIdentity", "planRunId", "targetRunId"];
const TEXT_SCOPE = ["approvalId", "tenantId", "ownerUserId", "actorUserId", "threadId", "agentId", "approvalRunId", "sourceActualRunId", "toolCallId", "actionDigest", "sourceBindingVersion", "codecVersion"];
const SHARED = [...TEXT_SCOPE, "domainId"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

/**
 * Internal header component only. Trusted upstream OWNED non-Proxy data must
 * bound row construction BEFORE growth to <=28 ALL own keys (including Symbols
 * and nonenumerables); C19/P27 remain the only legal shapes. Reflect.ownKeys
 * snapshots before defensive checks, so TS/plain/non-Proxy alone is no bound.
 * Full sourceBinding must meet the codec materializer construction precondition:
 * <=20001 nodes, <=10002 ALL own keys/container, <=40001 ALL own keys overall.
 * Actual trusted materializer/registry/provider/producer are UNIMPLEMENTED.
 * This is not a raw parser, Proxy sandbox, SHA verifier, permit or DB writer.
 *
 * Future caller: full plaintext canonical bytes -> full SHA256 -> this header
 * callerAAD (<=32768) -> existing AEAD framing -> existing wire conversion.
 * No own header hash/envelope/createdAt, second hash or double AEAD prefix.
 * P carries full result-dependent executionInput, not publicProjection or C's
 * input. Full payload/ref equality and prepared+ledger physical tx are external.
 */
function fail(): never {
	const error = new Error("Exact object header rejected");
	error.name = "ExactObjectHeaderError";
	throw error;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (const [index, byte] of left.entries()) if (right[index] !== byte) return false;
	return true;
}

function validated(row: ExactHeaderRow): { fields: Map<string, unknown>; binding: Uint8Array; aad: Uint8Array } {
	if (!row || (Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null)) fail();
	const keys = Reflect.ownKeys(row);
	const fields = new Map<string, unknown>();
	// Review every descriptor before reading any data value, including stage.
	const descriptors = new Map<string, PropertyDescriptor>();
	for (const key of keys) {
		if (typeof key !== "string") fail();
		const descriptor = Object.getOwnPropertyDescriptor(row, key);
		if (!descriptor) fail();
		if (!descriptor.enumerable || !("value" in descriptor)) fail();
		descriptors.set(key, descriptor);
	}
	for (const [key, descriptor] of descriptors) fields.set(key, descriptor.value);
	const stage = fields.get("stage");
	if (stage !== "capture" && stage !== "prepared") fail();
	const expected = stage === "capture" ? COMMON : [...COMMON, ...EXTRA];
	if (keys.length !== expected.length || expected.some((key) => !fields.has(key))) fail();
	for (const key of expected) if (key !== "sourceBinding" && typeof fields.get(key) !== "string") fail();
	for (const key of stage === "capture" ? ["id", "domainId"] : ["id", "domainId", "captureId"]) {
		const value = fields.get(key);
		if (typeof value !== "string" || value.length !== 36 || !UUID.test(value)) fail();
	}
	for (const key of stage === "capture" ? ["plaintextSha256"] : ["plaintextSha256", "captureSha256"]) {
		const value = fields.get(key);
		if (typeof value !== "string" || value.length !== 64 || !SHA.test(value)) fail();
	}
	if (fields.get("codecVersion") !== "OPENBOT_EXACT_INPUT_JSON_V1" || fields.get("sourceBindingVersion") !== "OPENBOT_APPROVAL_EXACT_SOURCE_BINDING_V1" || fields.get("envelopeWireVersion") !== "OPENBOT_APPROVAL_EXACT_WIRE_V1") fail();
	const keyVersion = fields.get("keyVersion");
	if (typeof keyVersion !== "string" || keyVersion.length === 0) fail();
	const encoder = new TextEncoder();
	let scopeBytes = 0;
	for (const key of TEXT_SCOPE) {
		const value = fields.get(key);
		if (typeof value !== "string" || value.length === 0 || value.length > 1536) fail();
		// UTF16 length bound precedes this small bounded UTF8 allocation.
		scopeBytes += encoder.encode(value).byteLength;
		if (scopeBytes > 1536) fail();
	}
	const sourceBinding = fields.get("sourceBinding");
	if (!sourceBinding || typeof sourceBinding !== "object" || Array.isArray(sourceBinding) || (Object.getPrototypeOf(sourceBinding) !== Object.prototype && Object.getPrototypeOf(sourceBinding) !== null)) fail();
	const binding = canonicalExactInputJsonV1(sourceBinding);
	const header: Record<string, unknown> = { headerVersion: EXACT_OBJECT_HEADER_VERSION };
	for (const key of expected) header[key === "id" ? "objectId" : key] = fields.get(key);
	const aad = canonicalExactInputJsonV1(header);
	if (aad.byteLength < 1 || aad.byteLength > 32768) fail();
	return { fields, binding, aad };
}

export function buildExactObjectHeaderAadV1(row: ExactHeaderRow): Uint8Array {
	try { return validated(row).aad; } catch { fail(); }
}

export function assertExactCapturePreparedHeaderPairV1(capture: CaptureHeaderRow, prepared: PreparedHeaderRow): void {
	try {
		const c = validated(capture);
		const p = validated(prepared);
		if (c.fields.get("stage") !== "capture" || p.fields.get("stage") !== "prepared") fail();
		for (const key of SHARED) if (c.fields.get(key) !== p.fields.get(key)) fail();
		if (p.fields.get("captureId") !== c.fields.get("id") || p.fields.get("captureSha256") !== c.fields.get("plaintextSha256") || !sameBytes(c.binding, p.binding)) fail();
		// Own IDs/SHA/keyVersion/stages and source/plan/target run roles need not
		// equal. This check neither recomputes plaintext SHA nor checks plan/ledger
		// inputDigest equality, full config/tool/transform refs, DB RLS or authority.
	} catch { fail(); }
}
