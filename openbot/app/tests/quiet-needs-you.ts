import type { QueryClient } from "@tanstack/react-query";
import { approvalInboxOptions } from "@/lib/approvals";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  proactiveKeys,
  proactiveSuggestionsQueryOptions,
} from "@/lib/proactive";
import { taskListQueryOptions } from "@/lib/tasks/queries";

/**
 * 员工页（`/bots`）顶上是上游的「需要你」看板（M5b），它读审批收件箱、巡检发现、任务和会话列表。测员工卡片的
 * 文件不关心这些读取，用这个把它们种成「什么都没有在等你」，免得一个故意全部失败的 fetch 在页面上多出几条与
 * 被测内容无关的提示。只在 `staleTime: Infinity` 的 QueryClient 上管用：种好的数据不会被重新读取。
 */
export function seedQuietNeedsYou(client: QueryClient) {
  client.setQueryData(approvalInboxOptions().queryKey, {
    questions: [],
    requests: [],
  } as never);
  client.setQueryData(proactiveSuggestionsQueryOptions().queryKey, []);
  client.setQueryData(proactiveKeys.settings, { settings: [] });
  client.setQueryData(taskListQueryOptions().queryKey, []);
  client.setQueryData(channelListQueryOptions().queryKey, {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  } as never);
}
