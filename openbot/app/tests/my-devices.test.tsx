import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MyDevices } from "@/components/settings/my-devices";
import { deviceKeys, type RegisteredDevice } from "@/lib/devices/queries";

/**
 * Ticket 016 acceptance, at the screen where a person actually decides it: pairing a machine has to
 * give them something they can type, and a list has to say which machines are here now.
 *
 * The device rows are seeded rather than fetched, because the two things worth asserting are the write
 * the button makes and the command the answer turns into.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
const calls: { method: string; path: string }[] = [];

const studio: RegisteredDevice = {
  id: "device-1",
  deviceId: "studio-1",
  name: "Studio desktop",
  platform: "win32",
  lastSeenAt: new Date().toISOString(),
  online: true,
};

const laptop: RegisteredDevice = {
  ...studio,
  id: "device-2",
  deviceId: "laptop-2",
  name: "Travel laptop",
  lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  online: false,
};

function draw(devices: RegisteredDevice[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(deviceKeys.list(), devices);

  globalThis.fetch = (async (
    path: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = String(path);
    calls.push({ method: init?.method ?? "GET", path: url });
    if (url.includes("/pair")) {
      return new Response(
        JSON.stringify({
          code: "K7M2QP4R",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }),
        { status: 201 },
      );
    }
    return new Response(JSON.stringify({ devices }), { status: 200 });
  }) as typeof fetch;

  return {
    view: render(
      <QueryClientProvider client={queryClient}>
        <MyDevices />
      </QueryClientProvider>,
    ),
  };
}

test("the list says which machines are here now", async () => {
  const { view } = draw([studio, laptop]);

  expect(await view.findByText("Studio desktop")).toBeTruthy();
  expect(view.getByText("在线")).toBeTruthy();
  // An absent machine is said to be absent, with the last moment it was seen — not left blank.
  expect(view.getByText(/最后在线 /)).toBeTruthy();
});

test("pairing mints a code and hands the person the command to type", async () => {
  const { view } = draw([]);

  await userEvent
    .setup({ document: view.baseElement.ownerDocument })
    .click(await view.findByRole("button", { name: /配对一台设备/ }));

  await waitFor(() =>
    expect(calls.some((c) => c.path.includes("/api/devices/pair"))).toBeTrue(),
  );
  const code = await view.findByText(/K7M2QP4R/);
  // The command, not just the code: a person standing at the machine has nothing else to copy from.
  expect(code.textContent).toContain("--server");
  expect(code.textContent).toContain("--pair K7M2QP4R");
});

test("removing a device is a delete against that device alone", async () => {
  const { view } = draw([studio, laptop]);

  await userEvent
    .setup({ document: view.baseElement.ownerDocument })
    .click(await view.findByRole("button", { name: "移除 Travel laptop" }));

  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.method === "DELETE" && c.path.endsWith("/api/devices/device-2"),
      ),
    ).toBeTrue(),
  );
});

test("a refusal from the server is said on the screen in its own words", async () => {
  const { view } = draw([]);
  globalThis.fetch = (async (
    _path: Parameters<typeof fetch>[0],
    _init?: Parameters<typeof fetch>[1],
  ) =>
    new Response(
      JSON.stringify({ error: "This deployment has pairing switched off." }),
      { status: 403 },
    )) as typeof fetch;

  await userEvent
    .setup({ document: view.baseElement.ownerDocument })
    .click(await view.findByRole("button", { name: /配对一台设备/ }));

  // The server's sentence rather than a generic one: "pairing is switched off" is the answer, and a
  // fallback would send the person looking for a bug that is not there.
  expect(await view.findByText(/pairing switched off/i)).toBeTruthy();
});

test("reviewing an uncertain action requires a note and an explicit check before saving", async () => {
  const { view } = draw([{ ...studio, uncertain: 1 }]);
  const action = {
    key: "lost-ack",
    action: "files.write",
    payload: { path: "proof.txt", append: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    review: null,
  };
  let saved: Record<string, unknown> | undefined;
  globalThis.fetch = (async (path, init) => {
    const url = String(path);
    if (init?.method === "POST") {
      saved = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ ok: true, uncertain: 0, paused: false }),
      );
    }
    return new Response(
      JSON.stringify(
        url.endsWith("/actions")
          ? { actions: [action] }
          : { devices: [{ ...studio, uncertain: saved ? 0 : 1 }] },
      ),
    );
  }) as typeof fetch;
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(await view.findByRole("button", { name: "核查并恢复" }));
  expect(await view.findByText(/proof.txt/)).toBeTruthy();
  const submit = (await view.findByRole("button", {
    name: "保存核查结果",
  })) as HTMLButtonElement;
  expect(submit.disabled).toBeTrue();
  await user.type(
    view.getByRole("textbox", { name: "核查说明" }),
    "I checked the file and stopped the related command.",
  );
  expect(submit.disabled).toBeTrue();
  expect(saved).toBeUndefined();
  await user.click(view.getByRole("checkbox", { name: /我已在设备上核查/ }));
  expect(submit.disabled).toBeFalse();
  await user.click(submit);
  await waitFor(() =>
    expect(saved).toMatchObject({
      key: "lost-ack",
      confirmedChecked: true,
      resolution: "checked_executed",
    }),
  );
  expect(
    await view.findByText("核查已保存，后续动作可以继续；原动作不会重放。"),
  ).toBeTruthy();
});

test("a rejected review keeps the paused receipt visible and displays the server error", async () => {
  const { view } = draw([{ ...studio, uncertain: 1 }]);
  globalThis.fetch = (async (_path, init) =>
    new Response(
      JSON.stringify(
        init?.method === "POST"
          ? {
              error: "This action is not awaiting review. Refresh its receipt.",
            }
          : {
              actions: [
                {
                  key: "lost",
                  action: "exec",
                  payload: { command: "echo marker" },
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  review: null,
                },
              ],
            },
      ),
      { status: init?.method === "POST" ? 409 : 200 },
    )) as typeof fetch;
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(await view.findByRole("button", { name: "核查并恢复" }));
  await user.type(
    await view.findByRole("textbox", { name: "核查说明" }),
    "Checked command status.",
  );
  await user.click(view.getByRole("checkbox", { name: /我已在设备上核查/ }));
  await user.click(view.getByRole("button", { name: "保存核查结果" }));
  expect(await view.findByRole("alert")).toBeTruthy();
  expect(view.getByText(/Refresh its receipt/)).toBeTruthy();
  expect(view.getByText(/项结果不明，已暂停/)).toBeTruthy();
});
