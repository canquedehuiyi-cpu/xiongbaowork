/**
 * Loaded before any test file, so a component that portals can be rendered at all.
 *
 * Base UI decides ONCE, while its module is first evaluated, whether its isomorphic layout effect
 * is `useLayoutEffect` or a no-op:
 *
 *     export const useIsoLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : noop;
 *
 * Every DOM test here registers happy-dom in its own `beforeAll`, which is far too late: bun walks
 * all the test files into one process, so whichever of them imports a route first pulls Base UI in
 * while `document` is still undefined, and the no-op is what every later file gets. A portal needs
 * that effect to resolve its container — so `Dialog` mounts nothing, forever, and a test that opens
 * one is left asserting against an empty `<body>` with no error to explain it.
 *
 * Worse, it decided that by import order. The same test passed on its own and failed in the suite,
 * which is the failure `test-preload.ts` exists to stop in the other direction.
 *
 * React DOM's client makes the same kind of once-only decision. While it is first evaluated it asks
 * whether there is a DOM at all and whether it supports the `input` event; when there is none, every
 * text field and textarea falls back to React's old IE polyfill, which notices a new value only on
 * focus and key events. Then `onChange` never fires for an `input` or `change` event sent straight at
 * the element (`fireEvent.change`, a paste), and a controlled field keeps its old state while the DOM
 * shows the new value. A test file imports `@testing-library/react` (and with it `react-dom/client`)
 * before its own `beforeAll` registers happy-dom, so the client is evaluated here as well.
 *
 * The client also keeps the `setTimeout` and `queueMicrotask` it finds while it is evaluated, and
 * React flushes its synchronous work through that `queueMicrotask`. happy-dom's own versions stop
 * running anything once this window is closed below, so the client is handed Bun's (the ones it
 * would have kept had it been evaluated without a DOM) and only the DOM checks see happy-dom.
 *
 * So the DOM is registered here, those modules are evaluated against it, and the DOM is taken away
 * again. Nothing else is left holding browser globals: server and worker tests run exactly as
 * before, and each DOM test file still registers and unregisters its own happy-dom.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";

const runtimeTimers = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  queueMicrotask: globalThis.queueMicrotask,
};

GlobalRegistrator.register();
/* `@base-ui/utils` is not a dependency of this package; the react package that owns it is. */
await import("@base-ui/react/dialog");
Object.assign(globalThis, runtimeTimers);
await import("react-dom/client");
GlobalRegistrator.unregister();
