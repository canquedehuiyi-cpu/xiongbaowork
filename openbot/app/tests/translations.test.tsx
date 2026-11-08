import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
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
