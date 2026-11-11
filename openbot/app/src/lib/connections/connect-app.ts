import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  addCuratedServerMutationOptions,
  connectAccountMutationOptions,
  invalidatePlugins,
} from "@/lib/plugins/mutations";
import {
  appKeyOf,
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * One press of a tile on the personal edition's Connections: add the app if it isn't added yet,
 * then, for an app reached as you, go to its consent screen.
 *
 * Signing in needs an OAuth client to consent against. An app that registers its own (Notion) has
 * one the moment it is added; one that needs a client typed in first (Google Drive) is sent to its
 * page, which is where that is done, already added so the page opens on that step.
 */
export function useConnectApp() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const add = useMutation(addCuratedServerMutationOptions(queryClient));
  const connect = useMutation(connectAccountMutationOptions("settings"));
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const freshServer = async (key: string) =>
    (
      await queryClient.fetchQuery({
        ...pluginsPageQueryOptions(),
        staleTime: 0,
      })
    ).servers.find(
      /*
       * By the row's id or its catalogue key: a curated connector added since G01-E is the row
       * `team:<key>` while the tile names it `<key>`, so matching the id alone would re-add it on
       * every press and never find it to connect.
       */
      (item) => item.id === key || appKeyOf(item) === key,
    );

  async function run(key: string, action: "connect" | "add") {
    setError(null);
    setPending(key);
    try {
      if (!(await freshServer(key))) await add.mutateAsync({ key });
      if (action === "add") {
        await invalidatePlugins(queryClient);
        return;
      }
      const server = await freshServer(key);
      if (!server || (!server.hasCredential && !server.dynamicClient)) {
        await navigate({ to: "/connections/$key", params: { key } });
        return;
      }
      /*
       * 授权链接就去；`{ connected: true }`（X8，厂商已经持有全部权限，路由当场记下了连接）和 null
       * （字段式连接，没有链接）都没有页面要去，落到下面重读连接状态。
       */
      const start = await connect.mutateAsync(server.id);
      if (start && "authorizationUrl" in start) {
        window.location.href = start.authorizationUrl;
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: connectionsQueryOptions().queryKey,
      });
    } catch (thrown) {
      setError((thrown as Error).message);
    } finally {
      setPending(null);
    }
  }

  return { run, pending, error };
}
