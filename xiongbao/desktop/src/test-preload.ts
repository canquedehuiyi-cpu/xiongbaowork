import { afterEach } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Each DOM test file registers happy-dom in beforeAll and unregisters it in afterAll, which deletes
// `window` from the global object at once. React queues work outside act() (an update a test
// waits for with waitFor or findBy*, and the passive effects of its commit) on its Scheduler,
// which runs it on a later setImmediate. When a file's last test ends while such work is still
// queued, nothing gives it a turn before afterAll: the queued callback then runs with `window`
// gone and throws on its first line (`schedulerEvent = window.event`) as an "Unhandled error
// between tests". Bun counts it ("1 error") and exits 1 although every test passed. Whether work
// is still queued depends on timing, so the Windows runner hit it now and then.
//
// After each test, and after the file's own afterEach (cleanup()) has unmounted what it rendered,
// wait for the Scheduler to run what is already queued, while the DOM still exists. A task at
// idle priority runs after every task queued before it.
const scheduler = createRequire(
  createRequire(import.meta.url).resolve("react-dom"),
)("scheduler") as {
  unstable_IdlePriority: number;
  unstable_scheduleCallback: (
    priority: number,
    callback: () => void,
  ) => unknown;
};

afterEach(async () => {
  if (!GlobalRegistrator.isRegistered) return;
  await new Promise<void>((resolve) => {
    scheduler.unstable_scheduleCallback(scheduler.unstable_IdlePriority, () => {
      resolve();
    });
  });
});
