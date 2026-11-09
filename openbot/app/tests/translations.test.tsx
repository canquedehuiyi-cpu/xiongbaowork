import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { TranslatedInstructions } from "@/components/skills/translated-instructions";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { translationKeys, useZh } from "@/lib/translations/queries";

/*
 * Skills and plugins that arrived in English are shown in Chinese where a translation exists, and as
 * written where none does yet. The original is what is stored and given to a model; only the label
 * a person reads changes.
 */

let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register({ url: "http://localhost:3010" });
    registeredHere = true;
  }
});
afterEach(() => cleanup());
afterAll(() => {
  if (registeredHere) GlobalRegistrator.unregister();
});

function Label({ text }: { text: string }) {
  const zh = useZh();
  return <span>{zh(text)}</span>;
}

test("a translated text is shown in Chinese and an untranslated one as written", () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(translationKeys.plugins, {
    "Search files in Google Drive": "搜索 Google Drive 中的文件",
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Label text="Search files in Google Drive" />
      <Label text="Send a weekly digest" />
    </QueryClientProvider>,
  );
  expect(view.getByText("搜索 Google Drive 中的文件")).toBeTruthy();
  expect(view.getByText("Send a weekly digest")).toBeTruthy();
});

test("with no query client the original is shown and nothing is fetched", () => {
  const view = render(<Label text="Search files in Google Drive" />);
  expect(view.getByText("Search files in Google Drive")).toBeTruthy();
});

test("a skill's English instructions get a folded Chinese reading under the original", () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(translationKeys.plugins, {
    "Summarise the week's sales.": "汇总本周的销售情况。",
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TranslatedInstructions text="Summarise the week's sales." />
      <TranslatedInstructions text="已经是中文的指令" />
    </QueryClientProvider>,
  );
  const blocks = view.container.querySelectorAll(
    "[data-slot=translated-instructions]",
  );
  expect(blocks.length).toBe(1);
  expect(blocks[0]?.textContent).toContain("汇总本周的销售情况。");
  expect(blocks[0]?.textContent).toContain("生效的是上面的原文");
});

test("the / menu describes a skill in Chinese and carries no instruction of its own", () => {
  // Seeded and never stale, so the probe reads the cache and asks no server.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
  });
  queryClient.setQueryData(translationKeys.plugins, {
    "Weekly sales digest": "每周销售摘要",
  });
  queryClient.setQueryData(agentPluginsQueryOptions("bot-1").queryKey, {
    skills: [
      {
        slug: "digest",
        title: "Digest",
        summary: "Weekly sales digest",
        instructions: "Summarise the week's sales.",
      },
    ],
  } as never);
  let commands: ReturnType<typeof useSkillCommands> = [];
  function Probe() {
    commands = useSkillCommands("bot-1");
    return null;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );
  expect(commands[0]?.description).toBe("每周销售摘要");
  expect(commands[0]?.name).toBe("Digest");
  // 服务端按消息开头的 `/digest` 找技能并把说明交给员工（上游 #1226），浏览器不再带说明。
  expect(commands[0]?.prompt).toBeUndefined();
  expect(commands[0]?.kind).toBe("chip");
});
