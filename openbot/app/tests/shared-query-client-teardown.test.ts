import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { authKeys } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";

/**
 * A file that leaves something in the app's own query client.
 *
 * Screens read the signed-in person, the deployment's capabilities and more through `@/query-client`,
 * one object for the whole process. A person a fetch stand-in had answered with no person in it,
 * left there by one file, was what the next file read, kept as fresh for a minute: whichever file
 * happened to run next failed. react-teardown.ts, loaded by the preload, empties that client when a
 * file takes its document away. Without it, this test sees the person still cached afterwards.
 */
test("what a file cached in the app's own query client is gone once its document goes", async () => {
  GlobalRegistrator.register();
  try {
    queryClient.setQueryData(authKeys.currentUser(), { openbotVersion: null });
    expect(queryClient.getQueryCache().findAll()).toHaveLength(1);

    // Not awaited, as most files call it.
    void GlobalRegistrator.unregister();
    expect(GlobalRegistrator.isRegistered).toBe(false);
    expect(queryClient.getQueryData(authKeys.currentUser())).toBeUndefined();
    expect(queryClient.getQueryCache().findAll()).toHaveLength(0);
  } finally {
    if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
    queryClient.clear();
  }
});
