export type SelfHostBanner = {
  /** Whether to offer help self-hosting. Never throws. */
  shown: () => Promise<boolean>;
};

/**
 * Decide, per deployment, whether the self-host banner shows: the operator's switch
 * (`OPENBOT_SELF_HOST_BANNER`) alone.
 */
export function createSelfHostBanner(options: {
  enabled: boolean;
}): SelfHostBanner {
  return {
    shown: async () => options.enabled,
  };
}
