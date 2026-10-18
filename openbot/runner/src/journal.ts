import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { actionFingerprint } from "../../shared/runner-actions";
import type { ActionOutcome, RunnerAction } from "./execute";

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
          return JSON.parse(row.outcome) as ActionOutcome;
        return unknown();
      }
      const result = (async () => {
        try {
          const outcome = await execute(action);
          finish.run("completed", JSON.stringify(outcome), scope, key);
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
