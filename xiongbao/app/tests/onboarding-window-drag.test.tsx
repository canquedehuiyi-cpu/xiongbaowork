import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";

/**
 * Outside a shell that marks drag regions (a browser, the device app), onboarding's frame carries
 * no `data-tauri-drag-region`, so nothing on the page moves a window.
 */
const DRAG = "data-tauri-drag-region";

beforeAll(() => GlobalRegistrator.register({ width: 1000, height: 800 }));
afterEach(() => cleanup());
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

test("in a browser nothing on onboarding's frame drags", () => {
  const view = render(
    <OnboardingFrame
      demo={<p>The step's picture.</p>}
      index={1}
      intro={<h1>Connect your apps</h1>}
      onBack={() => {}}
      onPick={() => {}}
      primary={{ label: "Continue", onClick: () => {} }}
      reached={1}
      titles={["Welcome", "Connect your apps", "Talk to us"]}
    />,
  );
  expect(view.container.querySelectorAll(`[${DRAG}]`)).toHaveLength(0);
});
