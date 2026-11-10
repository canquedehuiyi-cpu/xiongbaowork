import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelLibraryGuide } from "@/components/onboarding/model-library-guide";
import { type ConnectedModel, modelKeys } from "@/lib/models/queries";

/**
 * Story J1: after sign-up, a tenant with an empty model library is pointed at connecting one.
 *
 * The guide reads the same `GET /api/models` the resources screen's model zone does, so these answer
 * that read and nothing else. Shown on an empty library, gone the moment one model is there, gone
 * when the read failed (an unknown library is not an empty one), and dismissible without connecting.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let library: { status: number; models: ConnectedModel[] } = {
  status: 200,
  models: [],
};
/** When set, the library read waits on this before answering, so the loading state can be seen. */
let libraryGate: Promise<void> | undefined;
let openLibraryGate = () => {};

beforeEach(() => {
  library = { status: 200, models: [] };
  libraryGate = undefined;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = String(input).split("?")[0];
      if (path === "/api/models") {
        if (libraryGate) await libraryGate;
        if (library.status !== 200) {
          return new Response(null, { status: library.status });
        }
        return new Response(
          JSON.stringify({ models: library.models, templates: [] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  // A test that failed while the read was held must not leave it waiting forever.
  openLibraryGate();
  openLibraryGate = () => {};
  global.fetch = originalFetch;
});

const MODEL: ConnectedModel = {
  id: "model-1",
  provider: "openai",
  baseUrl: null,
  modelName: "gpt-test",
  label: null,
  enabled: true,
  updatedAt: "2026-11-01T00:00:00.000Z",
  coworkers: 0,
};

function renderGuide(onConnect: () => void = () => {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    client,
    view: render(
      <QueryClientProvider client={client}>
        <p>wizard</p>
        <ModelLibraryGuide onConnect={onConnect} />
      </QueryClientProvider>,
    ),
  };
}

test("an empty library shows the guide, and its button goes to connect a model", async () => {
  let connects = 0;
  const { view } = renderGuide(() => {
    connects += 1;
  });

  const region = await view.findByRole("region", { name: "接入模型" });
  expect(region.textContent).toContain("还没有接入任何模型");

  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(view.getByRole("button", { name: "去能力与资源接入模型" }));
  expect(connects).toBe(1);
});

test("a library with a model shows no guide", async () => {
  library = { status: 200, models: [MODEL] };
  const { client, view } = renderGuide();

  await waitFor(() =>
    expect(client.getQueryState(modelKeys.library())?.status).toBe("success"),
  );
  expect(view.queryByRole("region", { name: "接入模型" })).toBeNull();
  expect(view.queryByText("还没有接入任何模型")).toBeNull();
  // The rest of the screen is untouched: the guide never stands in for it.
  expect(view.getByText("wizard")).toBeTruthy();
});

test("a library still loading shows no guide, and an empty answer then shows it", async () => {
  libraryGate = new Promise<void>((resolve) => {
    openLibraryGate = resolve;
  });
  const { client, view } = renderGuide();

  await waitFor(() =>
    expect(client.getQueryState(modelKeys.library())?.fetchStatus).toBe(
      "fetching",
    ),
  );
  expect(client.getQueryState(modelKeys.library())?.status).toBe("pending");
  expect(view.queryByRole("region", { name: "接入模型" })).toBeNull();
  expect(view.getByText("wizard")).toBeTruthy();

  openLibraryGate();
  await view.findByRole("region", { name: "接入模型" });
});

test("the guide goes away once the library holds a model", async () => {
  const { client, view } = renderGuide();
  await view.findByRole("region", { name: "接入模型" });

  library = { status: 200, models: [MODEL] };
  await client.invalidateQueries({ queryKey: modelKeys.library() });

  await waitFor(() =>
    expect(view.queryByRole("region", { name: "接入模型" })).toBeNull(),
  );
  expect(view.queryByText("还没有接入任何模型")).toBeNull();
});

test("a library that could not be read shows no guide", async () => {
  library = { status: 500, models: [] };
  const { client, view } = renderGuide();

  await waitFor(() =>
    expect(client.getQueryState(modelKeys.library())?.status).toBe("error"),
  );
  expect(view.queryByRole("region", { name: "接入模型" })).toBeNull();
});

test("the guide is dismissed without connecting anything", async () => {
  let connects = 0;
  const { view } = renderGuide(() => {
    connects += 1;
  });

  await view.findByRole("region", { name: "接入模型" });
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(view.getByRole("button", { name: "暂不接入" }));

  expect(view.queryByRole("region", { name: "接入模型" })).toBeNull();
  expect(connects).toBe(0);
  expect(view.getByText("wizard")).toBeTruthy();
});
