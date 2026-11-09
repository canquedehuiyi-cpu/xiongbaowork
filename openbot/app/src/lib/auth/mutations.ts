import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
import { forgetSession } from "@/lib/session-memory";
=======
import { clearSkin } from "@/skins/store";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
import { authKeys } from "./queries";

async function signOut() {
  await client("/api/auth/sign-out", {
    method: "POST",
    // What a refused sign-out means whoever answers it (Better Auth puts its sentence where `client` does not read).
    fallback: "Signing out did not finish. Try again.",
  });
}

/**
 * Every way out of OpenBot signs out through here, the skins' own menus included.
 *
 * The skin is the account's, and this browser only caches it to paint before the preferences load.
 * Clearing it here means the next person on a shared machine starts from the default rather than
 * from the last person's skin.
 */
export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: signOut,
    onSuccess: () => {
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
      forgetSession();
      queryClient.removeQueries({ queryKey: authKeys.all });
    },
=======
      clearSkin();
      queryClient.removeQueries({ queryKey: authKeys.all });
    },
  });
}

/** Saves the person's display name, then refreshes who they are. */
export function updateProfileNameMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (name: string) =>
      client("/api/me/profile", "profile", {
        method: "PATCH",
        body: { name },
        fallback: "Your name could not be saved",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: authKeys.currentUser(),
        refetchType: "all",
      }),
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  });
}
