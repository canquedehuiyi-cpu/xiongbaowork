import type {
  WhatIfAction,
  WhatIfLabels,
  WhatIfRecorded,
  WhatIfResult,
} from "@xiongbao/shared/what-if";
import { client } from "@/lib/client";

/**
 * A question read as one action, for the admin to confirm, or why it couldn't be. `missing` says what
 * is still to choose before the action can be checked.
 */
export type WhatIfReading =
  | {
      understood: "yes";
      action: WhatIfAction;
      labels: WhatIfLabels;
      missing: string | null;
    }
  | { understood: "no"; unclear: string };

export type WhatIfChecked = {
  action: WhatIfAction;
  labels: WhatIfLabels;
  result: WhatIfResult;
};

/** An audit row's action, what the row recorded, and what the controls say about it now. */
export type WhatIfExplained = WhatIfChecked & { recorded: WhatIfRecorded };

/*
 * Plain functions rather than queries or mutations: each is a verdict about this moment, nothing is
 * cached and nothing is saved. The server records each question and each check on the trail.
 */

/** Question in, action out. The model only names the action; nothing is decided yet. */
export async function askWhatIf(question: string): Promise<WhatIfReading> {
  const response = await client("/api/admin/what-if/ask", {
    method: "POST",
    body: { question },
    fallback: "没读懂这个问题。再试一次，或者自己指定动作。",
  });
  return (await response.json()) as WhatIfReading;
}

/** An action in, what every control decides out. No model is asked. */
export async function checkWhatIf(
  action: WhatIfAction,
  question?: string,
): Promise<WhatIfChecked> {
  const response = await client("/api/admin/what-if/check", {
    method: "POST",
    body: { action, ...(question ? { question } : {}) },
    fallback: "没能核对这个动作。再试一次。",
  });
  return (await response.json()) as WhatIfChecked;
}

/** "Why did this happen?" about one audit row, from what the row recorded. No model is asked. */
export async function explainAuditEvent(
  eventId: string,
): Promise<WhatIfExplained> {
  const response = await client(
    `/api/admin/what-if/explain/${encodeURIComponent(eventId)}`,
    { fallback: "没能解释这次事件。再试一次。" },
  );
  return (await response.json()) as WhatIfExplained;
}
