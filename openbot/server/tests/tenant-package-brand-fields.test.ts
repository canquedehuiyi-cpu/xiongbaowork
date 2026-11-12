import { describe, expect, test } from "bun:test";
import {
  createApplicationConfiguration,
  validateTenantPackage,
} from "../src/tenant-package";

function packageWith(tenantYaml: string) {
  return validateTenantPackage({
    brand: tenantYaml,
    agents: "agents: []",
    channels: "channels: []",
    model:
      "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
    knowledge: "sources: []",
    themeCss: "",
  });
}

describe("tenant package brand fields", () => {
  test("company_name and support_url are optional", () => {
    const loaded = packageWith("tenant: { id: openbot, product_name: P }");
    expect(loaded.companyName).toBeUndefined();
    expect(loaded.supportUrl).toBeUndefined();
  });

  test("parses company_name and an https support_url", () => {
    const loaded = packageWith(
      "tenant: { id: openbot, product_name: P, company_name: 熊宝, support_url: 'https://help.example.com/x' }",
    );
    expect(loaded.companyName).toBe("熊宝");
    expect(loaded.supportUrl).toBe("https://help.example.com/x");
  });

  test("trims whitespace around an https support_url", () => {
    const loaded = packageWith(
      "tenant: { id: openbot, product_name: P, support_url: '  https://help.example.com/x  ' }",
    );
    expect(loaded.supportUrl).toBe("https://help.example.com/x");
  });

  test("rejects a non-https support_url naming the field", () => {
    expect(() =>
      packageWith(
        "tenant: { id: openbot, product_name: P, support_url: 'http://x' }",
      ),
    ).toThrow(/support_url/);
    expect(() =>
      packageWith(
        "tenant: { id: openbot, product_name: P, support_url: 'javascript:alert(1)' }",
      ),
    ).toThrow(/support_url/);
  });

  test("createApplicationConfiguration carries both fields to the browser", () => {
    const configuration = createApplicationConfiguration(
      packageWith(
        "tenant: { id: openbot, product_name: P, company_name: 熊宝, support_url: 'https://help.example.com' }",
      ),
    );
    expect(configuration).toEqual({
      brand: {
        tenantId: "openbot",
        productName: "P",
        companyName: "熊宝",
        supportUrl: "https://help.example.com",
      },
    });
  });
});
