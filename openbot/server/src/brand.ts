// The one place server copy gets the product's name from. The tenant package is loaded once at
// startup and handed to setBrand; everything else calls these accessors so a different package
// renames the product without touching code.
type BrandInput = {
  productName: string;
  englishName?: string;
  companyName?: string;
  supportUrl?: string;
};

const DEFAULT_PRODUCT_NAME = "熊宝数字员工";
const DEFAULT_ENGLISH_NAME = "XiongBao Work";

// Defaults rather than "unset" so unit tests and scripts that never load a package still get copy.
let current: BrandInput = { productName: DEFAULT_PRODUCT_NAME };

export function setBrand(input: BrandInput): void {
  current = { ...input };
}

/** Test-only: puts the defaults back so one test's brand cannot leak into the next. */
export function resetBrand(): void {
  current = { productName: DEFAULT_PRODUCT_NAME };
}

export function productName(): string {
  return current.productName;
}

export function englishName(): string {
  return current.englishName ?? DEFAULT_ENGLISH_NAME;
}

export function companyName(): string {
  return current.companyName ?? current.productName;
}

export function supportUrl(): string | undefined {
  return current.supportUrl;
}

// The upstream CopilotKit line stays fixed: its MIT licence requires the notice to be kept.
export function copyrightLine(year = 2026): string {
  return `Copyright (c) ${year} ${companyName()}; portions Copyright (c) 2026 CopilotKit (MIT)`;
}
