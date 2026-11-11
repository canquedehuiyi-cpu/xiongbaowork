import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  SharedApprovalFields,
  sharedSectionSentence,
} from "../src/components/plugins/shared-approval-fields";
import type { SharedUseApproval } from "../src/lib/plugins/shared-use";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

describe("sharedSectionSentence", () => {
  test("says what a shared write and a shared read let people do", () => {
    expect(sharedSectionSentence("write", true)).toBe(
      "能用这位员工的人，都能以团队账号的身份做这些。",
    );
    expect(sharedSectionSentence("read", true)).toBe(
      "能用这位员工的人，都能读到这个账号读得到的东西。",
    );
    expect(sharedSectionSentence("write", false)).toBeNull();
  });
});

describe("SharedApprovalFields", () => {
  test("starts at the Bot's exposure and can be narrowed to its owner", async () => {
    let seen = null as SharedUseApproval | null;
    function Harness() {
      const [value, setValue] = useState<SharedUseApproval>({
        audience: "team",
        outsideInput: true,
        members: [],
      });
      seen = value;
      return <SharedApprovalFields onChange={setValue} value={value} />;
    }
    const view = render(<Harness />);
    expect(
      (view.getByRole("radio", { name: "所有人" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    await userEvent.click(view.getByRole("radio", { name: "只有它的主人" }));
    await userEvent.click(
      view.getByRole("checkbox", {
        name: "外部来的消息（邮件、Slack、Webhook）也可以用它",
      }),
    );
    expect(seen).toEqual({
      audience: "owner",
      outsideInput: false,
      members: [],
    });
  });

  test("offers named people only when the Bot is published to named people", () => {
    const view = render(
      <SharedApprovalFields
        onChange={() => {}}
        value={{ audience: "owner", outsideInput: false, members: [] }}
      />,
    );
    expect(view.queryByRole("radio", { name: /named/i })).toBeNull();
  });
});
