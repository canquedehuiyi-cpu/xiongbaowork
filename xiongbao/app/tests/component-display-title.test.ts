import { expect, test } from "bun:test";
import { componentDisplayTitle } from "@/lib/components/display-title";
import { GALLERY_COMPONENTS } from "@/lib/copilot/gallery-registry";

/**
 * The name a person reads, which is not the registry title.
 *
 * The registry title is what the server's headless registry and the model know a component by, so
 * it stays as it is; screens draw this instead. Two things have to hold for that to be safe: every
 * component this build ships has a name a person can read, and one it has never heard of — a
 * playground component, or one a later build adds — still shows the title it came with.
 */
test("every component this build ships is listed under a Chinese name", () => {
  for (const component of GALLERY_COMPONENTS) {
    const shown = componentDisplayTitle(component);
    expect(shown).not.toBe(component.title);
    expect(shown).toMatch(/[一-鿿]/);
  }
});

test("a component the map has never heard of keeps the title it came with", () => {
  expect(
    componentDisplayTitle({ name: "refund_card", title: "Refund card" }),
  ).toBe("Refund card");
});
