import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DESKTOP_CLIPBOARD_NOT_KEPT } from "../../shared/desktop-control";
import { actionFingerprint } from "../../shared/runner-actions";
import type { ActionOutcome, RunnerAction } from "./execute";

const CLIPBOARD_READ = "desktop.clipboard_read";

/**
 * What the journal keeps of a result. A desktop screenshot is large and sensitive and is never
 * needed to answer a replay, so its bytes are dropped (its size stays). A desktop session (the
 * `session` of `desktop.session_status`, which carries the session token) is dropped whole: the
 * token lives only in memory (plan docs/plans/2026-11-12-desktop-write.md, design decision 5), and a
 * replayed status without a session makes the server ask the device again or ask the owner again,
 * never skip a question. What `desktop.clipboard_read` read is kept as its length only (plan
 * docs/plans/2026-11-12-desktop-write.md: clipboard contents are recorded by length alone), so a
 * replay of it answers `DESKTOP_CLIPBOARD_NOT_KEPT` (`replayed`). Everything else is kept.
 */
function journaled(action: string, outcome: ActionOutcome): ActionOutcome {
  if (!action.startsWith("desktop.") || !outcome.ok) return outcome;
  const output = outcome.output;
  if (action === CLIPBOARD_READ) {
    const read = (output ?? {}) as { text?: unknown; truncated?: unknown };
    return {
      ok: true,
      output: {
        chars: typeof read.text === "string" ? [...read.text].length : 0,
        truncated: read.truncated === true,
      },
    };
  }
  if (typeof output !== "object" || output === null) return outcome;
  let kept = output as Record<string, unknown>;
  if ("session" in kept) {
    const { session: _session, ...rest } = kept;
    kept = rest;
  }
  const image = kept.image;
  if (typeof image === "object" && image !== null && "base64" in image) {
    const { base64: _bytes, ...rest } = image as Record<string, unknown>;
    kept = { ...kept, image: rest };
  }
  return kept === output ? outcome : { ok: true, output: kept };
}

/** A stored outcome as a replay answers it: a clipboard read that went through cannot be given back. */
function replayed(action: string, outcome: ActionOutcome): ActionOutcome {
  if (action === CLIPBOARD_READ && outcome.ok)
    return { ok: false, error: DESKTOP_CLIPBOARD_NOT_KEPT };
  return outcome;
}

/** The claim is flushed before touching the machine. Restarting never replays an unfinished claim. */
export function createActionJournal(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", { flag: "a", mode: 0o600 });
  chmodSync(path, 0o600);
  const database = new Database(path, { create: true, strict: true });
  database.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;",
  );
  database.exec(
    "CREATE TABLE IF NOT EXISTS actions (scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, outcome TEXT, PRIMARY KEY(scope, key));",
  );
  const claim = database.query(
    "INSERT INTO actions(scope,key,fingerprint,state) VALUES (?,?,?,'running') ON CONFLICT DO NOTHING",
  );
  const read = database.query<
    { fingerprint: string; state: string; outcome: string | null },
    [string, string]
  >("SELECT fingerprint,state,outcome FROM actions WHERE scope=? AND key=?");
  const finish = database.query(
    "UPDATE actions SET state=?,outcome=? WHERE scope=? AND key=? AND state='running'",
  );
  const running = new Map<string, Promise<ActionOutcome>>();
  const unknown = (): ActionOutcome => ({
    ok: false,
    error:
      "This action may already have run. Check the machine before requesting another action.",
    outcomeUnknown: true,
  });
  return {
    async execute(
      scope: string,
      key: string,
      action: RunnerAction,
      execute: (action: RunnerAction) => Promise<ActionOutcome>,
    ): Promise<ActionOutcome> {
      if (!scope || !key || key.length > 2000)
        return { ok: false, error: "A stable action identity is required." };
      const fingerprint = actionFingerprint(action.action, action.payload);
      const identity = JSON.stringify([scope, key]);
      const written = claim.run(scope, key, fingerprint);
      if (!written.changes) {
        const row = read.get(scope, key);
        if (!row || row.fingerprint !== fingerprint)
          return {
            ok: false,
            error: "This action id belongs to another request.",
          };
        const pending = running.get(identity);
        if (pending) return pending;
        if (row.state === "completed" && row.outcome)
          return replayed(
            action.action,
            JSON.parse(row.outcome) as ActionOutcome,
          );
        return unknown();
      }
      const result = (async () => {
        try {
          const outcome = await execute(action);
          finish.run(
            "completed",
            JSON.stringify(journaled(action.action, outcome)),
            scope,
            key,
          );
          return outcome;
        } catch {
          finish.run("unknown", null, scope, key);
          return unknown();
        } finally {
          running.delete(identity);
        }
      })();
      running.set(identity, result);
      return result;
    },
    close: () => database.close(),
  };
}
