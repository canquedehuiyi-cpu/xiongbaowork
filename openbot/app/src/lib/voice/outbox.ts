import type { SaveVoiceSessionInput } from "@openbot/shared/voice-session";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { compatSuffixes, readCompat, removeCompat } from "@/lib/storage-compat";
import { queryClient } from "@/query-client";

const LEGACY_PREFIX = "openbot:voice-outbox:";
const PREFIX = "xiongbao:voice-outbox:";
export const voiceCallOwner = () =>
  queryClient.getQueryData<AuthenticatedUser>(authKeys.currentUser())?.id;
const suffix = (
  call: Pick<SaveVoiceSessionInput, "channelId" | "id">,
  userId: string,
) =>
  `${encodeURIComponent(userId)}:${encodeURIComponent(call.channelId)}:${encodeURIComponent(call.id)}`;
const key = (
  call: Pick<SaveVoiceSessionInput, "channelId" | "id">,
  userId: string,
) => PREFIX + suffix(call, userId);

/** Per-user recovery across reload/tab closure; confirmed saves are removed. No audio is stored. */
export function rememberVoiceCall(
  call: SaveVoiceSessionInput,
  userId = voiceCallOwner(),
): boolean {
  try {
    if (!userId) return false;
    localStorage.setItem(key(call, userId), JSON.stringify(call));
    return true;
  } catch {
    return false;
  }
}

export function forgetVoiceCall(
  call: Pick<SaveVoiceSessionInput, "channelId" | "id">,
  userId = voiceCallOwner(),
) {
  try {
    if (userId)
      removeCompat(key(call, userId), LEGACY_PREFIX + suffix(call, userId));
  } catch {
    /* Storage can be disabled; the database already holds this call. */
  }
}

export function recoverVoiceCalls(channelId: string): SaveVoiceSessionInput[] {
  try {
    const userId = voiceCallOwner();
    if (!userId) return [];
    const prefix = `${encodeURIComponent(userId)}:${encodeURIComponent(channelId)}:`;
    const recovered: SaveVoiceSessionInput[] = [];
    for (const name of compatSuffixes(PREFIX, LEGACY_PREFIX)) {
      if (!name.startsWith(prefix)) continue;
      const raw = readCompat(PREFIX + name, LEGACY_PREFIX + name);
      if (!raw || raw.length > 400_000) continue;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        continue;
      }
      if (isVoiceCall(value) && value.channelId === channelId)
        recovered.push(value);
    }
    return recovered;
  } catch {
    return []; /* No recovery when the browser disables local storage. */
  }
}

function isVoiceCall(value: unknown): value is SaveVoiceSessionInput {
  if (!value || typeof value !== "object") return false;
  const call = value as Record<string, unknown>;
  return (
    typeof call.id === "string" &&
    typeof call.channelId === "string" &&
    (call.anchorMessageId === null ||
      typeof call.anchorMessageId === "string") &&
    typeof call.startedAt === "string" &&
    Number.isFinite(Date.parse(call.startedAt)) &&
    typeof call.endedAt === "string" &&
    Number.isFinite(Date.parse(call.endedAt)) &&
    Date.parse(call.endedAt) >= Date.parse(call.startedAt) &&
    Array.isArray(call.transcript) &&
    call.transcript.length <= 300 &&
    call.transcript.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        (entry.role === "user" || entry.role === "assistant") &&
        typeof entry.text === "string",
    )
  );
}
