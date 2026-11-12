import { afterEach, describe, expect, test } from "bun:test";
import {
  companyName,
  copyrightLine,
  englishName,
  productName,
  resetBrand,
  setBrand,
  supportUrl,
} from "../src/brand";

// setBrand writes module state; reset so test order cannot leak a name into the defaults test.
afterEach(() => resetBrand());

describe("brand", () => {
  test("defaults apply when setBrand was never called", () => {
    expect(productName()).toBe("熊宝数字员工");
    expect(englishName()).toBe("XiongBao Work");
    expect(companyName()).toBe("熊宝数字员工");
    expect(supportUrl()).toBeUndefined();
  });

  test("setBrand replaces every value", () => {
    setBrand({
      productName: "Ledgerline",
      englishName: "Ledgerline EN",
      companyName: "Ledger Inc",
      supportUrl: "https://help.example.com",
    });
    expect(productName()).toBe("Ledgerline");
    expect(englishName()).toBe("Ledgerline EN");
    expect(companyName()).toBe("Ledger Inc");
    expect(supportUrl()).toBe("https://help.example.com");
  });

  test("companyName falls back to the product name, englishName to the default", () => {
    setBrand({ productName: "Ledgerline" });
    expect(companyName()).toBe("Ledgerline");
    expect(englishName()).toBe("XiongBao Work");
  });

  test("copyrightLine keeps the upstream MIT notice", () => {
    expect(copyrightLine()).toBe(
      "Copyright (c) 2026 熊宝数字员工; portions Copyright (c) 2026 CopilotKit (MIT)",
    );
    setBrand({ productName: "P", companyName: "熊宝" });
    expect(copyrightLine(2030)).toBe(
      "Copyright (c) 2030 熊宝; portions Copyright (c) 2026 CopilotKit (MIT)",
    );
  });
});
