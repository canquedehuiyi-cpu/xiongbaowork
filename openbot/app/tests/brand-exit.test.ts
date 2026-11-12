import { expect, test } from "bun:test";
import {
  companyName,
  englishName,
  productName,
  shortName,
  supportUrl,
} from "@/lib/brand";

/*
 * The web copy's one exit for the product's names. The delivered package's values come through;
 * the fallbacks matter for a package that leaves a name out, so each is checked against a brand
 * given explicitly rather than the generated one.
 */

test("the delivered package's names come through", () => {
  expect(productName()).toBe("熊宝数字员工");
  expect(shortName()).toBe("熊宝");
  expect(englishName()).toBe("XiongBao Work");
  expect(companyName()).toBe("熊宝");
  expect(supportUrl()).toBeUndefined();
});

test("a package that leaves names out falls back to its own product name", () => {
  const brand = { tenantId: "fintech", productName: "Ledgerline" };
  expect(productName(brand)).toBe("Ledgerline");
  expect(shortName(brand)).toBe("Ledgerline");
  expect(companyName(brand)).toBe("Ledgerline");
  expect(supportUrl(brand)).toBeUndefined();
});

test("the English name falls back to the default English name", () => {
  expect(englishName({ tenantId: "fintech", productName: "Ledgerline" })).toBe(
    "XiongBao Work",
  );
});

test("names a package gives win over the fallbacks", () => {
  const brand = {
    tenantId: "fintech",
    productName: "Ledgerline",
    shortName: "Ledger",
    englishName: "Ledgerline EN",
    companyName: "Ledger Inc",
    supportUrl: "https://help.example.com",
  };
  expect(shortName(brand)).toBe("Ledger");
  expect(englishName(brand)).toBe("Ledgerline EN");
  expect(companyName(brand)).toBe("Ledger Inc");
  expect(supportUrl(brand)).toBe("https://help.example.com");
});
