import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { deviceKeys } from "./queries";

/** A code the person types into the runner's command line. It is good for one machine, once. */
export type PairingCode = {
  code: string;
  expiresAt: string;
};

export function mintPairCodeMutationOptions() {
  return mutationOptions({
    mutationFn: (): Promise<PairingCode> =>
      client("/api/devices/pair", {
        method: "POST",
        fallback: "A pairing code could not be made.",
      }).then(async (response) => {
        const body = (await response.json()) as {
          code: string;
          expiresAt: string;
        };
        return { code: body.code, expiresAt: body.expiresAt };
      }),
  });
}

export function removeDeviceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      await client(`/api/devices/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "That device could not be removed.",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: deviceKeys.all }),
  });
}

export function reviewDeviceActionMutationOptions(
  queryClient: QueryClient,
  id: string,
) {
  return mutationOptions({
    mutationFn: async (input: {
      key: string;
      resolution: "checked_executed" | "checked_not_executed";
      note: string;
      confirmedChecked: true;
    }) => {
      const response = await client(
        `/api/devices/${encodeURIComponent(id)}/actions/review`,
        {
          method: "POST",
          body: input,
          fallback: "核查结果未保存，请重新加载记录后确认。",
        },
      );
      return response.json() as Promise<{
        ok: true;
        uncertain: number;
        paused: boolean;
      }>;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: deviceKeys.all }),
  });
}
