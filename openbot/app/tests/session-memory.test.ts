import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  rememberWakersSearch,
  wakersReturnSearch,
} from "@/components/wakers/wakers-search";
import { signOutMutationOptions } from "@/lib/auth/mutations";

/*
 * What a page remembers for the person using it lives in module memory for the life of the tab. A
 * sign-out ends that person's session, so it must not carry over to whoever signs in next in the
 * same tab: the 员工管理 back link used to bring the previous account's search and filters with it.
 */
test("signing out forgets the 员工管理 wall the back link returns to", async () => {
  rememberWakersSearch({ q: "周报", status: "working" });
  expect(wakersReturnSearch()).toEqual({ q: "周报", status: "working" });

  const options = signOutMutationOptions(new QueryClient());
  await options.onSuccess?.(undefined, undefined, undefined, {} as never);

  expect(wakersReturnSearch()).toEqual({});
});
