import { act } from "react";

/**
 * DRAIN REACT BEFORE TAKING THE DOCUMENT AWAY.
 *
 * The same helper as `openbot/app/tests/settle-react-work.ts`, for the same reason; read that file
 * for the full mechanics. In short: every React test file here registers happy-dom in `beforeAll`
 * and unregisters it in `afterAll`. `cleanup` in `afterEach` unmounts what a test rendered, but it
 * does not retract a callback React's scheduler has ALREADY posted — for example the passive-effect
 * flush a commit outside `act` schedules (`schedulerEvent = window.event`). If that callback is
 * still pending when `GlobalRegistrator.unregister()` runs, it fires with `window` gone and bun
 * reports `# Unhandled error between tests`: every test passing, a non-zero exit, and a stack in
 * `scheduler.development.js` next to whichever file bun reached around then. Seen on the Windows
 * runner after `WindowsBlocker.test.tsx`; a rerun passed, because it is a race.
 *
 * `act` rather than a `setTimeout`: while an act scope is open React routes newly scheduled work
 * into its own queue and alternates flushing it with yielding a macrotask (on the same
 * `setImmediate` the scheduler posts on) until a yield comes back with nothing left — a fixed point,
 * not a guessed number of turns.
 *
 * `act` needs `IS_REACT_ACT_ENVIRONMENT`, which `@testing-library/react` sets when imported; every
 * caller renders through it.
 */
export async function settleReactWork(): Promise<void> {
  await act(async () => {});
}
