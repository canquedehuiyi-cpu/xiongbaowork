import { afterEach, expect, test } from "bun:test";
import { composioAppsQueryOptions } from "@/lib/plugins/queries";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Runs the directory query against a failure that carries no server message at all.
 *
 * 熊宝中文版的目录只服务 Composio（Arcade 不收），所以只有这一个目录。
 */
async function failureMessage() {
  globalThis.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
  const options = composioAppsQueryOptions("");
  try {
    await (options.queryFn as (ctx: unknown) => Promise<unknown>)({});
  } catch (thrown) {
    return (thrown as Error).message;
  }
  throw new Error("the query was expected to fail");
}

test("a messageless directory failure is the directory screen's sentence, and names no broker", async () => {
  const message = await failureMessage();
  expect(message).toBe("读不到可以连接的应用。请刷新页面。");
  expect(message).not.toMatch(/composio|arcade/i);
});
